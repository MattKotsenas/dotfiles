# Turn budget

Turn budget records the AI-credit cost of each ordinary turn or autopilot run.
It listens to Copilot CLI session events and stores all mutable data inside the
current session workspace, so concurrent Copilot sessions never share runtime
state.

The extension is passive: reaching a cap does not abort work. `config.json`
defines the caps that the state and history records report:

```json
{
  "schemaVersion": 1,
  "ordinaryAiCredits": 1000,
  "autopilotAiCredits": 1000,
  "heartbeatSeconds": 10
}
```

An explicit native `/goal ... --max-ai-credits N` value replaces the autopilot
default for that budget unit. The CLI rejects native values below 30 AIC; the
extension's own defaults are not subject to that native minimum.

## Next-unit override

Use `/budget next N` to set a positive integer AIC cap for the next budget unit:

```text
/budget next 2000
```

The override belongs to the current session and survives an idle extension or
CLI restart. Setting it does not change a unit already in progress, and setting
another value before consumption replaces the pending value. The next unit
consumes it with this precedence:

1. Explicit native `/goal --max-ai-credits`
2. Pending `/budget next`
3. Configured default for the unit's kind

An explicit native cap consumes the pending override even though the native cap
wins. This prevents an older override from unexpectedly applying to a later
turn.

## History

Use `/budget history` to show current-session prices for the ten most recent
completed budget units:

```text
/budget history
```

Pass a number from 1 through 50 to change the number of recent units shown:

```text
/budget history 25
```

The summary covers every completed unit in the session and reports total,
median, average, maximum, and over-cap count. A sparkline shows recent prices
from oldest to newest. The aligned table uses local `MM-DD HH:mm` timestamps
and short codes for mode, outcome, and cap source; its legend explains each
code. An open unit appears separately as `Active`; it is not included in the
completed-unit summary.

## Status line

`statusline.ps1` combines the CLI's session total with the extension's current
budget unit:

```text
S 3,961 AIC ($39.61) | T 327 / 1,000 AIC ($3.27 / $10) - PASSIVE
```

`S` is the CLI-reported session usage. `T` is the open budget unit, or the
latest completed unit while the session is idle. A fresh session shows zero
against the configured ordinary or autopilot default. The turn segment changes
from green to yellow at 70 percent and red at 100 percent; the session segment
is dimmed.

An armed override adds `NEXT` until a unit consumes it:

```text
S 3,961 AIC ($39.61) | T 327 / 1,000 AIC ($3.27 / $10) - NEXT 2,000 AIC - PASSIVE
```

`PASSIVE` makes that operating mode visible. Missing, malformed, stale,
mismatched, or faulted extension state produces `T ? - PASSIVE` instead of a
plausible total. Set
`TURN_BUDGET_STATUSLINE_DEBUG=1` when invoking the script directly to print the
rejected-state reason to stderr.

The renderer locates the latest versioned state snapshot beneath the
CLI-provided `transcript_path`, then verifies its schema, session ID, health,
heartbeat, and accounting fields. Despite its name, `transcript_path` contains
the session workspace directory in CLI `1.0.84-1`, not the `events.jsonl` path.
The renderer does not use process-global state.
The Windows command status line drops `│` and `·` from script output in this
CLI build, so the rendered contract uses visible ASCII separators. ANSI color
sequences are preserved.

### Live compatibility checks

The passive integration was exercised against CLI `1.0.84-1` on 2026-09-07:

- An ordinary turn plus its queued review hook finalized as one unit, and the
  displayed rounded AIC matched the history record.
- An inferred-autopilot run included a real explore subagent, its queued hooks,
  and one `source: "autopilot"` continuation in one unit. This exposed the
  descendant `source: "agent-..."` boundary the reducer keeps in the parent
  unit.
- An explicit `/goal ... --max-ai-credits 30` displayed and persisted 30 AIC
  with `capSource: "explicit-native"`.
- Restarting an idle session replaced the extension instance, preserved the
  latest completed unit, and continued to render healthy status.

Pause/resume stays covered by the observed-timeline fixture; automated input
to a busy interactive TUI is too nondeterministic to re-test live.

The next-unit override was exercised against CLI `1.0.84-1` on 2026-09-08.
`/budget next 2` armed without starting model work and produced an ordinary
history record with `capSource: "next-override"`. A subsequent pending 5-AIC
override was consumed by an explicit 30-AIC goal, whose history retained
`capSource: "explicit-native"`. Invalid input displayed the command usage
without faulting accounting.

The history command was exercised against CLI `1.0.84-3` on 2026-09-09. It
reported an empty session, then priced a completed turn, honored an explicit
row limit, rejected an out-of-range limit without faulting accounting, and
preserved the record across restart and resume.

## Persistence

Windows may deny replacement of a state file while another process scans or
reads it. State heartbeats therefore publish immutable, versioned snapshots
instead of replacing a hot destination. Cleanup normally retains the latest
three; a locked obsolete snapshot remains until a later heartbeat can remove
it. Each extension atomically reserves an increasing session-local generation,
so a new instance wins during a reload overlap and after a machine restart even
when two instances publish the same revision. Existing legacy `state.json` data
is read during migration and ignored after the first snapshot succeeds.

## Data

The extension writes only beneath its current session:

```text
<session workspace>\files\turn-budget\
  generation.<extension-generation>.claim
  state.<extension-generation>.<revision>.<extension-instance>.json
  history\
    <budget-unit-id>.json
```

The latest state snapshot contains the extension instance, heartbeat, health,
reducer state, pending override, open budget unit, and latest completed budget
unit. Each completed unit gets one deterministic history file. Rewriting the
same record is idempotent.

History contains event identifiers, timestamps, objective and interaction
identifiers, nano-AIU usage, cap, cap source, and outcome. It does not copy
prompts, responses, tool arguments, or tool output.

## Observed Copilot behavior

These timelines were observed with Copilot CLI `1.0.84-1` on 2026-09-06. They
record the behavior the reducer must contend with, not a permanent CLI
contract. The sanitized executable record is
`tests\fixtures\observed-timelines.json`; it retains event ordering,
timestamps, usage, modes, delivery, sources, continuation markers, and
objective transitions while omitting conversation content and irrelevant
events.

### Ordinary prompt

```text
root user.message
  -> assistant.usage
  -> queued hook user.message
  -> assistant.usage
  -> session.idle
```

There is no idle event between the visible answer and a queued hook turn. Both
usage records precede the same final idle event.

### Explicit `/goal`

```text
objective active
  -> mode autopilot
  -> objective root message
  -> usage and queued hook usage
  -> session.idle while objective remains active
  -> source: autopilot continuation
  -> usage
  -> session.task_complete
  -> objective completed
  -> queued hook usage
  -> final session.idle
```

The objective remained active across the intermediate idle. The observed
explicit continuation had `source: "autopilot"` without
`isAutopilotContinuation: true`.

### Inferred autopilot

```text
mode autopilot, no objective record
  -> root user.message
  -> usage and queued hook usage
  -> session.idle
  -> source: autopilot continuation
  -> usage
  -> session.task_complete
  -> queued hook usage
  -> final session.idle
```

`session.task_complete` appeared before the final queued hook and idle.

### Pause and resume

```text
active objective
  -> usage
  -> mode interactive while work remains active
  -> objective paused
  -> in-flight and queued hook usage
  -> session.idle

objective active again
  -> mode autopilot
  -> new objective root message
  -> usage
  -> completion and queued hook usage
  -> session.idle
```

`/autopilot off` does not cancel work already in flight. Resume increments the
objective's resume count and resets its native limit usage while preserving
cumulative objective usage.

### Continuation exhaustion

```text
root user.message
  -> usage and queued hook usage
  -> session.idle
  -> automatic continuation
  -> usage and queued hook usage
  -> session.idle
  -> automatic continuation
  -> usage and queued hook usage
  -> session.idle
```

Exhausting `--max-autopilot-continues` emitted no terminal, abort, objective, or
mode-change event. The session remained in autopilot mode. A later
`/autopilot off` emitted only a mode change.

## Accounting state machine

`ordinary-active` starts on root work outside autopilot. It includes all usage,
including descendant and queued-hook usage, and finalizes on `session.idle`.

`autopilot-active` starts on explicit objective activation, resumed objective
activation, or root work delivered in autopilot mode. It includes all usage and
does not finalize at an intermediate idle.

An automatic continuation is identified by `source: "autopilot"` or
`isAutopilotContinuation: true`. Resumed objectives start a new budget unit.
Subagent root messages use a session-scoped `agent-...` source. They do not
start or supersede a unit; their usage remains in the parent unit.

An idle autopilot unit without a terminal signal becomes
`autopilot-quiescent`. An automatic continuation reactivates it. A new
non-continuation root message finalizes it at the retained idle timestamp and
starts another budget unit. Leaving autopilot while quiescent finalizes it
immediately.

Task completion, objective completion/pause/deletion, or leaving autopilot
while work is active moves the unit to `autopilot-terminal-pending`. Usage from
work and hooks already in flight remains in the unit, which finalizes at the
next `session.idle`.

If usage arrives without an open budget unit, or persisted state disagrees with
the live mode/objective while a unit is open, the extension records a fault and
stops accounting. It does not invent a partial total.

Installing or reloading the extension after work has already started also
records a fault. Run `/extensions reload` once the session is idle to account
for subsequent work.

## Running the tests

The reducer uses Node's built-in test runner and has no package dependencies:

```powershell
node --test copilot\extensions\turn-budget\tests\accounting.test.mjs copilot\extensions\turn-budget\tests\budget-command.test.mjs copilot\extensions\turn-budget\tests\history.test.mjs copilot\extensions\turn-budget\tests\operation-queue.test.mjs copilot\extensions\turn-budget\tests\persistence.test.mjs
pwsh -NoLogo -NoProfile -File copilot\extensions\turn-budget\tests\statusline.Tests.ps1
```
