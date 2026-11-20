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

Start `pi` normally. It starts in **HOST** mode for system administration.

Run `/sandbox on` to switch to sandbox routing. The first shell or file call
starts this session's sandbox and runs in `/workspace`. If the sandbox is
missing, Pi creates it using the default workspace and profile in
`~/.config/pi-sandbox/config.json`: `sandbox-managed` with `offline`. The host
working directory is never mounted automatically. For a different approved
workspace or profile, explicitly create the sandbox before using its tools.

Use `/sandbox off` to restore host shell and file tools without stopping the
sandbox. `/sandbox status` shows the routing mode; `sandbox_manage` reports
the container state and profile.

Pi can manage its session's sandbox in either mode. The next sandbox tool call
restarts a stopped sandbox with its existing profile or replaces a destroyed
sandbox with the default. Destruction preserves the checkout under `/data/dev`.
Failed startup returns an error with no host fallback.

## Threat model

We trust the agent. The sandbox guards against **confused-deputy mistakes**,
such as running a project command with host privileges, and **untrusted
dependencies**, such as an npm install script that tries to read host secrets
or reach arbitrary network destinations. Run those commands in SANDBOX mode.

Pi and its model credentials stay on the host. The sandbox sees the approved
workspace as a writable mount and has its own Docker daemon. It does not get
the host home directory or Docker socket. It gets separate read-only mounts
for the [guidance paths](OPERATIONS.md#start-work-or-change-profiles).
Dependencies can read the guidance, alter the mounted checkout, and exercise
the network permissions of the profile.
This setup does not aim to contain a malicious agent or withstand a host escape.

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
