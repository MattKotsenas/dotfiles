# Cost

`/cost` opens a text-native inspector for the current session's recorded cost
estimates in USD. It starts at the newest activity. Bars and a table share the
same selection, cumulative chart, window, and range-wide scales.
To install this extension, follow [Pi's install instructions](../../../README.md#install).

## Checkpoints and the footer

`/cost mark [name]` saves a checkpoint at the current end of the usage ledger.
Without a name, it generates one. Marking does not change the footer or the
inspected range. In the popup, `m` marks after the selected activity instead;
its name identifies that activity.

Press `c` to choose a checkpoint. Enter inspects spending since it; `f` selects
it as the footer baseline without changing the inspected range. Choose
`Session start` to inspect or select the whole session. `/cost total` restores
the session-total footer directly.

Checkpoints are temporal: spending appended after their position counts even
when you navigate to another branch. They and the selected footer baseline
survive resume, reload, and `/tree`. The current-path filter changes only the
inspector, never the footer. A checkpoint inside a turn includes only the
charges recorded after that checkpoint.

`u` removes the newest checkpoint created in this session, including one created
before resume. If that checkpoint is the inspected range or footer baseline,
that scope falls back to the session total. Removal is an appended record;
recorded usage and earlier metadata remain intact.

The footer keeps the existing subscription indicator when the whole session has
no recorded cost. An explicitly selected checkpoint with no subsequent spending
shows `$0.00`. Idle cache-warming charges appear within roughly a second in the
interactive footer and open inspector.

## Controls

| Key | Action |
| --- | --- |
| Left / Up, Right / Down | Previous / next activity |
| Home / End | First / last activity |
| `t` | Switch bars / table |
| `p` | Switch all branches / current path |
| `c` | Open checkpoint picker |
| Enter in picker | Inspect the chosen range |
| `f` in picker | Select the footer baseline |
| `m` | Mark after the selected activity |
| `u` | Remove the newest checkpoint |
| Escape | Back from picker, or close |

Both graphs highlight the selected activity. Arrows at the window edges indicate
offscreen activity. Overhead uses muted bars at the same cost scale. The table
shows excerpts around the selection without moving the cumulative window.

The popup needs interactive Pi and at least 38 columns by 24 rows of content
space. Checkpoint commands and turn recording also work without a terminal.

## Accounting and turn boundaries

The default total includes all recorded usage in the session file, including
abandoned branches. The path filter includes only entries on the selected
ancestry, including entries summarized by compaction. Assistant responses,
tool/subagent results, standalone usage, compactions, and branch summaries each
contribute their recorded charge once. Billed errors and cancellations count.
Child-session files and nested usage already rolled into a tool result are not
counted again. Unreported charges cannot be recovered from this ledger.

A recorded conversation turn starts with prompt preparation and ends at
`agent_settled`. It includes automatic compaction, tools, subagents, retries,
steering, and queued follow-ups. Pi 1.2.0 exposes the queue kind at submission but
does not reliably identify it at delivery, so queued follow-ups remain in that
turn. Idle warming and manual summaries outside a turn remain separate overhead.

Older history has no persisted settlement boundaries. Its assistant and tool
usage is grouped by nearest user ancestor; compaction, summary, and standalone
usage appear separately. These historical groups approximate turns. Activities
are ordered by their last contributing entry; the cumulative chart sums the
displayed groups, not individual historical charge timestamps. Interrupted
runs keep their charges without being classified as completed turns. No usage
amounts are rewritten to improve grouping.

## Tangents and session scope

`/tangent [name]` creates a fresh checkpoint after the child's inherited history
and selects it as that child's footer baseline. New child spending starts at
zero without erasing inherited costs; the inspector can still show the child's
whole-session total. Nested tangents each get their own baseline.

Checkpoints and footer selections belong to one session ID. Ordinary forks do
not inherit the parent's selected baseline and default to their session total.
Neither parent nor child aggregates spending from the other's file.

## Verification

Run `cd pi && npm run check` for component and isolated SDK tests.
`node pi/tests/cost.pty.mjs` checks the production popup, persisted baseline,
resume, and tangent workflow in its own tmux/psmux namespace with a local faux
provider. The [frozen-fixture harness](../../../spikes/cost/README.md) exercises
the same renderer with dense historical data and dark/light themes.
