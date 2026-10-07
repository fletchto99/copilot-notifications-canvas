import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";

export const ownerPattern = /^owner-([1-9]\d*)-[a-f0-9-]{36}$/;

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function acquireLock(path, { label = "notification", alive = processAlive } = {}) {
  const candidate = await mkdtemp(`${path}-candidate-`);
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let acquired = false;
  try {
    await writeFile(`${candidate}/${owner}`, "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // A nonempty directory publishes ownership atomically, even if the process crashes.
        await rename(candidate, path);
        acquired = true;
        return async () => {
          await removeFile(`${path}/${owner}`);
          try {
            await rmdir(path);
          } catch (error) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
          }
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      }
      let entries;
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing an unrecognized ${label} lock.`);
        entries = await readdir(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!entries.length) {
        try {
          await rmdir(path);
        } catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        }
        continue;
      }
      const match = entries.length === 1 && entries[0].match(ownerPattern);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Refusing an unrecognized ${label} lock.`);
      if (alive(Number(match[1]))) return null;
      // Never remove a replacement owner's uniquely named file.
      await removeFile(`${path}/${entries[0]}`);
    }
    throw new Error(`The ${label} lock changed concurrently. Retry shortly.`);
  } finally {
    if (!acquired) {
      await removeFile(`${candidate}/${owner}`);
      await rmdir(candidate);
    }
  }
}
