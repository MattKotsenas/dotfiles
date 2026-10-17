# Pi

## Additional instructions

`agent/extensions/additional-instructions.ts` loads external files into Pi's system-prompt
context. Configure it in `~/.pi/agent/settings.json`:

```json
{
  "additionalInstructions": {
    "paths": ["~/.copilot/instructions/*.instructions.md"]
  }
}
```

Paths accept filenames or Node.js file glob patterns. `~`, `~/`, and `~\` refer to
the current user's home; relative paths resolve from Pi's agent directory, including a
`PI_CODING_AGENT_DIR` override. Patterns are processed in configured order, with each
pattern's matches sorted by path. `*` matches within one directory; `**` enables recursion.
Directories are not expanded implicitly. A pattern matching no files produces a warning.
`~user` paths are unsupported.

The extension rereads user-level settings and the configured files before each agent run. It preserves
file contents and source paths, skips files already in native context or reached through
another symlink, and warns on read failures while continuing with readable paths. Project
settings do not configure this extension. Instructions remain in system-prompt context
through compaction, without model-issued file reads.

## Navigation

`pi-vim-editor@0.4.0` adds Vim editing to Powerline's prompt editor. The Powerline
mode segment shows the mode and pending keys, such as `NORMAL · d`, or `BROWSE`.
`r` waits to replace one character in NORMAL; `R` enters REPLACE. Escape enters
NORMAL from INSERT; another Escape interrupts the agent. Search and dialogs
handle Escape themselves.

### Browse the conversation

Press **`q` in idle NORMAL** to enter BROWSE without clearing the draft or moving
its cursor. This plugin leaves `q` unused because it has no macro recording.
Alt-B toggles BROWSE from INSERT or NORMAL. Finish or cancel pending Vim commands
and Visual selections before entering BROWSE.

| Key in BROWSE | Action |
| --- | --- |
| `j` / `k` | Scroll down / up one line |
| `d` / `u` | Scroll down / up half a page |
| `J` / `K` | Next / previous marked user or assistant message |
| `gg` / `G` | Transcript top / bottom; bottom resumes following output |
| `/` | Open Pi's rendered-transcript search |
| Alt-B / `q` | Return to the previous editor mode |
| `i` | Return to INSERT |

Search accepts ordinary query text, including `j`, `k`, and `n`. **Enter** moves
forward; **Shift-Enter** moves backward. Pi's Ctrl-G / Ctrl-Shift-G defaults also
work. Windows Terminal sends Shift-Enter as ESC+Enter, so `keybindings.json` adds
Alt-Enter as a previous-match alias within search. Escape closes search and
resumes BROWSE. Closing search discards the query; there is no persistent `n/N`
repeat outside the dialog. Search includes offscreen rendered content, with
case-insensitive literal matching and normalized whitespace.

**Ctrl-O** toggles tool-output expansion. Only rendered tool output is searchable.
Use psmux copy mode to select and copy the visible result. Dialogs suspend browse
bindings. Escape leaves BROWSE and continues through the editor's usual Escape
handling. Other browse keystrokes cannot edit or submit the draft.

### Integration and validation

Load packages in this order: `powerline-chrome`, `vim-navigation`,
`pi-powerline-footer`, `pi-vim-editor`. Transcript navigation uses Pi's public
keybinding manager. Editor integration depends on implementation details: the
Vim package uses private editing, undo and layout state; our adapter selects
Powerline's prototype renderer and intercepts Pi's protected border methods.
Package upgrades need the integration tests below.

The protected-border hook is cosmetic: it merges Powerline status into the
rounded frame. It is the first dependency to reconsider if upkeep becomes
costly; editing and browsing do not require that merged frame.

TODO(someday): move Vim onto public Pi editing, undo and layout APIs.

Run `node --test pi/tests/*.test.*` for component tests and
`node pi/tests/vim-pty.mjs` for the isolated Windows ConPTY test. The latter needs
psmux, PowerShell, Pi, and the installed Powerline/Vim/Catppuccin packages. It creates its own
psmux namespace, settings, synthetic session, and local faux provider, then removes
its test session. Captures remain in the printed temporary artifact directory.
Set `PI_VIM_EDITOR` to a package's `src/index.ts` to test a separate package copy.
