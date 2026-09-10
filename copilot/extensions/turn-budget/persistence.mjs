import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const STATE_SNAPSHOT_PATTERN =
  /^state\.(\d{20})\.(\d{16})\.([A-Za-z0-9._-]+)\.json$/;
const STATE_GENERATION_CLAIM_PATTERN = /^generation\.(\d{20})\.claim$/;
const RETAINED_STATE_SNAPSHOTS = 3;
const STATE_READ_ATTEMPTS = 3;

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(path, value, instanceId) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${instanceId}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await retryTransientFileLock(() => rename(temporaryPath, path));
}

export async function writeJsonExclusive(path, value, instanceId) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${instanceId}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  try {
    await retryTransientFileLock(() => link(temporaryPath, path));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    try {
      await retryTransientFileLock(() => rm(temporaryPath, { force: true }));
    } catch (error) {
      if (!isTransientFileLock(error)) {
        throw error;
      }
    }
  }
}

export async function readLatestState(root) {
  let sawSnapshots = false;

  for (let attempt = 1; attempt <= STATE_READ_ATTEMPTS; attempt += 1) {
    const snapshots = await listStateSnapshots(root);
    if (snapshots === null) {
      return null;
    }
    if (snapshots.length === 0) {
      if (!sawSnapshots) {
        return readJsonIfExists(join(root, "state.json"));
      }
      continue;
    }

    sawSnapshots = true;
    for (const snapshot of snapshots) {
      try {
        const value = JSON.parse(
          await readFile(join(root, snapshot.name), "utf8"),
        );
        if (
          value?.extensionGeneration !== snapshot.generation ||
          !Number.isSafeInteger(value?.revision) ||
          value.revision < 0 ||
          String(value.revision).padStart(16, "0") !== snapshot.revision ||
          value?.extensionInstanceId !== snapshot.instanceId
        ) {
          throw new TypeError("State snapshot identity does not match its contents");
        }
        return value;
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
  }

  throw new Error("State snapshots changed too quickly to read");
}

export async function allocateStateGeneration(root) {
  await mkdir(root, { recursive: true });

  for (;;) {
    const entries = await readdir(root, { withFileTypes: true });
    const generations = entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const snapshot = STATE_SNAPSHOT_PATTERN.exec(entry.name);
        if (snapshot) {
          return [snapshot[1]];
        }

        const claim = STATE_GENERATION_CLAIM_PATTERN.exec(entry.name);
        return claim ? [claim[1]] : [];
      });
    const latest = generations.toSorted().at(-1) ?? "00000000000000000000";
    const generation = (BigInt(latest) + 1n).toString().padStart(20, "0");
    if (generation.length > 20) {
      throw new Error("State generation space is exhausted");
    }

    let claim;
    try {
      claim = await open(join(root, `generation.${generation}.claim`), "wx");
      return generation;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    } finally {
      await claim?.close();
    }
  }
}

export async function writeStateSnapshot(
  root,
  value,
  instanceId,
  extensionGeneration,
) {
  if (
    !Number.isSafeInteger(value?.revision) ||
    value.revision < 0 ||
    typeof extensionGeneration !== "string" ||
    !/^\d{20}$/.test(extensionGeneration) ||
    value.extensionGeneration !== extensionGeneration ||
    !/^[A-Za-z0-9._-]+$/.test(instanceId) ||
    value.extensionInstanceId !== instanceId
  ) {
    throw new TypeError("State snapshot requires a valid identity");
  }

  const revision = String(value.revision).padStart(16, "0");
  const snapshotPath = join(
    root,
    `state.${extensionGeneration}.${revision}.${instanceId}.json`,
  );
  await writeJsonAtomic(snapshotPath, value, instanceId);
  await removeOldStateFiles(root);
}

export function getHistoryPath(root, recordId) {
  if (!/^[A-Za-z0-9._-]+$/.test(recordId)) {
    throw new TypeError(`Unsafe history record ID: ${recordId}`);
  }

  return join(root, "history", `${recordId}.json`);
}

export function getHistoryCandidatePath(
  root,
  recordId,
  usedNanoAiu,
  instanceId,
) {
  if (
    !/^[A-Za-z0-9._-]+$/.test(recordId) ||
    !Number.isSafeInteger(usedNanoAiu) ||
    usedNanoAiu < 0 ||
    !/^[A-Za-z0-9._-]+$/.test(instanceId)
  ) {
    throw new TypeError("History candidate requires a valid identity");
  }

  return join(
    root,
    "history",
    ".candidates",
    recordId,
    `${String(usedNanoAiu).padStart(16, "0")}.${instanceId}.json`,
  );
}

export async function retryTransientFileLock(
  operation,
  { attempts = 6, delayMilliseconds = 50 } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileLock(error) || attempt >= attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
  }
}

async function removeOldStateFiles(root) {
  const snapshots = (await listStateSnapshots(root)) ?? [];
  const obsolete = snapshots
    .slice(RETAINED_STATE_SNAPSHOTS)
    .map((entry) => entry.name);

  for (const name of obsolete) {
    try {
      await rm(join(root, name), { force: true });
    } catch (error) {
      if (!isTransientFileLock(error)) {
        throw error;
      }
    }
  }
}

async function listStateSnapshots(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      match: STATE_SNAPSHOT_PATTERN.exec(entry.name),
    }))
    .filter((entry) => entry.match)
    .map((entry) => ({
      name: entry.name,
      generation: entry.match[1],
      revision: entry.match[2],
      instanceId: entry.match[3],
    }))
    .sort(
      (left, right) =>
        right.generation.localeCompare(left.generation) ||
        right.revision.localeCompare(left.revision) ||
        right.name.localeCompare(left.name),
    );
}

function isTransientFileLock(error) {
  return (
    error?.code === "EACCES" ||
    error?.code === "EBUSY" ||
    error?.code === "EPERM"
  );
}
