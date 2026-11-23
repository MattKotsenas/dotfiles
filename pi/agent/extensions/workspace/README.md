# Workspace

Use `/cd` to show the current working directory. In an idle interactive terminal
session, use `/cd "../other project"` to move the current conversation there.
Paths support matching single or double quotes, relative paths, native Windows
separators, and `~`. Print, JSON, and RPC sessions cannot move workspaces.

The [agent settings](../../settings.json) pin a temporary `pi-powerline-footer`
fork with `powerline.cdCommand` set to `false`, so only this extension registers
`/cd`. Once upstream publishes a release containing the opt-out from
[PR #272](https://github.com/nicobailon/pi-powerline-footer/pull/272), replace the
fork's git source with that release's npm source and rerun the footer/Vim checks
below. Keep `powerline.cdCommand` set to `false`.

An existing durable conversation keeps its UUID, branches, and metadata. Its
session file moves into the destination workspace's native session storage.
The old file path is unsupported after the move; use the moved file or resume
from the destination workspace. A fresh, unwritten empty session can receive a
new UUID. Unwritten custom or conversation state cannot be moved.

The sharing check reads the existing file and warns about entry IDs this instance
has not loaded. Cancel is the default; only **Move anyway** proceeds. This is a
best-effort check: it cannot detect idle openers or prevent later writes. Moving
accepts the risk that another opener can keep writing to the old location.
No locks, aliases, or session registry are created.

Failures report the move phase, file existence, and available runtime identity.
There is no automatic rollback.

Run the isolated SDK regression tests from `pi/`:

```sh
node --test tests/workspace.test.mjs
```

The tests use disposable synthetic sessions and the repository's Pi SDK 1.5.2.
They block network and model requests and do not load the footer. From the
dotfiles root, check the installed footer's render seam, package discovery, and
Vim navigation:

```sh
node --test pi/tests/powerline-chrome.test.mjs pi/tests/vim-navigation.test.mjs
```
