import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = "github-notifications";
const marker = ".copilot-notifications-install.json";
const updateFiles = ["updates.mjs", "version.json"];
const files = ["extension.mjs", "github.mjs", "inbox.mjs", "batch.mjs", "model.mjs", "server.mjs", "app.mjs", "sound.mjs", "settings.mjs", "startup.mjs", "index.html", "styles.css", ...updateFiles];
const source = fileURLToPath(new URL("../.github/extensions/github-notifications/", import.meta.url));
const hash = content => createHash("sha256").update(content).digest("hex");

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyOwned(target) {
  const stat = await exists(target);
  if (!stat) return new Map();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to replace a non-directory or symlink.");
  const entries = await readdir(target);
  if (entries.includes("artifacts") && !(await lstat(join(target, "artifacts"))).isDirectory()) {
    throw new Error("Refusing a symlink or non-directory artifacts location.");
  }
  const runtimeEntries = entries.filter(file => file !== "artifacts");
  if (!runtimeEntries.length) return new Map();
  const legacyAdditions = ["settings.mjs", "startup.mjs", ...(entries.includes("sound.mjs") ? [] : ["sound.mjs"])];
  const versionedFiles = updateFiles.some(file => entries.includes(file)) ? files : files.filter(file => !updateFiles.includes(file));
  const priorFiles = entries.includes("batch.mjs") ? versionedFiles : versionedFiles.filter(file => file !== "batch.mjs");
  const installedFiles = entries.includes("startup.mjs") ? priorFiles : priorFiles.filter(file => !legacyAdditions.includes(file));
  if (runtimeEntries.length !== installedFiles.length + 1 || runtimeEntries.some(file => ![...installedFiles, marker].includes(file))) {
    throw new Error("Refusing to overwrite an unrelated or incomplete extension directory.");
  }
  for (const file of [...installedFiles, marker]) {
    if (!(await lstat(join(target, file))).isFile()) throw new Error("Refusing to overwrite non-regular files.");
  }
  let manifest;
  const manifestText = await readFile(join(target, marker), "utf8");
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Refusing to replace an extension without a valid installer ownership marker.");
  }
  if (manifest.name !== name || manifest.version !== 1) throw new Error("Unrecognized installer ownership marker.");
  if (Object.keys(manifest.hashes ?? {}).length !== installedFiles.length ||
      installedFiles.some(file => !Object.hasOwn(manifest.hashes ?? {}, file))) {
    throw new Error("Refusing to replace an incomplete or unrecognized installation.");
  }
  for (const file of installedFiles) {
    if (hash(await readFile(join(target, file))) !== manifest.hashes?.[file]) {
      throw new Error("Installed files were modified. Preserve your changes and move that directory before reinstalling.");
    }
  }
  return new Map([...installedFiles.map(file => [file, manifest.hashes[file]]), [marker, hash(manifestText)]]);
}

async function removeOwnedDirectory(path) {
  for (const file of await readdir(path)) await unlink(join(path, file));
  await rmdir(path);
}

async function acquireInstallLock(parent) {
  const lockPath = join(parent, ".github-notifications-install-lock");
  const candidate = await mkdtemp(join(parent, ".github-notifications-lock-"));
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let acquired = false;
  try {
    await writeFile(join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Publish a nonempty directory atomically, so even a crashed owner has an identity.
        await rename(candidate, lockPath);
        acquired = true;
        return async () => {
          await unlink(join(lockPath, owner));
          try {
            await rmdir(lockPath);
          } catch (error) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
          }
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      }
      const stat = await exists(lockPath);
      if (!stat) continue;
      if (!stat.isDirectory()) throw new Error("Refusing an unrecognized installer lock.");
      const entries = await readdir(lockPath);
      if (!entries.length) continue;
      const match = entries.length === 1 && entries[0].match(/^owner-([1-9]\d*)-[a-f0-9-]{36}$/);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Refusing an unrecognized installer lock.");
      try {
        process.kill(Number(match[1]), 0);
        throw new Error("Another notification installation is running. Retry when it finishes.");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      // Remove only the dead owner's unique file. A replacement owner's file is never touched.
      try {
        await unlink(join(lockPath, entries[0]));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new Error("The installer lock changed concurrently. Retry installation.");
  } finally {
    if (!acquired) await removeOwnedDirectory(candidate);
  }
}

async function fileHash(path) {
  const stat = await exists(path);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error("Refusing to replace a non-regular runtime file.");
  return hash(await readFile(path));
}

function sameRuntime(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}

export async function install(home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
  const target = resolve(home, "extensions", name);
  await mkdir(dirname(target), { recursive: true });
  const release = await acquireInstallLock(dirname(target));
  let stage;
  let backup;
  let keepBackup = false;
  try {
    const previous = await verifyOwned(target);
    stage = await mkdtemp(join(dirname(target), ".github-notifications-stage-"));
    backup = await mkdtemp(join(dirname(target), ".github-notifications-backup-"));
    const hashes = {};
    for (const file of files) {
      await copyFile(join(source, file), join(stage, file));
      hashes[file] = hash(await readFile(join(stage, file)));
    }
    await writeFile(join(stage, marker), `${JSON.stringify({ name, version: 1, hashes }, null, 2)}\n`);
    const staged = new Map([...Object.entries(hashes), [marker, await fileHash(join(stage, marker))]]);
    for (const [file, digest] of previous) {
      await copyFile(join(target, file), join(backup, file));
      if (await fileHash(join(backup, file)) !== digest) throw new Error("Installed files changed during backup.");
    }
    if (!sameRuntime(previous, await verifyOwned(target))) throw new Error("Installed files changed during installation.");
    await mkdir(target, { recursive: true });
    const touched = [];
    try {
      // Keep target/artifacts stable for settings writers, including already-running older providers.
      for (const file of [...files.filter(file => file !== "extension.mjs"), "extension.mjs", marker]) {
        if (await fileHash(join(target, file)) !== previous.get(file)) throw new Error("Installed files changed during publication.");
        touched.push(file);
        await rename(join(stage, file), join(target, file));
      }
    } catch (error) {
      for (const file of new Set([...touched].reverse().concat([...previous.keys()]))) {
        try {
          const current = await fileHash(join(target, file));
          if (current === previous.get(file)) continue;
          if (current !== undefined && current !== staged.get(file)) throw new Error("Runtime changed during rollback.");
          if (previous.has(file)) await rename(join(backup, file), join(target, file));
          else if (current !== undefined) await unlink(join(target, file));
        } catch {
          keepBackup = true;
        }
      }
      if (keepBackup) throw new Error(`Installation failed and rollback needs attention. Unrestored runtime files remain in ${backup}.`, { cause: error });
      throw error;
    }
  } finally {
    try {
      if (stage) await removeOwnedDirectory(stage);
      if (backup && !keepBackup) await removeOwnedDirectory(backup);
    } finally {
      await release();
    }
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`Installed extension source in ${await install()}\nReload extensions in Copilot to activate it.\n`);
  } catch (error) {
    process.stderr.write(`Installation stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
