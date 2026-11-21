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
install -m 0700 pi/sandbox/github-token "$HOME/.config/pi-sandbox/github-token"
install -m 0600 pi/sandbox/config.example.json "$HOME/.config/pi-sandbox/config.json"
install -m 0644 pi/sandbox/OPERATIONS.md "$HOME/.config/pi-sandbox/OPERATIONS.md"
install -m 0644 pi/sandbox/sandbox.ts "$HOME/.pi/agent/extensions/sandbox.ts"
install -d "$HOME/.pi/agent/extensions/shared"
install -m 0644 pi/agent/extensions/shared/usage.ts "$HOME/.pi/agent/extensions/shared/usage.ts"
cp -R pi/agent/extensions/delegation "$HOME/.pi/agent/extensions/"
sudo -n docker pull mcr.microsoft.com/devcontainers/universal@sha256:d247757d344fecd9a77467767e64a1479367047b74ad82453c08ff17a13ff7ec
```

Existing containers keep their original image. To move an existing sandbox
to Universal, destroy and recreate it. The checkout survives; files and
nested images stored only inside the old sandbox do not.

For the `github-git` profile, pull the broker image:

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

Install a `gh` version that supports `--expiring` at `~/.local/bin/gh` and
sign in on the host with `gh auth login --hostname github.com --expiring`.
For an existing login, use `gh auth refresh --hostname github.com --expiring`.
The `offline` profile needs neither iron-proxy nor GitHub credentials.

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

A provider is a host-side command that emits one secret. The broker uses a
snapshot; the guest gets a placeholder. The GitHub provider uses an expiring
`gh` access token. Its refresh credential stays with `gh`, and the access
token's lifetime limits the exposure if the token leaks. Ask Pi to refresh
the sandbox credentials explicitly when needed. Refresh keeps the existing
profile and requires neither a sandbox restart nor a mode change.
