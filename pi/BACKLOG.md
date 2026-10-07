# Pi backlog

Capture workflow papercuts here without interrupting the current task. Entries are candidates, not commitments; pick one up deliberately and remove it when resolved.

## Program status via OSC 7501

Add support for [Program Status (OSC 7501)](https://mitchellh.com/writing/program-status-osc7501) to Pi. Prefer installing an existing extension if someone builds one; otherwise build support as a Pi extension.

Use the emitted status to drive status indicators in psmux, likely through a plugin rather than psmux core. Evaluate available support on both sides before implementing.

Acceptance: Pi's program status reaches psmux and updates the corresponding pane's status indicator through the chosen integration.

## Relocate a conversation into its worktree

Moving a task from a repository's bare root into a Grove worktree should keep the conversation and make Pi's displayed directory, relative tool paths, and project context agree. The installed `@firstpick/pi-extension-cd` forks the session, leaving another copy of its history behind.

Evaluate relocation instead of forking. Candidates include `@yceachan/pi-switch-cwd` (`/cwd`) and `@k3_2o/pi-move` (`/move`). Inspect implementation and compatibility with the installed Pi version before replacing the current extension; do not install overlapping `/cd` handlers.

Acceptance: move into a worktree and back with history intact, predictable `/resume` discovery, and the correct directory-bound instructions and tools. A cancelled or failed move must leave the original session usable.

## Confirmed agent-requested directory switching

After creating a Grove worktree, the agent should be able to request switching Pi into it without requiring the user to copy a path into `/cd`.

Prefer an existing supported tool if one is available. Otherwise, evaluate a small extension that confirms the target directory with the user and performs the switch at a supported idle boundary. Pi documents session-switch operations as command-context-only; do not call them directly from an active tool execution or merely change `process.cwd()`.

Acceptance: show the target before approval, perform no switch on cancellation, and verify the resulting directory and branch before continuing. Account for concurrent tools, running child processes, reloaded project instructions/settings/extensions/MCP servers, and project trust. Preserve conversation history and report the switch visibly. Changed prompt context can disrupt provider caching, so avoid directory hopping for incidental reads.
