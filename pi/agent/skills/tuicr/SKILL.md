---
name: tuicr
description: Open changes or prose in tuicr for human review, read saved feedback, or record agent findings when requested. Use for "open tuicr", "let's review", "pull up the diff", and "read my comments". Launch beside the agent in the same window; never create another window unless asked.
---

# tuicr review workflow

The human uses the TUI; the agent uses `tuicr review`. For raw diffs, inline walkthroughs, or read-only remote
PR reviews without a tuicr session, use the appropriate diff tools. Honor pasted feedback too.

## Open for the user

Default to user-led review when asked to open your changes. Do not add agent comments or impersonate the user.
Required independent reviews remain separate from this human review.

1. Keep the requested scope. Reuse an existing pane only when it is known to show that target:

   | Target | Pane command |
   | --- | --- |
   | Uncommitted changes | `tuicr -w` |
   | Committed changes | `tuicr -r <base>..HEAD` |
   | Prose or another file | `tuicr --file <path>` |
   | Remote PR | `tuicr pr <url>` |

   Use the actual base or requested subset; a clean worktree needs a committed target. Prepare specialized
   comparisons separately from launching the review.
2. Open a side-by-side sibling pane in the agent's **same window**. Target the inherited `TMUX_PANE`, never the
   active pane or a guessed ID. Never create a window, terminal, or session unless asked. If the ID is missing or
   splitting fails, stop and ask. Open each target in a sibling pane; the user manages readability with zoom.
   Do not rearrange or close panes to make room.
3. Run tuicr directly as the detached pane command. These examples use psmux's `tmux` executable on Windows;
   use your multiplexer and the tool's actual shell. Substitute the chosen target flags for `-w`, quoting paths
   containing spaces inside the pane command too.

   Bash:

   ```bash
   pane=$(tmux split-window -t "$TMUX_PANE" -h -d -P -F '#{pane_id}' -l 65% -c 'C:/work/widget' 'tuicr --no-update-check -w')
   ```

   PowerShell:

   ```powershell
   $pane = tmux split-window -t $env:TMUX_PANE -h -d -P -F '#{pane_id}' -l 65% -c 'C:/work/widget' 'tuicr --no-update-check -w'
   ```

   Check the exit status and save the returned pane ID. The launch returns promptly while tuicr waits for the
   human. Avoid shell wrappers; when PowerShell is necessary, use `pwsh -NoProfile`.
4. Run `tuicr review list --repo <repo>` and match the requested target. For file/no-VCS reviews absent there,
   use `tuicr review list --all`. Retain the matching row's exact JSON `path` as the feedback handle for local,
   file, or PR reviews. `active` helps selection but does not establish the target; ask if ambiguous. An immediate
   empty listing can be startup delay: check again before declaring failure or relaunching. Confirm the intended
   review is open before announcing readiness.
5. Tell the user what opened and return control. Poll only when asked to watch; leave panes, layout, and focus
   alone unless asked to change them.

## Read feedback

When asked, read the saved handle:

```sh
tuicr review comments --session '<session-json-path>'
```

Without a handle, discover the target as above. If a listed slug fails, try its listed path. If the file has
vanished, refresh discovery and report the absence; do not conclude that unread feedback never existed.

Read small JSON results directly; use the host tool's JSON support for necessary filtering. Avoid ad hoc Python
or shell scripts and persistence-directory scans for routine launch, discovery, and feedback reads.

## Write agent findings

Write only when the user requests agent-authored comments and the target is confirmed. Supply `--username`:

```sh
tuicr review add --session '<session-json-path>' --target-file src/main.rs --line 42 --side new --type issue --username 'Agent' 'Handle the empty case.'
```

Omit file and line for review-level comments, or line for file-level comments. Use `--end-line` for ranges and
`--side old` for removed lines. Reading a PR does not authorize posting, submitting, publishing, or pushing.
Consult `tuicr <command> --help` for uncommon flags.
