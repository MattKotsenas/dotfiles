# Pi sandboxes on Linux

## Install

Use a Linux host with Pi 1.5.2, Python 3, OpenSSL, `findmnt`, Docker with the
`sysbox-runc` runtime, and an ext4 data disk mounted at `/data`. The controller
uses `sudo -n /usr/bin/docker` on the host. It does not pass that socket or
sudo access into the workspace. New sandboxes use the pinned amd64 Dev
Containers Universal 6.1 image, with Ubuntu, common language runtimes, and
an inner Docker daemon. Budget about 15 GiB for the image cache. With Docker's
containerd image store, that space is used under containerd's root, which is
configured separately from Docker's `data-root`.

From the dotfiles repository, copy the files into place. If a destination
already exists, back it up and merge your settings before replacing it.

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.pi/agent/extensions" /data/dev/sandbox-managed
install -d -m 0700 "$HOME/.config/pi-sandbox"
install -m 0700 pi/sandbox/pi-sandboxctl "$HOME/.local/bin/pi-sandboxctl"
sudo install -D -m0755 pi/sandbox/pi-container-runc /usr/local/lib/pi-sandbox/pi-container-runc
install -m 0700 pi/sandbox/github-token "$HOME/.config/pi-sandbox/github-token"
install -m 0600 pi/sandbox/config.example.json "$HOME/.config/pi-sandbox/config.json"
install -m 0644 pi/sandbox/OPERATIONS.md "$HOME/.config/pi-sandbox/OPERATIONS.md"
install -m 0644 pi/sandbox/sandbox.ts "$HOME/.pi/agent/extensions/sandbox.ts"
install -d "$HOME/.pi/agent/extensions/shared"
install -m 0644 pi/agent/extensions/shared/usage.ts "$HOME/.pi/agent/extensions/shared/usage.ts"
cp -R pi/agent/extensions/delegation "$HOME/.pi/agent/extensions/"
sudo -n docker pull mcr.microsoft.com/devcontainers/universal@sha256:d247757d344fecd9a77467767e64a1479367047b74ad82453c08ff17a13ff7ec
```

Install the Python 3 runtime launcher above before creating a profile with
`container_proxy: true`. The controller bind-mounts it read-only at
`/usr/local/bin/runc` inside the managed outer container. The native image
pins remain unchanged.

Existing containers keep their original image. To move an existing sandbox
to Universal, destroy and recreate it. The checkout survives; files and
nested images stored only inside the old sandbox do not.

For broker-backed profiles (`github-git`, `downloads`, and
`development-read`), pull the broker image:

```sh
sudo -n docker pull docker@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac
```

Then install [iron-proxy v0.58.0](https://github.com/ironsh/iron-proxy/releases/tag/v0.58.0)
at `/usr/local/lib/pi-sandbox/iron-proxy`. On Linux amd64, verify the release
archive before extracting:

```sh
printf '%s  %s\n' \
  18ce507883d1834308345db6a2103ba795a53cdfefc9ab243d638d477c15429d \
  iron-proxy_0.58.0_linux_amd64.tar.gz | sha256sum -c -
tar -xzf iron-proxy_0.58.0_linux_amd64.tar.gz
sudo install -D -m 0755 iron-proxy /usr/local/lib/pi-sandbox/iron-proxy
```

For profiles with GitHub credentials (`github-git` and `development-read`),
install a `gh` version that supports `--expiring` at `~/.local/bin/gh` and
sign in on the host with `gh auth login --hostname github.com --expiring`.
For an existing login, use `gh auth refresh --hostname github.com --expiring`.
The `offline` profile needs neither iron-proxy nor GitHub credentials;
`downloads` needs iron-proxy but no GitHub credentials.

Merge these entries into `~/.pi/agent/settings.json`, keeping your other
settings:

```json
{
  "defaultTools": ["+codemode", "+sandbox_manage"],
  "codemode": { "mode": "only" }
}
```

If you use Powerline, its custom status key is `sandbox`. Add
`{"id":"sandbox","selfColorize":true}` to `powerline.customItems` and put
`"custom:sandbox"` in your footer layout.

## Use

See the [operator runbook](OPERATIONS.md) for lifecycle calls, workspace
approval, and host diagnostics.

Start `pi` normally. It starts in **SANDBOX ONLY**, including after
`/reload`. Sandbox shell and file tools stay available in both modes. The
first such call runs in `/workspace`, creating or restarting the sandbox
if needed. A missing sandbox uses the default in
`~/.config/pi-sandbox/config.json`: `sandbox-managed` with `offline`. For a
different approved workspace or profile, explicitly create the sandbox
before using its tools. The host working directory is never mounted
automatically.

Only the user can use `/sandbox off` to add host tools or `/sandbox on` to
block them. Unprefixed tools such as `bash` and `read` target the host;
`sandbox_shell` and `sandbox_read` always target the container. Neither
command changes the workspace, profile, or container state. Use
`/sandbox status` to check host access and `sandbox_manage` to inspect
the container.

Pi can manage its session's sandbox in either mode. The next sandbox tool call
restarts a stopped sandbox with its existing profile or replaces a destroyed
sandbox with the default. Destruction preserves the checkout under `/data/dev`.
Failed startup returns an error with no host fallback.

## Threat model

We trust the agent and every Pi extension we load, regardless of where the
extension runs. The sandbox guards against **confused-deputy mistakes**,
such as running a project command with host privileges, and **untrusted
project dependencies**, such as an npm install script that tries to read host
secrets or reach arbitrary network destinations. Run project commands in
SANDBOX mode.

Treat a malicious extension as a compromised agent. A host extension can use
host filesystem and process APIs directly. An extension running inside the
sandbox can still steer the agent, alter the mounted checkout, and use the
profile's network permissions. The sandbox does not promise to contain a
malicious agent or withstand a host escape.

Pi and its model credentials stay on the host. The sandbox sees the approved
workspace as a writable mount and has its own Docker daemon. It does not get
the host home directory or Docker socket. It gets separate read-only mounts
for the [guidance paths](OPERATIONS.md#start-work-or-change-profiles).
Dependencies can read the guidance, alter the mounted checkout, and exercise
the network permissions of the profile.

**A child gets no more tool authority than its parent.** Child-session runners
can ask for the parent's current execution policy. The delegation extension
uses it to forward only allowed tool calls through the parent. The same
sandbox, workspace, and credential profile apply to both agents. A child
cannot manage the sandbox or switch modes. The user's mode change applies to
the next child turn, including follow-ups to the same handle. In-flight turns
finish or are cancelled before the mode changes. Failed sandbox calls never
fall back to the host.

The controller mounts only an approved directory directly under `/data/dev`
as `/workspace`. The directory must be on the `/data` filesystem. The controller
refuses symlinked workspaces, separate mounts, and host submounts at creation
or restart. Keep host mounts out of the workspace while its sandbox is running. Bind mounts requested
through the sandbox's Docker daemon use sandbox paths: mounting `/` there
mounts the sandbox's root filesystem.

## Profiles and credentials

[`config.example.json`](config.example.json) is the starting point for approved
workspaces, profiles, and provider commands. `offline` has no broker. `github-git` allows HTTPS Git
traffic to `github.com`; it is configured for fetch and push, with the API
and Gists outside the profile.

`downloads` and `development-read` enable `container_proxy: true`, which
requires `proxy: true`. Alongside their NuGet and Docker rules, both permit
read-only Go downloads from `proxy.golang.org` and `sum.golang.org`. For
`storage.googleapis.com`, they permit `CONNECT`, with decrypted `GET` and
`HEAD` requests restricted to `/proxy-golang-org-prod/*`. `development-read` retains its GitHub API read and Git fetch
permissions; its Git and API write guards remain in force. `github-git`
retains its separate fetch/push policy. The default remains `offline`.
Profile changes require container recreation; see the
[runbook](OPERATIONS.md#start-work-or-change-profiles) before discarding
inner Docker caches.

A provider is a host-side command that emits one secret. The broker uses a
snapshot; the guest gets a placeholder. The GitHub provider uses an expiring
`gh` access token. Its refresh credential stays with `gh`, and the access
token's lifetime limits the exposure if the token leaks. Ask Pi to refresh
the sandbox credentials explicitly when needed. Refresh keeps the existing
profile and requires neither a sandbox restart nor a mode change.

## Networking across container layers

With `container_proxy` enabled, ordinary inner containers, `docker exec`
processes, and Dockerfile `RUN` steps can use the profile's permitted HTTPS
downloads without application Dockerfile or Aspire settings.

```text
Host: Pi + controller
  ├─ Egress broker: permissions, public CA, private key, credential snapshot
  └─ Managed outer Sysbox container
       proxy environment + public CA + inner Docker daemon
       /usr/local/bin/runc → pi-container-runc → /usr/bin/runc
         ├─ BuildKit Dockerfile RUN processes
         └─ Application containers and docker exec processes
```

The outer container's environment and trust store do not automatically enter
an image's root filesystem or its OCI process environment. BuildKit also
creates separate execution environments for build steps. Configuring only
the outer shell or Docker daemon leaves those processes without proxy
connectivity or broker trust. The launcher supplies these at the OCI launch
boundary so projects can keep their native image definitions.

### Launch-time defaults and trust

`pi-container-runc` intercepts `create` and `run` bundle `config.json`
files, and `exec` calls that supply a `--process` file. It then uses
`os.execv` to replace itself with the original `/usr/bin/runc`, preserving
native PID, signal, stdio, and exit behavior. Commands such as `features`
and `delete` pass through. Direct low-level `exec` without a process file
is unchanged.

For each of the HTTP proxy, HTTPS proxy, and bypass variable groups, the
launcher adds both uppercase and lowercase names only if neither spelling
is present. An explicit value in either spelling, including an empty value,
prevents defaults for that group. It supplies `HTTP_PROXY`, `HTTPS_PROXY`,
and `NO_PROXY` and their lowercase forms from policy; it does not copy the
parent environment or tokens. The proxy URL uses the broker's concrete
internal IPv4 address because nested DNS cannot resolve the broker name.

For `create` and `run`, the launcher merges the broker's public CA into
the image's existing standard Linux PEM bundles. It recognizes
`/etc/ssl/certs/ca-certificates.crt`, `/etc/ssl/cert.pem`,
`/etc/pki/tls/certs/ca-bundle.crt`, and
`/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`. Image symlinks resolve
within the image root. If none exists, it uses
`/etc/ssl/certs/ca-certificates.crt`.

The merged files are staged in the OCI bundle and bind-mounted read-only
at the effective CA paths. The image's original trust is preserved and its
layers are unchanged; the runtime bundle owns the temporary files'
lifecycle. A caller mount that overlaps an effective CA destination fails
with a clear error so the launcher does not silently discard caller trust.
Commands that rewrite these bundle files, including trust-store updaters,
are not supported while the injected mounts are active. Java and custom
trust stores have no general automatic support.

This mechanism does not add proxy defaults to image configuration or CA
contents to image layers. A workload that explicitly copies the mounted
public bundle into its output can still persist that certificate.

### Permissions and verification limits

The launcher supplies connectivity and trust. External permissions remain
the responsibility of the egress broker and network controls; launch-time
injection provides no universal containment guarantee.

The outer container's `/etc/pi-container-network.json` contains only the
proxy endpoint, bypass list, and public CA path. The private key and real
credential snapshot stay with the broker outside the outer container.
The [runbook](OPERATIONS.md#diagnose-nested-container-networking) describes
runtime audit records and network-layer diagnostics.

Isolated native probes on the pinned Universal guest used inner Docker
`29.9.3-1`, runc `1.5.2-16`, and embedded BuildKit `0.34.2`. Ordinary
containers and `docker exec` downloaded the actual Hugo-admonitions Go
module, and a Dockerfile `RUN` downloaded the Blowfish module. Exported
root filesystems retained the original CA bundle without the broker CA;
built image configuration contained no injected proxy defaults, and exported
built layers contained no broker CA. Removing the broker CA and using a
fresh Go TLS store produced an unknown-authority failure. After disconnecting
the bridge's external connectivity, the broker rejected both a POST and a
GET outside the module-proxy storage bucket with HTTP 403. The probes cleaned up their disposable state.

These observations cover that native runtime path. Re-run the
[verification checks](OPERATIONS.md#verify-container-networking) after
Docker, BuildKit, runc, or guest-image upgrades. They do not establish that
an application's full test suite passes.
