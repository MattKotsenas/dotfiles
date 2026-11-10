# Delegation resource benchmark

Compare the warm delegation implementation at **`b8c9d4d`** with a candidate that closes child runtimes after each result. Each sample runs in a fresh Node SDK worker. The model is the existing deterministic acceptance provider: Pi, delegation and codemode are real; no LLM requests are sent. Supplied MCP configuration starts real connection attempts. The `mcp-discovery` scenario additionally verifies namespace readiness.

Run from the repository root with Node 24+ and the installed `pi/node_modules` dependencies. `PI_SDK_ROOT` selects another SDK installation, just as in the delegation tests. Use the same SDK, Node version, MCP configuration and environment for both labels.

## Prepare the baseline

The benchmark does not treat the working tree as the baseline. Supply an entry from an archived `b8c9d4d` source tree, keeping delegation's relative imports and Node dependency resolution intact. In Bash (including Git Bash), from the repository root:

```bash
baseline=$(mktemp -d "$PWD/pi/.resource-benchmark-baseline-XXXXXX")
git archive --format=tar --output="$baseline/source.tar" b8c9d4d \
  pi/agent/extensions/delegation pi/agent/extensions/shared
tar -xf "$baseline/source.tar" -C "$baseline"
rm "$baseline/source.tar"
baseline_entry="$baseline/pi/agent/extensions/delegation/index.ts"
```

Keeping this snapshot below the working tree's `pi` directory lets Node find the installed `pi/node_modules` without copying packages or altering the checkout. There is no branch switch or stash. A separately prepared source tree with compatible relative imports and dependencies also works.

`fixture(t, { entry })` must honor the optional entry override. The benchmark checks the fixture's configured entry before starting any children and fails if an older fixture silently ignores the option. The default entry is the working tree's `pi/agent/extensions/delegation/index.ts`.

## Run the comparison

Use trusted, deliberately selected MCP configuration and credentials. These commands start the configured servers and contact their endpoints. Substitute your own paths; the benchmark does not discover or read live user configuration by default.

```bash
node pi/tests/delegation/resource-benchmark.mjs \
  --label baseline-b8c9d4d --entry "$baseline_entry" --samples 5 \
  --mcp-config /absolute/path/to/benchmark-mcp.json \
  --mcp-auth /absolute/path/to/benchmark-mcp-auth.json \
  > resource-benchmark-baseline.jsonl

node pi/tests/delegation/resource-benchmark.mjs \
  --label dehydrated --samples 5 \
  --mcp-config /absolute/path/to/benchmark-mcp.json \
  --mcp-auth /absolute/path/to/benchmark-mcp-auth.json \
  > resource-benchmark-dehydrated.jsonl
```

`--label` is required. `--entry`, `--samples` (default 3), `--scenario` (default `mcp-discovery`), `--response-delay-ms` (default 0), `--mcp-config` and `--mcp-auth` are optional. Omit `--mcp-auth` for servers that do not need stored MCP OAuth credentials. Supplying auth requires explicit config. Omitting config runs a `no-mcp-control`, which tests the harness but provides no evidence about real MCP resource use. Disabled servers are counted but not started. In `mcp-discovery`, every enabled server must expose at least one discoverable tool; resource-only or fully hidden servers fail the readiness check rather than being reported as ready.

Keep MCP stdio paths absolute. Relative paths resolve in the isolated fixture workspace, not the original project. Environment and executable resolution are inherited. Configuration expressions such as `!command` still execute, and configured absolute working directories still apply. The benchmark does not sandbox arbitrary server commands or prevent their external effects.

The parent fixture loads only its existing codemode factory, without MCP. A child-only diagnostic extension is installed after parent setup. A separate memory-control child first receives `Remember this word: violet` with `tools: []` and a replacement system prompt, then recalls `MEMORY:violet` through the same handle. This runs before MCP config is installed because MCP can auto-activate codemode, which would violate the acceptance provider's strict zero-declared-tool assertion. The supplied config and optional auth file are then copied into the temporary agent directory. Every scenario uses fixture tool defaults, not an explicit tool allowlist that would hide MCP tools. In the default `mcp-discovery` scenario, the initial call and two same-handle follow-ups each run real codemode, describe every configured `mcp__...` namespace, verify nonempty discovery, and reach a resource checkpoint. Every scripted codemode turn finishes with `PARENT_DONE`; successful final text alone is insufficient, so child tool errors and checkpoint completion are checked separately.

Use `--scenario echo` for a fixed text response with no child tool calls, or `--scenario local-codemode` for a script that only prints `LOCAL_ONLY`. Both assert the actual child tool results: none for echo, exactly codemode with its expected output for the local script. MCP remains configured and Pi starts connections in the background. Neither workload explicitly waits for or verifies server readiness; Pi's normal startup rules still apply. The model requests no MCP discovery or MCP tool execution. These cases measure return latency, not MCP readiness; a very short turn can close servers while they are still starting. Compare with the same scenario without `--mcp-config` to isolate the no-server control.

`--response-delay-ms 1000` adds a fixed one-second delay to each synthetic child model response, not the parent. Echo has one response per call; codemode has two. This lets background MCP startup overlap model work without sending real LLM requests. The configured delay is a minimum timer delay, not a measured network latency; compare matched settings and do not subtract it as an exact duration.

Alternate baseline/candidate runs if network, filesystem caches or machine load drift. Samples are serial. Compare individual records or medians across matched labels; do not interpret a single run as a performance guarantee.

## Read the JSON

Stdout is JSON Lines, one object per completed sample. Exit status is nonzero on a failed check or failed cleanup, and subsequent samples stop. Worker stdout/stderr are suppressed because SDK and MCP diagnostics can contain credentials. Error records retain the stage, error name/code, and tool-error identities, never raw MCP error text, arguments, URLs, headers, tool schemas or auth contents. This limits failure detail deliberately; reproduce connection problems separately with the native MCP diagnostics and an appropriate secret-handling policy.

Each record includes:

- `scenario` and `responseDelayMs` identify the workload and synthetic child-response delay. `calls` contains `memory-initial`, `memory-followup`, then the selected scenario's initial call and two follow-ups. `toolResults` records child tool names, error flags and whether local-only output was observed, without storing raw tool output. `totalMs` measures the entire fixture `invoke`, including parent codemode overhead and the diagnostic checkpoint. The end timestamp is captured before result validation; `resultChecksMs` records that validation separately. The following retained-resource snapshot is also excluded. `probeMs` is the checkpoint's collection cost; `totalMinusProbeMs` subtracts it for a less intrusive comparison. Subtraction cannot undo scheduling, cache or GC effects from instrumentation.
- `turnEndMs` marks the child's `agent_end` event relative to invocation start. `afterTurnMs` measures from that event to invocation completion, including runtime shutdown, accounting and the parent wrapper; it is not an isolated MCP-close duration.
- `requestStart`: the first child synthetic-provider `streamSimple` entry, identified by its session ID through the discovered lifecycle extension. It contains epoch and process-local monotonic timestamps. `toFirstRequestMs` separates child initialization from later tool/readiness work, but still includes the parent's dispatch overhead. This is a model-entry measurement, not an HTTP request or the SDK's `before_provider_request` event, which the synthetic provider does not send.
- `readyMs` and `ready`: time to verified namespace discovery before the process probe, namespace/tool counts, and resources sampled while the MCP child is still live. The first model request need not wait for background MCP initialization; `readyMs` measures that later boundary.
- `afterResult`, `beforeCleanup`, `afterCleanup`: retained resources and observed live child runtimes. `host.nodeMemory` describes the running Node SDK host, including all its sessions and codemode threads. `host.osProcess` describes that host's OS process. `spawned` lists its owned descendant processes, including MCP launchers, servers and console hosts, with PID/parent PID and creation time. The SDK offers no per-server PID attribution. Codemode worker threads are not separate processes.
- On Windows, each process has working-set bytes, private bytes, actual handle count and actual thread count from bounded PowerShell `Get-CimInstance`/`Get-Process` collection. The probe process is excluded. Metrics that cannot be read are null with `metricsError`; unavailable collection is explicit, never a zero-resource claim. Other platforms report process metrics unavailable while retaining Node host measurements. Working sets can share pages, and host memory need not fall immediately after session disposal or GC.
- `directory`: actual fixture directory deletion after awaited normal `session_shutdown` and disposal, plus the observed no-live-runtime condition. `worker` records natural worker exit; `afterWorkerExit` checks previously observed descendants again using creation times to avoid PID reuse. `directoryAfterWorkerExit` catches late directory recreation before final owned-temp cleanup. Directory removal alone is not proof that a process exited.

Snapshots are point-in-time observations, not continuous process tracing. They may miss short-lived launchers, detached/reparented processes that escape observation before the first checkpoint, or resources remote HTTP servers retain. Known descendant identities remain tracked across snapshots even if their parent exits. No broad process search-and-kill is used. A successful record with unavailable OS metrics is a functional result, not a verified process-release result.

## State and cleanup

The benchmark never writes supplied config/auth files or the caller's sessions. It uses isolated fixture directories and clears inherited parent session identifiers in each SDK worker. Normal shutdown is awaited, extension errors are recorded, and only owned temporary directories are removed. A worker that does not exit within 180 seconds receives an abort request and 30 seconds of grace. If it still cannot shut down, the benchmark reports its PID and retains its directories rather than killing a host underneath its servers. Inspect that owned process and its descendants manually; do not stop unrelated Pi or MCP processes.

Use dedicated benchmark credentials when OAuth refresh can rotate refresh tokens. Copying an auth file protects the local source file, but cannot prevent an authorization server from invalidating the original token when the copy refreshes. Server commands may also use their own external credential stores. Do not use shared live credentials if those side effects would disrupt another session.

After both benchmark commands have completed and their workers have exited, remove only the snapshot directory created above:

```bash
rm -rf -- "$baseline"
```

The benchmark deliberately leaves the supplied entry tree and JSONL output files alone.

## Harness checks without user MCP servers

```bash
node --check pi/tests/delegation/resource-benchmark.mjs
node --check pi/tests/delegation/resource-benchmark-probe.mjs
node pi/tests/delegation/resource-benchmark.mjs --help
node pi/tests/delegation/resource-benchmark.mjs --label no-mcp-smoke --samples 1
```

For process/discovery checks without real credentials, point `--mcp-config` at a disposable local stdio MCP server that implements `initialize` and `tools/list` with at least one tool. Warm baseline checkpoints should show the same server process on follow-ups; a dehydrated candidate should release it after each result and reconnect on the next call. Verify actual JSON metrics rather than assuming either implementation has that behavior. A nonexistent server executable is a useful negative control: the sample must fail readiness and still clean up its fixture.
