# psmux-session-map

A Copilot CLI plugin (hook only) that records each session's id keyed by its
process id, so [psmux-resurrect](https://github.com/MattKotsenas/psmux-plugins)
can save a copilot pane as `clod --resume=<session-id>` and restore the real
session after a reboot -- instead of launching a fresh `clod`.

## How it works

Copilot delivers each hook's payload as JSON on stdin (`{ "sessionId": ... }`);
the `COPILOT_*` env vars are empty at hook time. This plugin's hook keys the
mapping by the nearest `copilot` process above it -- the loader pid the save
strategy matches on:

- **sessionStart** -> writes `~/.copilot/psmux-sessions/<copilot-pid>` =
  `<session-id>`, then prunes any mapping whose pid is no longer alive.
  sessionStart fires on every session transition, so the mapping always names the
  *current* session, not the one the pane launched with.
- **sessionEnd** -> deletes this session's own mapping.

The psmux-resurrect `copilot` save-command strategy
(`~/.psmux/strategies/save_command_strategies/copilot.ps1`) walks a pane's
process descendants at save time, finds the copilot pid, and persists
`clod --resume=<id>` -- resolving the id from the mapping (primary) or, for a
just-restored pane whose sessionStart has not fired yet, the process's own
`--resume=<id>` argument (fallback).

Crash safety: a non-graceful exit never fires `sessionEnd`, so its file lingers
until the next session's start prunes it (its pid is dead). PID reuse is
harmless -- a new copilot overwrites the file with its own session id.

## Install

```
copilot plugin install MattKotsenas/dotfiles:copilot/psmux-session-map
```
