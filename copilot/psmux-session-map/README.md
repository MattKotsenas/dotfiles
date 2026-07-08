# psmux-session-map

A Copilot CLI plugin (hook only) that records each session's id keyed by its
process id, so [psmux-resurrect](https://github.com/MattKotsenas/psmux-plugins)
can save a copilot pane as `clod --resume=<session-id>` and restore the real
session after a reboot -- instead of launching a fresh `clod`.

## How it works

Copilot exposes two env vars to hooks: `COPILOT_LOADER_PID` (the copilot.exe
pid) and `COPILOT_AGENT_SESSION_ID` (the session guid). This plugin's hook:

- **sessionStart** -> writes `~/.copilot/psmux-sessions/<COPILOT_LOADER_PID>` =
  `<session-id>`, then prunes any mapping whose pid is no longer alive.
- **sessionEnd** -> deletes this session's own mapping.

The psmux-resurrect `copilot` save-command strategy
(`~/.psmux/strategies/save_command_strategies/copilot.ps1`) walks a pane's
process descendants at save time, finds the copilot pid, reads its mapping, and
persists `clod --resume=<id>`.

Crash safety: a non-graceful exit never fires `sessionEnd`, so its file lingers
until the next session's start prunes it (its pid is dead). PID reuse is
harmless -- a new copilot overwrites the file with its own session id.

## Install

```
copilot plugin install MattKotsenas/dotfiles:copilot/psmux-session-map
```
