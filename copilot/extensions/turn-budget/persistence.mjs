import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

export function getHistoryPath(root, recordId) {
  if (!/^[A-Za-z0-9._-]+$/.test(recordId)) {
    throw new TypeError(`Unsafe history record ID: ${recordId}`);
  }

  return join(root, "history", `${recordId}.json`);
}

export async function retryTransientFileLock(
  operation,
  { attempts = 6, delayMilliseconds = 50 } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const isTransient =
        error?.code === "EACCES" ||
        error?.code === "EBUSY" ||
        error?.code === "EPERM";

      if (!isTransient || attempt >= attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
  }
}
