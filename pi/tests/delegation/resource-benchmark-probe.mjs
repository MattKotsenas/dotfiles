import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import acceptanceProvider from "./provider.mjs";
import { Type } from "./sdk.mjs";

export const probe = {
  requests: [],
  ready: [],
  errors: [],
  toolResults: [],
  turnEnds: [],
  live: new Set(),
  snapshot: undefined,
  responseDelayMs: 0,
};

// Keep the existing deterministic model, including its zero-tool memory assertion.
export default function provider(pi) {
  acceptanceProvider(
    {
      ...pi,
      registerProvider(value) {
        pi.registerProvider({
          ...value,
          streamSimple(...args) {
            probe.requests.push({
              epochMs: Date.now(),
              monotonicMs: performance.now(),
              child: probe.live.has(args[2]?.sessionId),
            });
            return value.streamSimple(...args);
          },
        });
      },
    },
    { responseDelayMs: probe.responseDelayMs },
  );
}

// Installed through discovery only after the parent has loaded its extensions.
export function lifecycle(pi) {
  pi.on("session_start", (_event, ctx) => {
    probe.live.add(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    probe.live.delete(ctx.sessionManager.getSessionId());
  });
  pi.on("agent_end", () => {
    probe.turnEnds.push(performance.now());
  });
  pi.on("tool_result", (event) => {
    const message = (event.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    probe.toolResults.push({
      tool: event.toolName,
      isError: !!event.isError,
      localOnlyOutput: message.includes("LOCAL_ONLY"),
    });
    if (event.isError) {
      probe.errors.push({
        tool: event.toolName,
        kind: "tool-result-error",
        readinessFailed: message.includes("MCP_NOT_READY"),
      });
    }
  });
  pi.registerTool({
    name: "resource_benchmark_ready",
    label: "Resource benchmark readiness checkpoint",
    description: "Record MCP discovery and sample benchmark-owned processes, without calling server tools.",
    exposure: "codemode",
    parameters: Type.Object({
      servers: Type.Array(Type.Object({ namespace: Type.String(), tools: Type.Number() })),
    }),
    async execute(_id, args) {
      const readyAtMs = performance.now();
      const resources = await probe.snapshot();
      probe.ready.push({ servers: args.servers, readyAtMs, resources, probeMs: performance.now() - readyAtMs });
      return { content: [{ type: "text", text: "READINESS_RECORDED" }] };
    },
  });
}

// No command lines, environment blocks, URLs or credentials leave PowerShell.
// Track creation times as well as PIDs, so a reused PID is not an owned process.
export function processSnapshot(rootPid, known = []) {
  if (process.platform !== "win32") {
    return { status: "unavailable", reason: "Windows CIM/Get-Process metrics only", processes: [] };
  }
  const identities = JSON.stringify(known.map(({ pid, created }) => ({ pid, created })));
  const script = `
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Select-Object ProcessId,ParentProcessId,CreationDate,Name)
$known = @('${identities}' | ConvertFrom-Json)
$owned = @{}
foreach ($p in $all) {
  $created = $p.CreationDate.ToUniversalTime().ToString('o')
  if ($p.ProcessId -eq ${rootPid} -or @($known | Where-Object { $_.pid -eq $p.ProcessId -and $_.created -eq $created }).Count -gt 0) {
    $owned[[int]$p.ProcessId] = $p.CreationDate
  }
}
do {
  $changed = $false
  foreach ($p in $all) {
    if ($p.ProcessId -ne $PID -and -not $owned.ContainsKey([int]$p.ProcessId) -and $owned.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -ge $owned[[int]$p.ParentProcessId]) {
      $owned[[int]$p.ProcessId] = $p.CreationDate
      $changed = $true
    }
  }
} while ($changed)
$rows = @(foreach ($p in $all) {
  if (-not $owned.ContainsKey([int]$p.ProcessId) -or $p.ProcessId -eq $PID) { continue }
  $row = [ordered]@{ pid=[int]$p.ProcessId; ppid=[int]$p.ParentProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o'); name=$p.Name; workingSetBytes=$null; privateBytes=$null; handles=$null; threads=$null; metricsError=$null }
  try {
    $g = Get-Process -Id $p.ProcessId -ErrorAction Stop
    $row.workingSetBytes = $g.WorkingSet64
    $row.privateBytes = $g.PrivateMemorySize64
    $row.handles = $g.HandleCount
    $row.threads = $g.Threads.Count
  } catch { $row.metricsError = 'Get-Process unavailable (exited or access denied)' }
  [pscustomobject]$row
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      status: "unavailable",
      reason: "CIM/Get-Process collection failed",
      code: result.error?.code ?? result.status,
      processes: [],
    };
  }
  try {
    const processes = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
    return { status: "ok", processes: Array.isArray(processes) ? processes : [processes] };
  } catch {
    return { status: "unavailable", reason: "Invalid CIM/Get-Process JSON", processes: [] };
  }
}
