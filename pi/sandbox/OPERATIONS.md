# Pi sandbox operations

## Identify the mode and sandbox

A fresh Pi session or reload starts in **SANDBOX ONLY**. The user can check
host access with `/sandbox status` or the footer. `/sandbox off` adds host
tools; `/sandbox on` blocks them. Use unprefixed host tools only for host
administration. Use sandbox tools for project work in both modes. A failed
sandbox call never falls back to the host.

In either mode, use this codemode call to inspect the current Pi session's
sandbox:

```js
text(await tools.sandbox_manage({ action: "status" }));
```

`absent` means there is no controller record for this session. Otherwise the
result includes the container state, workspace, profile, and, if applicable,
the credential snapshot timestamp. The tool does not report the routing
mode. Each Pi session manages its own sandbox; no ID argument is needed.

## Start work or change profiles

The first sandbox shell or file call starts a stopped sandbox or creates a
missing one from the `default` in `~/.config/pi-sandbox/config.json`
(`sandbox-managed` and `offline` on this host).
Use `sandbox_shell`, `sandbox_read`, and `sandbox_edit` for project work.
Use `sandbox_read` at the original paths for mounted guidance:

- `~/.pi/agent/skills/`, including skill references
- `~/.pi/agent/expectations/`
- `~/.copilot/instructions/`
- `~/.config/pi-sandbox/OPERATIONS.md`

New containers mount these locations read-only when present. Other host paths,
including additional skill directories, are not mounted. The guidance also
becomes readable to programs inside the sandbox, so keep credentials and
private configuration out of these locations. If the approved workspace
contains a guidance source, use a separate checkout for project work.
Existing containers need to be recreated to get the mounts.

For a routing check, run this in either mode; it may start the sandbox:

```js
text(await tools.sandbox_shell({ command: "pwd" }));
```

Expect `/workspace`. The checkout and its Git metadata belong under
`/workspace` to survive recreation.

To approve a different workspace, enable host access with the user's approval.
Create or choose a real directory directly under `/data/dev`, on the
`/data` filesystem, with no symlinks or nested mounts. Add its directory name
to the live config's `workspaces` object with only the approved profiles.
For example, the entry `"my-repo": {"profiles": ["offline", "github-git"]}`
approves `/data/dev/my-repo` for both profiles. Choosing a workspace does
not require changing the default.

To use a specific workspace or profile, create it explicitly before the
next sandbox shell or file call:

```js
text(await tools.sandbox_manage({
  action: "create", workspace: "sandbox-managed", profile: "github-git",
}));
```

Profile edits, including `container_proxy` changes, take effect only after
recreation. Install the host launcher described in the
[installation guide](README.md#install) before creating a `container_proxy`
profile. Stopping and restarting keeps the existing profile configuration.

If this session already has a sandbox, confirm what needs to be kept before
destroying it. Destruction preserves the mounted checkout but removes files
and nested Docker state stored only inside the container. Export any needed
inner Docker images or caches and save other required files under the
workspace first, then use
`tools.sandbox_manage({ action: "destroy" })` and explicitly create the
replacement before running project commands. Use
`tools.sandbox_manage({ action: "stop" })` for a pause; the next sandbox shell
or file call restarts it. Neither operation changes Pi's routing mode.

## Refresh GitHub access

`offline` has no broker. `github-git` allows brokered HTTPS Git on
`github.com`; API, Gists, and general package and image registry access are
outside the profile. If an existing `github-git` sandbox has an expired
credential, refresh the snapshot in either mode:

```js
text(await tools.sandbox_manage({ action: "refresh_credentials" }));
```

Check the new `credentials_loaded_at` timestamp, then retry the Git
operation in SANDBOX. If the provider fails, the old snapshot remains.
With host access enabled, run `~/.local/bin/gh auth status --hostname github.com`
and ask the user to reauthenticate if needed. Never run the provider directly to
diagnose it, print a token, copy a broker snapshot, or pass a host credential
to the container. The guest credential helper supplies a placeholder.

## Diagnose nested-container networking

Check the failing layer before changing application settings:

1. Confirm the sandbox uses the intended profile. `downloads` and
   `development-read` enable `container_proxy`; `offline` has no broker.
   Editing the live profile does not retrofit a running container.
2. If the outer container can download but an inner container or Dockerfile
   `RUN` cannot, check that the read-only launcher is mounted at
   `/usr/local/bin/runc` and that `/usr/bin/runc` remains the native runtime.
   Inspect `/etc/pi-container-network.json` inside the outer container for
   the concrete broker IPv4 endpoint, bypass list, and public CA path.
   Nested DNS cannot resolve the broker name.
3. Inspect explicit proxy variables in the affected process. An uppercase
   or lowercase value prevents defaults for that variable group. A custom
   or Java trust store needs its own public-CA configuration. For an
   overlapping CA mount error, resolve the caller's mount/trust requirement;
   do not remove it merely to suppress the error.
4. Distinguish connection failures, TLS trust failures, and broker HTTP 403
   responses. A 403 indicates a policy rejection; compare the host, method,
   and path with the profile rules. Do not widen write permissions to fix
   a download.

The outer container's `/var/log/pi-container-network.jsonl` records launcher
operations, CA mount destinations, and names of added environment keys.
It omits environment values and command arguments. A missing key can mean
the caller supplied an explicit value; a missing event does not establish
that no process ran, since pass-through calls are outside this audit.
Keep runtime audit evidence alongside broker diagnostics when investigating
a failure. Never collect private keys, credential snapshots, or token values.

## Verify container networking

From the repository root, run the focused launcher unit checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s pi/sandbox -p 'test_container_runc.py' -v
```

Run the maintained native verifier on the host with host access enabled
and the normal controller prerequisites installed:

```sh
python3 pi/sandbox/verify-container-network.py \
  --output /tmp/pi-container-network-check \
  2>/tmp/pi-container-network-check.stderr
```

It accepts `--controller`, `--runtime`, `--config`, and `--output`.
Defaults use the adjacent controller and runtime files, the live sandbox
configuration, and the `downloads` profile. It uses an existing approved
workspace with its own disposable managed sandbox and never deletes the
main session's sandbox. Remote GET downloads require network access; the
write and out-of-scope storage-read probes run after external network
disconnection.

Retain the caller-saved stderr and the output directory's broker and runtime
audit evidence. A successful unit run alone does not verify Docker or
BuildKit integration. Repeat native checks after Docker, BuildKit, runc,
guest-image, or launcher changes; the observed runtime versions and probe
results are recorded in the
[networking explanation](README.md#permissions-and-verification-limits).
Application test suites require separate verification.

## Diagnose startup and reboot failures

Ask the user to enable host access with `/sandbox off` before using host
diagnostics. Start with read-only checks:

```sh
findmnt --mountpoint /data
systemctl is-active tailscaled docker containerd sysbox
systemctl show docker.service containerd.service -p RequiresMountsFor
sudo -n docker info --format '{{.DockerRootDir}} {{.Driver}}'
sudo -n docker ps -a --filter name=pi-managed- --format '{{.Names}} {{.Status}}'
sudo -n docker network ls --filter name=pi-managed- --format '{{.Name}}'
```

Expect `/data` to be mounted, the services to be active, Docker's root to be
`/data/docker`, and the service mount requirements to reference
`/data/docker` and `/data/containerd`. Inspect
`systemctl cat docker.service containerd.service` and the relevant service
logs with `sudo -n journalctl -b -u docker -u containerd -u sysbox -n 80`
if a service is down. Share only relevant, redacted errors. Do not weaken
the workspace mount checks or move container storage back to the root disk
to get past a startup error.

After a reboot, reconnect over Tailscale SSH and start Pi if the old tmux
server is gone. Controller records and broker snapshots live under
`/run/user/$(id -u)/pi-sandboxctl`; they are temporary. Docker's named
containers and networks can outlive those records. If status says
`absent` and creation fails, compare the names from the commands above
with the controller record directories. Compare the base name
`pi-managed-<hash>` for the guest, broker (`-broker`), and network
(`-net`). An unmatched name is a lead; confirm ownership and that no
session is using the resources before any cleanup. Ask the user before
removing orphaned resources and never delete the checkout as part of
cleanup. End-to-end reboot recovery has not been verified on this host.
