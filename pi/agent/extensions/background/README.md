# Background commands

Lets [Pi](https://pi.dev) run long commands in the background instead of waiting on them. Pi starts the job, carries on or hands back to you, and gets a message when the job finishes or prints something it's waiting for.

This extension is maintained directly in dotfiles. The dotfiles installer links the files under
`~/.pi/agent/extensions/background/`, where Pi discovers `index.ts`. Restart Pi or run `/reload`
after linking them. Do not also load the published `pi-background` package: both register the same tools
and commands. To try the unlinked source for one invocation, run
`pi -e ./pi/agent/extensions/background` from the dotfiles root.

## Disable background

Add this entry to `extensions` in `~/.pi/agent/settings.json`, preserving any other entries, then run
`/reload` or restart Pi:

```json
{
  "extensions": ["-extensions/background/index.ts"]
}
```

This is Pi's native load-time exclusion. It removes the background tools. When no other extension
replaces bash, Pi's built-in bash is restored.
Remove that entry and reload to enable background again. Let important jobs finish before reloading;
extension shutdown requests best-effort cancellation.

Dotfiles sets `"codemode": { "mode": "only" }` and keeps `"defaultTools": ["+codemode"]`.
The model sees only codemode; the other enabled tools remain callable inside its scripts. To restore
direct tool declarations, set `codemode.mode` to `"on"` and reload.

If Pi cannot start normally, this invocation skips all extensions and gives the model the native tools:

```sh
pi --no-extensions --tools "read,bash,edit,write"
```

## Maintenance and provenance

The source comes from [Pringled/pi-extensions](https://github.com/Pringled/pi-extensions/tree/main/packages/pi-background),
package `pi-background` 0.4.2. The upstream checkout was
`7d18b3caa8c61b8a780e7f6addc50b412228c30a`; local development added structured results,
bounded waits, retained run ownership, the pure job state machine, and replaceable output stores.
The imported development revision is `bd700baed1d96e454950744dd16474dcab32bf55`.

There is no upstream synchronization or separate package release here. Inspect and port upstream changes
selectively. The original MIT copyright and permission notice is preserved in [LICENSE](LICENSE).

From `pi/`, run `npm run check` for the integrated checks or `npm run test:background` for the background
suite. `npm run test:background-state` enforces 100% line, branch, and function coverage of the pure
state machine. SDK/process tests use Pi 1.5.2 with a synthetic provider and disposable state; they
exercise both stores through direct tools and codemode. On Windows they use Git Bash at
`C:/Program Files/Git/bin/bash.exe`; set `PI_BACKGROUND_TEST_SHELL` to test another Bash installation.
Physical TUI/Escape interaction and universal descendant containment are not qualified by these tests.

## Features

- Long commands like downloads, builds, test suites and training runs go to the background, and Pi hears back with the exit code and the end of the output when they finish.
- While a job runs, a line above the input shows it with its elapsed time and latest output, such as `⏵ bg1 python3 train.py · 4m12s · epoch 3/10 loss 0.41`. A job that has printed nothing for 10 minutes shows `no output for 12m30s` instead, so a stuck one stands out. With more than three jobs running, they share one line, `⏵ 5 jobs`, which adds `1 silent for 10m+` when one may be stuck; `/bg` has the details.
- `/bg` shows a job's last 20 lines of output, updating while it runs (`/bg bg2` for a specific job). Press esc to close it. Its list shows running jobs first, then the 10 latest finished ones.
- Pi can wait for a specific line, such as a dev server's `listening on` or a training run's `epoch 3`, without checking again and again.
- Jobs started together are reported together: when Pi starts several jobs at once, such as benchmarks to compare, it's woken once when the last one finishes instead of after each. You can keep chatting meanwhile, and a job that runs much longer doesn't hold the others back for more than 2 minutes.
- A regular shell command still running after 2 minutes moves to the background on its own, so a slow command Pi didn't expect never holds up the turn. It shows in the jobs line, and Pi hears back when it ends. Press `ctrl+b` to move a running command to the background sooner. If another extension already replaces Pi's bash, such as a sandbox, pi-background leaves it alone.

You don't need to do anything differently: Pi decides when a job belongs in the background. You can also ask for it, for example "run the tests in the background and tell me when they're done".

## Settings

The running jobs line has three levels. Set one in `~/.pi/agent/settings.json`, for example `"background": { "jobs": "compact" }`.

| `jobs` | What it shows |
| --- | --- |
| `full` (default) | `⏵ bg1 python3 train.py · 4m12s · epoch 3/10 loss 0.41` |
| `compact` | `⏵ bg1 python3 train.py · 4m12s` |
| `off` | Nothing |

### Output capture

`background.output` selects combined stdout/stderr capture. The default, `"file"`, retains a log in the system temporary directory. Logs have no size limit or automatic deletion. Tail reads use bounded asynchronous file reads.

To retain output only in memory, set this in `~/.pi/agent/settings.json`, then reload the extension:

```json
{
  "background": {
    "output": "memory"
  }
}
```

Memory capture retains the newest 1 MiB per job, discards older bytes, and has no log path. On session shutdown, tracking is cleared and active jobs receive a best-effort stop request. Stores are disposed after their executions settle, so a surviving execution can retain its capture.

Selecting a store does not change Pi's shell execution or its combined stdout/stderr stream. Pi's push-only output callback cannot pause the source to apply file-write backpressure, so pending file writes can consume memory under sustained high output.

## Tools

`bg_run` starts a job, `bg_status` inspects it, `bg_wait` waits for completion within a caller-selected limit, and `bg_kill` requests a stop. Jobs use Pi's configured local shell and are stopped on session shutdown using Pi's best-effort process-tree cancellation.

A `bg_wait` timeout ends the wait, not the command. The result sets `wait_timed_out`; use the same job id to wait again. A completed wait includes the final captured output tail. Cancelling a wait cancels observation, without itself requesting a stop.

`bg_status` with an id, `bg_wait`, automatic bash handoff results, and completion notifications default to the newest **200 lines, capped at 64 KiB**. `bg_status` and `bg_wait` accept optional `lines` and `max_bytes` positive-integer overrides; both limits apply together. Omit them to use the defaults. `output_truncated` reports excluded output, including memory eviction or the bounded pre-handoff buffer. Increasing the limits can retrieve more retained output, but cannot recover discarded bytes. The `/bg` viewer keeps a shorter tail to fit the terminal.

A job becomes complete after its capture store finishes flushing. Capture failure produces status `failed` with an output diagnostic and preserves the command exit code when one is known.

### Cancellation

Aborting the agent run that launched a command requests a stop for that command, even after it moves to the background. Pi's Escape abort uses this path. Completing a run normally leaves its background jobs running, and aborting a later run does not stop those earlier jobs.

Use `/reap` to request a stop for all tracked running background jobs, including jobs whose launching run has ended. It uses the current Pi instance's command controllers, not PIDs recovered from session logs. It does not recover jobs after a restart. To stop just one job, use `bg_kill`.

A completed nested launch call does not receive later cancellation of its codemode sandbox. Cancelling that sandbox without aborting the launching agent run cannot automatically stop its background jobs; use `bg_kill` or `/reap`.

### Programmatic results

Tools declare output schemas, so codemode receives objects rather than model-facing text. Foreground `bash` retains Pi's native result, including `output`, `exit_code`, and `truncated`. A backgrounded `bash` returns a job object instead.

Job objects contain `id`, `command`, `log`, `status`, `exit_code`, `wall_time_seconds`, `output`, and `output_truncated`. Status is `running`, `exited`, `killed`, or `failed`; `exit_code` is null unless an exit code is available. `log` is a file path for file capture and null for memory capture. `output` is the combined stdout/stderr text included in the result: `bg_status` with an id and `bg_wait` include the captured tail, while `bg_run`, stop, and listing results leave it empty. A capture-read failure returns an explicit diagnostic and sets `output_truncated`.

`bg_status` returns `{ jobs: [...] }`, with one job when an id is supplied. `bg_wait` returns a job plus `wait_timed_out`. `bg_kill` returns a job plus `stop_requested`; a stop request does not prove termination. Wait for terminal status to inspect the outcome.

```javascript
const result = await tools.bash({ command: "npm test", timeout: 1 });
if ("id" in result) {
  const waited = await tools.bg_wait({ id: result.id, timeout: 10 });
  text(waited);
} else {
  text(result);
}
```

## License

MIT. See [LICENSE](LICENSE) for the original copyright and permission notice.
