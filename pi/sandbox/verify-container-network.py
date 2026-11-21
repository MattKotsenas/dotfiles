#!/usr/bin/env python3
"""Verify the native nested-Docker path in a disposable, managed sandbox.

Run on the host with the controller's normal prerequisites. Downloads use GET;
the write probe runs only after the broker's external network is disconnected.
"""
import argparse
import fcntl
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import uuid

IMAGE = "hugomods/hugo@sha256:879cf9ff9c411cf9a2904d466bedcac1f26a8c09fcdb663ca90dcf94a47f49cb"
PROXY_KEYS = {"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"}
POST_PROBE = b"""package main
import ("fmt"; "net/http"; "os"; "strings"; "time")
func main() {
    client := http.Client{Timeout: 10*time.Second}
    response, err := client.Post("https://proxy.golang.org/pi-denied-probe",
        "text/plain", strings.NewReader("probe"))
    if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
    defer response.Body.Close()
    fmt.Println(response.StatusCode)
    if response.StatusCode != 403 { os.Exit(1) }
    other, err := client.Get("https://storage.googleapis.com/pi-denied-probe")
    if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
    defer other.Body.Close()
    fmt.Println(other.StatusCode)
    if other.StatusCode != 403 { os.Exit(1) }
}
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = Path(__file__).resolve().parent
    parser.add_argument("--controller", type=Path, default=source / "pi-sandboxctl")
    parser.add_argument("--runtime", type=Path, default=source / "pi-container-runc")
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/pi-sandbox/config.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    settings = json.loads(args.config.read_text())
    require(settings["profiles"]["downloads"].get("container_proxy"),
            "The downloads profile must enable container_proxy")
    controller = runpy.run_path(str(args.controller))
    controller["create"].__globals__["CONTAINER_RUNTIME"] = args.runtime.resolve()
    controller["STATE"].mkdir(mode=0o700, exist_ok=True)
    output = args.output or Path(tempfile.mkdtemp(prefix="pi-container-network-check-"))
    output.mkdir(parents=True, exist_ok=True)
    session = "container-network-check-" + uuid.uuid4().hex[:12]
    sid = controller["managed_name"](session)
    box, broker, _ = controller["names"](sid)
    created = False

    def invoke(*arguments, input=None, timeout=120, check=True):
        result = subprocess.run([*controller["DOCKER"], *arguments], input=input,
                                capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError((result.stdout + result.stderr).decode())
        return result

    def guest(command, timeout=120, check=True):
        return invoke("exec", box, "sh", "-ec", command, timeout=timeout, check=check)

    try:
        with (controller["STATE"] / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            controller["create"](session, settings["default"]["workspace"], "downloads", settings)
            created = True
        guest("docker pull --quiet " + IMAGE)
        base_env = json.loads(guest("docker image inspect " + IMAGE +
                                   " --format '{{json .Config.Env}}'").stdout)
        require(not any(entry.partition("=")[0] in PROXY_KEYS for entry in base_env),
                "Precondition: fixture image must not provide proxy variables")
        print("PASS: pinned fixture image pulled without proxy defaults", flush=True)
        guest("docker run -d --name network-fixture --entrypoint sh " + IMAGE + " -c 'sleep 300'")
        observed = guest("docker exec network-fixture sh -c 'printf %s \"$HTTPS_PROXY\"'").stdout.decode()
        policy = json.loads(guest("cat /etc/pi-container-network.json").stdout)
        require(observed == policy["proxy"], "docker exec did not receive the broker proxy")
        guest("docker exec -e GOMODCACHE=/tmp/verified-modules network-fixture "
              "go mod download -json github.com/KKKZOZ/hugo-admonitions@v0.12.0")
        print("PASS: ordinary container and docker exec downloaded a real module", flush=True)
        status = guest("docker run --rm --entrypoint sh " + IMAGE + " -c 'exit 17'", check=False)
        require(status.returncode == 17, "Native container exit status was not preserved")
        guest("docker run --rm --read-only --entrypoint sh " + IMAGE +
              " -c 'test -n \"$HTTPS_PROXY\" && test -r /etc/ssl/certs/ca-certificates.crt'")
        print("PASS: native exit status and read-only-root startup", flush=True)

        guest("mkdir -p /tmp/context; printf '%s\\n' 'FROM " + IMAGE +
              "' 'RUN GOMODCACHE=/tmp/verified-modules go mod download -json "
              "github.com/nunocoracao/blowfish/v2@v2.97.0' >/tmp/context/Dockerfile")
        guest("docker build --no-cache -t network-built /tmp/context")
        print("PASS: Dockerfile RUN downloaded a real module", flush=True)
        built_env = json.loads(guest("docker image inspect network-built "
                                    "--format '{{json .Config.Env}}'").stdout)
        require(not any(entry.partition("=")[0] in PROXY_KEYS for entry in built_env),
                "Runtime proxy defaults persisted in built image configuration")
        guest("docker create --name built-export network-built; "
              "docker export -o /tmp/built-rootfs.tar built-export; "
              "docker export -o /tmp/rootfs.tar network-fixture")
        guest("""python3 - <<'PY'
import subprocess
import tarfile
from pathlib import Path

broker = Path('/etc/pi-broker-ca.crt').read_bytes()
with tarfile.open('/tmp/rootfs.tar') as archive:
    original = archive.extractfile('etc/ssl/certs/ca-certificates.crt').read()
assert broker not in original, 'Base image filesystem contains broker CA'
active = subprocess.run(
    ['docker', 'exec', 'network-fixture', 'cat', '/etc/ssl/certs/ca-certificates.crt'],
    capture_output=True, check=True).stdout
assert active.startswith(original) and broker in active, 'Image trust was not preserved'
with tarfile.open('/tmp/built-rootfs.tar') as archive:
    built = archive.extractfile('etc/ssl/certs/ca-certificates.crt').read()
assert broker not in built, 'Built image filesystem contains broker CA'
Path('/tmp/original.pem').write_bytes(original)
PY""")
        print("PASS: original trust retained; proxy defaults and broker CA absent from built image", flush=True)

        guest("docker cp /tmp/original.pem network-fixture:/tmp/original.pem")
        untrusted = guest(
            "docker exec -e SSL_CERT_FILE=/tmp/original.pem -e SSL_CERT_DIR=/tmp/empty-certs "
            "-e GOMODCACHE=/tmp/untrusted-cache -e GOPROXY=https://proxy.golang.org network-fixture "
            "go mod download -json github.com/KKKZOZ/hugo-admonitions@v0.12.0", check=False)
        require(untrusted.returncode != 0 and b"certificate" in untrusted.stdout + untrusted.stderr,
                "Removing broker trust did not produce a TLS verification failure")
        print("PASS: removing broker trust causes genuine TLS verification failure", flush=True)
        invoke("exec", "-i", box, "sh", "-ec", "tee /tmp/post.go >/dev/null", input=POST_PROBE)
        guest("docker cp /tmp/post.go network-fixture:/tmp/post.go; "
              "docker exec -e GO111MODULE=off network-fixture go build -o /tmp/post /tmp/post.go")
        # No externally visible mutation is possible during the write probe.
        invoke("network", "disconnect", "bridge", broker)
        rejected = guest("docker exec network-fixture /tmp/post")
        require(rejected.stdout.split() == [b"403", b"403"],
                "Container write or unrelated storage read was not rejected with HTTP 403")
        logs = invoke("logs", broker)
        events = []
        for line in (logs.stdout + logs.stderr).decode().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        require(any(event.get("rejected_by") == "allowlist"
                    and event.get("audit", {}).get("method") == "POST" for event in events),
                "Broker audit does not establish allowlist rejection")
        require(any(event.get("rejected_by") == "allowlist"
                    and event.get("audit", {}).get("method") == "GET"
                    and event.get("audit", {}).get("host") == "storage.googleapis.com"
                    for event in events), "Broker audit does not establish storage path rejection")
        (output / "broker-audit.json").write_text(json.dumps(events, indent=2))
        runtime = guest("cat /var/log/pi-container-network.jsonl").stdout
        (output / "runtime-audit.jsonl").write_bytes(runtime)
        operations = {json.loads(line)["operation"] for line in runtime.splitlines()}
        require({"create", "run", "exec"} <= operations, "Runtime audit misses an exercised OCI operation")
        print(f"PASS: write and unrelated storage read rejected; evidence saved to {output}", flush=True)
    finally:
        if created:
            with (controller["STATE"] / ".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                controller["remove"](sid)
            print("Disposable sandbox removed.", flush=True)


if __name__ == "__main__":
    main()
