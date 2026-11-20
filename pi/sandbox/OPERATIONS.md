# Pi sandbox operations

## Identify the mode and sandbox

A fresh Pi session starts in HOST. The user can check the routing mode with
`/sandbox status` or the HOST/SANDBOX footer. The user switches modes with
`/sandbox on` and `/sandbox off`. Use HOST for host administration and
SANDBOX for project commands. A failed sandbox operation is never a reason
to retry a project command on the host.

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

After the user runs `/sandbox on`, the first shell or file call creates a
missing sandbox from the `default` in `~/.config/pi-sandbox/config.json`
(`sandbox-managed` and `offline` on this host) or starts a stopped sandbox.
Use `sandbox_shell`, `sandbox_read`, and `sandbox_edit` for project work.
For a routing check, run this after switching; it may start the sandbox:

```js
text(await tools.sandbox_shell({ command: "pwd" }));
```

Expect `/workspace`. The checkout and its Git metadata belong under
`/workspace` to survive recreation.

To approve a different workspace, work in HOST with the user's approval.
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

If this session already has a sandbox, confirm what needs to be kept before
destroying it. Destruction preserves the mounted checkout. It removes files
and nested Docker state stored only inside the container. Save anything
needed under the workspace first, then use
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
Check `~/.local/bin/gh auth status --hostname github.com` in HOST and ask
the user to reauthenticate if needed. Never run the provider directly to
diagnose it, print a token, copy a broker snapshot, or pass a host credential
to the container. The guest credential helper supplies a placeholder.

## Diagnose startup and reboot failures

Ask the user to switch to HOST before using host diagnostics. Start with
read-only checks:

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
