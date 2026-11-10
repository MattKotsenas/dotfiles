import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const file = fileURLToPath(import.meta.url);
const here = dirname(file);
const defaultEntry = resolve(here, "../../agent/extensions/delegation/index.ts");
const helper = new URL("./resource-benchmark-probe.mjs", import.meta.url).href;
const safeError = (error) => ({ name: error?.name ?? "Error", code: error?.code ?? null });

async function missing(path) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function worker(options) {
  const { fixture, invoke, answer } = await import("./fixture.mjs");
  const { version } = await import("./sdk.mjs");
  const { probe, processSnapshot } = await import(helper);
  const report = {
    label: options.label,
    sample: options.sample,
    entry: options.entry,
    scenario: options.scenario,
    responseDelayMs: options.responseDelayMs,
    sdkVersion: version,
    nodeVersion: process.version,
    pid: process.pid,
    status: "failed",
    calls: [],
    errors: [],
  };
  const callbacks = [];
  const known = new Map();
  let parent;
  let root;
  let stage = "fixture";
  let stopping = false;
  process.on("message", (message) => {
    if (message?.type !== "stop") return;
    stopping = true;
    void parent?.abort().catch(() => report.errors.push({ stage: "abort", kind: "abort-failed" }));
  });
  const snapshot = () => {
    const os = processSnapshot(process.pid, [...known.values()]);
    for (const row of os.processes) known.set(`${row.pid}:${row.created}`, row);
    return {
      epochMs: Date.now(),
      liveChildRuntimes: probe.live.size,
      host: {
        pid: process.pid,
        nodeMemory: process.memoryUsage(),
        osProcess: os.processes.find((row) => row.pid === process.pid) ?? null,
      },
      spawned: os.processes.filter((row) => row.pid !== process.pid),
      metricsStatus: os.status,
      metricsUnavailable: os.status === "ok" ? null : os,
    };
  };
  probe.snapshot = snapshot;
  try {
    const setup = await fixture(
      { after: (callback) => callbacks.push(callback) },
      {
        entry: options.entry,
        providerModule: join(here, "resource-benchmark-probe.mjs"),
      },
    );
    parent = setup.parent;
    // Parent provider is already registered with zero delay; only new children inherit this delay.
    probe.responseDelayMs = options.responseDelayMs;
    const agentDir = dirname(setup.authPath);
    root = dirname(agentDir);
    process.send({ type: "fixture", root });
    // Fail rather than silently benchmarking the candidate when an older fixture ignores entry.
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    stage = "entry-selection";
    assert.equal(
      resolve(settings.extensions[0]),
      options.entry,
      "fixture(t, { entry }) must select the requested source",
    );
    parent.extensionRunner.onError(({ event }) => report.errors.push({ stage: "extension", event }));
    await writeFile(
      join(agentDir, "extensions/resource-benchmark-lifecycle.ts"),
      `export { lifecycle as default } from ${JSON.stringify(helper)};\n`,
    );
    report.beforeChildren = snapshot();
    assert.equal(report.beforeChildren.spawned.length, 0, "fixture parent must not spawn MCP servers");

    async function call(kind, args, expected, readiness = false) {
      stage = kind;
      if (stopping) throw new Error("Benchmark stopped");
      const requestOffset = probe.requests.length;
      const readyOffset = probe.ready.length;
      const errorOffset = probe.errors.length;
      const toolOffset = probe.toolResults.length;
      const turnOffset = probe.turnEnds.length;
      const start = performance.now();
      const startedAtEpochMs = Date.now();
      let result;
      let finished;
      try {
        result = await invoke(parent, args);
        finished = performance.now();
        assert.equal(answer(result), expected);
        assert.equal(probe.errors.length, errorOffset, "child codemode must succeed, not merely return PARENT_DONE");
        assert(
          probe.requests.slice(requestOffset).some((request) => request.child),
          "child provider boundary must be observed",
        );
        assert.equal(probe.turnEnds.length, turnOffset + 1, "exactly one child turn must complete");
        const toolResults = probe.toolResults.slice(toolOffset);
        if (kind.startsWith("echo-")) assert.deepEqual(toolResults, [], "echo must execute no child tools");
        if (kind.startsWith("local-codemode-")) {
          assert.deepEqual(
            toolResults.map(({ tool }) => tool),
            ["codemode"],
            "only local codemode may execute",
          );
          assert.equal(toolResults[0].localOnlyOutput, true, "local script must produce its expected output");
        }
        if (readiness) {
          assert.equal(probe.ready.length, readyOffset + 1, "child must reach the readiness checkpoint");
          assert.deepEqual(
            probe.ready.at(-1).servers.map((server) => server.namespace),
            report.namespaces,
          );
          assert(probe.ready.at(-1).servers.every((server) => server.tools > 0));
        }
        return result;
      } finally {
        const checked = performance.now();
        finished ??= checked;
        const requests = probe.requests.slice(requestOffset);
        // The parent also uses the scripted provider. Its first request precedes delegation;
        // children are identified by their discovered lifecycle extension below.
        const childRequests = requests.filter((request) => request.child);
        const ready = probe.ready.slice(readyOffset);
        const probeMs = ready.reduce((sum, item) => sum + item.probeMs, 0);
        const turnEnd = probe.turnEnds.slice(turnOffset).at(-1);
        report.calls.push({
          kind,
          toolResults: probe.toolResults.slice(toolOffset),
          startedAtEpochMs,
          totalMs: finished - start,
          resultChecksMs: checked - finished,
          turnEndMs: turnEnd === undefined ? null : turnEnd - start,
          afterTurnMs: turnEnd === undefined ? null : finished - turnEnd,
          probeMs,
          totalMinusProbeMs: finished - start - probeMs,
          requestStart: childRequests[0] ?? null,
          requestStartSource: "synthetic provider streamSimple entry (no HTTP request)",
          toFirstRequestMs: childRequests[0] ? childRequests[0].monotonicMs - start : null,
          readyMs: ready[0] ? ready[0].readyAtMs - start : null,
          ready: ready.map(({ servers, resources }) => ({ servers, resources })),
          afterResult: snapshot(),
        });
      }
    }

    // Run the fixture provider's strict zero-declared-tool memory control before MCP is
    // installed. MCP's normal auto-activation of codemode would invalidate that control.
    stage = "memory";
    const memory = await call(
      "memory-initial",
      {
        prompt: "Remember this word: violet",
        tools: [],
        systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
      },
      "REMEMBERED",
    );
    await call(
      "memory-followup",
      { handle: memory.details.handle, prompt: "What word did I ask you to remember?" },
      "MEMORY:violet",
    );

    stage = "mcp-config";
    if (options.mcpConfig) {
      await copyFile(options.mcpConfig, join(agentDir, "mcp.json"));
      await chmod(join(agentDir, "mcp.json"), 0o600);
    } else {
      await writeFile(join(agentDir, "mcp.json"), '{"mcpServers":{}}', { mode: 0o600 });
    }
    if (options.mcpAuth) {
      await copyFile(options.mcpAuth, join(agentDir, "mcp-auth.json"));
      await chmod(join(agentDir, "mcp-auth.json"), 0o600);
    }
    const config = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
    assert(config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers));
    const enabled = Object.entries(config.mcpServers).filter(([, value]) => value.enabled !== false);
    report.namespaces = enabled.map(([name]) => `mcp__${name.replaceAll("-", "_")}`);
    assert.equal(new Set(report.namespaces).size, report.namespaces.length, "MCP namespace names must be distinct");
    report.mcpMode = enabled.length ? "configured-mcp" : "no-mcp-control";
    report.disabledServers = Object.keys(config.mcpServers).length - enabled.length;
    const discoveries = report.namespaces
      .map(
        (namespace) => `{
      const found = await describeNamespace(${JSON.stringify(namespace)});
      if (!found || !found.tools.length) throw new Error("MCP_NOT_READY");
      servers.push({ namespace: ${JSON.stringify(namespace)}, tools: found.tools.length });
    }`,
      )
      .join("\n");
    const readiness = options.scenario === "mcp-discovery";
    const kind = readiness ? "mcp" : options.scenario;
    const prompt =
      options.scenario === "echo"
        ? "Remember this word: violet"
        : options.scenario === "local-codemode"
          ? 'ACCEPTANCE_CODE:text("LOCAL_ONLY");'
          : `ACCEPTANCE_CODE:const servers = [];\n${discoveries}\nawait tools.resource_benchmark_ready({ servers }); text("MCP_READY");`;
    const expected = options.scenario === "echo" ? "REMEMBERED" : "PARENT_DONE";
    const first = await call(`${kind}-initial`, { prompt }, expected, readiness);
    for (let index = 1; index <= 2; index++) {
      await call(`${kind}-followup-${index}`, { handle: first.details.handle, prompt }, expected, readiness);
    }
    report.status = "ok";
  } catch (error) {
    // MCP errors can contain headers, command arguments or tokens. Do not serialize them.
    report.errors.push({ stage, ...safeError(error) }, ...probe.errors);
  } finally {
    report.beforeCleanup = snapshot();
    stage = "cleanup";
    const start = performance.now();
    for (const callback of callbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        report.errors.push({ stage, ...safeError(error) });
      }
    }
    report.cleanupMs = performance.now() - start;
    report.afterCleanup = snapshot();
    report.directory = {
      removed: root ? await missing(root) : null,
      noLiveChildRuntimes: probe.live.size === 0,
      // Actual recursive deletion, not an open/close test or a platform-dependent rename.
      check: "fixture teardown rm after awaited session_shutdown",
    };
    report.childToolErrors = probe.errors;
    report.knownProcesses = [...known.values()];
    if (
      report.errors.length ||
      report.directory.removed === false ||
      probe.live.size ||
      report.afterCleanup.spawned.length
    )
      report.status = "failed";
  }
  process.send({ type: "result", report });
  process.disconnect();
}

async function sample(options) {
  const bootstrap = await mkdtemp(join(tmpdir(), "pi-resource-benchmark-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(bootstrap, "agent"), PI_OFFLINE: "1" };
  for (const key of ["PI_SESSION_FILE", "PI_SESSION_ID", "NODE_TEST_CONTEXT"]) delete env[key];
  let root;
  let report;
  const child = fork(file, ["--worker", JSON.stringify(options)], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const outcome = await new Promise((resolveOutcome) => {
    let grace;
    const deadline = setTimeout(() => {
      if (child.connected) child.send({ type: "stop" });
      grace = setTimeout(() => {
        // Do not kill the SDK host underneath transports, orphaning its servers. Report
        // the owned PID and leave its temp directories intact for manual diagnosis.
        if (child.connected) child.disconnect();
        child.unref();
        resolveOutcome({ exited: false, reason: "worker did not shut down within 180s + 30s grace", pid: child.pid });
      }, 30000);
    }, 180000);
    child.on("message", (message) => {
      if (message.type === "fixture") root = message.root;
      if (message.type === "result") report = message.report;
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      clearTimeout(grace);
      if (child.pid) {
        if (child.connected) child.disconnect();
        child.unref();
      }
      resolveOutcome({ exited: !child.pid, pid: child.pid, error: safeError(error) });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(grace);
      resolveOutcome({ exited: true, code, signal });
    });
  });
  const { processSnapshot } = await import(helper);
  const afterWorkerExit = processSnapshot(outcome.exited ? -1 : child.pid, report?.knownProcesses ?? []);
  const output = report ?? {
    label: options.label,
    sample: options.sample,
    entry: options.entry,
    status: "failed",
    errors: [{ stage: "worker", kind: "no-report" }],
  };
  output.worker = outcome;
  output.afterWorkerExit = afterWorkerExit;
  output.processScope =
    "Worker descendants, including MCP launchers/servers and console hosts; no per-server PID attribution. PowerShell probes excluded. Threads are counted separately.";
  if (outcome.exited) {
    // The SDK may finish background writes after fixture teardown. Only the worker's
    // own two temp roots are eligible, and never while an observed descendant lives.
    if (afterWorkerExit.status === "ok" && afterWorkerExit.processes.length > 0) {
      output.status = "failed";
      output.tempCleanup = "retained: observed processes still alive";
      output.retainedDirectories = [root, bootstrap].filter(Boolean);
    } else {
      output.directoryAfterWorkerExit = root ? { removed: await missing(root) } : null;
      if (output.directoryAfterWorkerExit?.removed === false) {
        output.status = "failed";
        output.errors.push({ stage: "post-exit-cleanup", kind: "fixture-directory-recreated" });
      }
      output.tempCleanup = "removed owned temporary directories after worker exit";
      for (const path of [root, bootstrap].filter(Boolean)) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (error) {
          output.status = "failed";
          output.errors.push({ stage: "post-exit-cleanup", ...safeError(error) });
          output.tempCleanup = "owned temporary directory removal failed";
        }
      }
    }
  } else {
    output.status = "failed";
    output.tempCleanup = "retained: worker still alive";
    output.retainedDirectories = [root, bootstrap].filter(Boolean);
  }
  if (outcome.code !== 0 || !outcome.exited || (afterWorkerExit.status === "ok" && afterWorkerExit.processes.length))
    output.status = "failed";
  delete output.knownProcesses;
  return output;
}

async function main() {
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      entry: { type: "string", default: defaultEntry },
      samples: { type: "string", default: "3" },
      scenario: { type: "string", default: "mcp-discovery" },
      "response-delay-ms": { type: "string", default: "0" },
      "mcp-config": { type: "string" },
      "mcp-auth": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node pi/tests/delegation/resource-benchmark.mjs --label NAME [--entry PATH] [--samples N] [--scenario echo|local-codemode|mcp-discovery] [--response-delay-ms N] [--mcp-config PATH] [--mcp-auth PATH]\nSee pi/tests/delegation/resource-benchmark.md. Output: one JSON object per sample.",
    );
    return;
  }
  assert(values.label?.trim(), "An explicit --label is required");
  const samples = Number(values.samples);
  assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be a positive integer");
  assert(!values["mcp-auth"] || values["mcp-config"], "--mcp-auth requires --mcp-config");
  assert(["echo", "local-codemode", "mcp-discovery"].includes(values.scenario), "Unknown --scenario");
  const responseDelayMs = Number(values["response-delay-ms"]);
  assert(
    Number.isSafeInteger(responseDelayMs) && responseDelayMs >= 0,
    "--response-delay-ms must be a nonnegative integer",
  );
  const options = {
    scenario: values.scenario,
    responseDelayMs,
    label: values.label,
    entry: resolve(values.entry),
    mcpConfig: values["mcp-config"] ? resolve(values["mcp-config"]) : undefined,
    mcpAuth: values["mcp-auth"] ? resolve(values["mcp-auth"]) : undefined,
  };
  await stat(options.entry);
  for (let index = 1; index <= samples; index++) {
    const result = await sample({ ...options, sample: index });
    console.log(JSON.stringify(result));
    if (result.status !== "ok") {
      process.exitCode = 1;
      break;
    }
  }
}

if (process.argv[2] === "--worker") {
  await worker(JSON.parse(process.argv[3]));
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    console.log(JSON.stringify({ status: "failed", stage: "arguments-or-coordinator", ...safeError(error) }));
    process.exitCode = 1;
  });
}
