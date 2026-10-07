import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock } from "../.github/extensions/github-notifications/lock.mjs";

const name = "github-notifications";
const marker = ".copilot-notifications-install.json";
const runtimeMarker = ".copilot-notifications-runtime.json";
const runtimeFolder = "runtimes";
const desktopFiles = ["desktop.mjs", "notifier.mjs", "lock.mjs"];
const updateFiles = ["updates.mjs", "version.json"];
const files = ["extension.mjs", "github.mjs", "inbox.mjs", "batch.mjs", "model.mjs", "server.mjs", "app.mjs", "settings.mjs", "startup.mjs", "index.html", "styles.css", ...desktopFiles, ...updateFiles];
const legacyFiles = ["sound.mjs"];
const source = fileURLToPath(new URL("../.github/extensions/github-notifications/", import.meta.url));
const hash = content => createHash("sha256").update(content).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const runtimeID = hashes => hash(JSON.stringify(Object.keys(hashes).sort().map(file => [file, hashes[file]])));
const loader = id => `await import("./${runtimeFolder}/${id}/extension.mjs");\n`;

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(path) {
  if (!(await exists(path))?.isFile()) throw new Error("Refusing an unrelated or incomplete ownership marker.");
  const text = await readFile(path, "utf8");
  try {
    return { data: JSON.parse(text), digest: hash(text) };
  } catch {
    throw new Error("Refusing to replace an extension without a valid installer ownership marker.");
  }
}

function validHashes(hashes) {
  return hashes && typeof hashes === "object" && !Array.isArray(hashes) &&
    Object.hasOwn(hashes, "extension.mjs") &&
    Object.entries(hashes).every(([file, digest]) => [...files, ...legacyFiles].includes(file) && validHash(digest));
}

async function verifyFiles(target, hashes, entries, ownershipFile) {
  const expected = [...Object.keys(hashes), ownershipFile];
  if (entries.length !== expected.length || entries.some(file => !expected.includes(file))) {
    throw new Error("Refusing to overwrite an unrelated or incomplete extension directory.");
  }
  for (const [file, digest] of Object.entries(hashes)) {
    if (await fileHash(join(target, file)) !== digest) {
      throw new Error("Installed files were modified. Preserve your changes and move that directory before reinstalling.");
    }
  }
}

async function verifyRuntime(path, id) {
  if (!(await exists(path))?.isDirectory()) throw new Error("Refusing a non-directory or symlink runtime.");
  const { data, digest } = await readManifest(join(path, runtimeMarker));
  if (!data || data.name !== name || data.version !== 1 || !validHashes(data.hashes) ||
      runtimeID(data.hashes) !== id) throw new Error("Unrecognized runtime ownership marker.");
  await verifyFiles(path, data.hashes, await readdir(path), runtimeMarker);
  return digest;
}

async function verifyRuntimes(target) {
  const directory = join(target, runtimeFolder);
  const stat = await exists(directory);
  if (!stat) return new Map();
  if (!stat.isDirectory()) throw new Error("Refusing a non-directory or symlink runtimes location.");
  const runtimes = new Map();
  for (const id of await readdir(directory)) {
    if (!validHash(id)) throw new Error("Refusing an unrecognized runtime directory.");
    runtimes.set(id, await verifyRuntime(join(directory, id), id));
  }
  return runtimes;
}

async function verifyOwned(target) {
  const stat = await exists(target);
  if (!stat) return { files: new Map(), runtimes: new Map() };
  if (!stat.isDirectory()) throw new Error("Refusing to replace a non-directory or symlink.");
  const entries = await readdir(target);
  if (entries.includes("artifacts") && !(await lstat(join(target, "artifacts"))).isDirectory()) {
    throw new Error("Refusing a symlink or non-directory artifacts location.");
  }
  const runtimes = await verifyRuntimes(target);
  const rootEntries = entries.filter(file => !["artifacts", runtimeFolder].includes(file));
  if (!rootEntries.length) return { files: new Map(), runtimes };
  const { data: manifest, digest } = await readManifest(join(target, marker));
  if (!manifest || manifest.name !== name || ![1, 2].includes(manifest.version) || !validHashes(manifest.hashes)) {
    throw new Error("Unrecognized installer ownership marker.");
  }
  if (manifest.version === 1) {
    const legacyAdditions = ["settings.mjs", "startup.mjs"];
    const knownFiles = [...files, ...legacyFiles.filter(file => entries.includes(file))];
    const versionedFiles = updateFiles.some(file => entries.includes(file)) ? knownFiles : knownFiles.filter(file => !updateFiles.includes(file));
    const priorDesktopFiles = desktopFiles.some(file => entries.includes(file)) ? versionedFiles : versionedFiles.filter(file => !desktopFiles.includes(file));
    const priorFiles = entries.includes("batch.mjs") ? priorDesktopFiles : priorDesktopFiles.filter(file => file !== "batch.mjs");
    const installedFiles = entries.includes("startup.mjs") ? priorFiles : priorFiles.filter(file => !legacyAdditions.includes(file));
    if (Object.keys(manifest.hashes).length !== installedFiles.length ||
        installedFiles.some(file => !Object.hasOwn(manifest.hashes, file))) {
      throw new Error("Refusing to replace an incomplete or unrecognized installation.");
    }
  } else if (!validHash(manifest.runtime) || !runtimes.has(manifest.runtime) ||
      manifest.hashes["extension.mjs"] !== hash(loader(manifest.runtime))) {
    throw new Error("Refusing an incomplete or unrecognized versioned installation.");
  }
  await verifyFiles(target, manifest.hashes, rootEntries, marker);
  return { files: new Map([...Object.entries(manifest.hashes), [marker, digest]]), runtimes };
}

async function removeOwnedDirectory(path) {
  if (!await exists(path)) return;
  for (const file of await readdir(path)) await unlink(join(path, file));
  await rmdir(path);
}

async function acquireInstallLock(parent) {
  const release = await acquireLock(join(parent, ".github-notifications-install-lock"), { label: "installer" });
  if (!release) throw new Error("Another notification installation is running. Retry when it finishes.");
  return release;
}

async function fileHash(path) {
  const stat = await exists(path);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error("Refusing to replace a non-regular runtime file.");
  return hash(await readFile(path));
}

function sameFiles(left, right) {
  return left.size === right.size && [...left].every(([file, digest]) => right.get(file) === digest);
}

function sameRuntime(left, right) {
  return sameFiles(left.files, right.files) && sameFiles(left.runtimes, right.runtimes);
}

export async function install(home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
  const target = resolve(home, "extensions", name);
  await mkdir(dirname(target), { recursive: true });
  const release = await acquireInstallLock(dirname(target));
  let stage;
  let bundleStage;
  let backup;
  let keepBackup = false;
  try {
    const previous = await verifyOwned(target);
    stage = await mkdtemp(join(dirname(target), ".github-notifications-stage-"));
    bundleStage = await mkdtemp(join(dirname(target), ".github-notifications-bundle-"));
    backup = await mkdtemp(join(dirname(target), ".github-notifications-backup-"));
    const hashes = {};
    for (const file of files) {
      await copyFile(join(source, file), join(bundleStage, file));
      hashes[file] = hash(await readFile(join(bundleStage, file)));
    }
    const id = runtimeID(hashes);
    await writeFile(join(bundleStage, runtimeMarker), `${JSON.stringify({ name, version: 1, hashes }, null, 2)}\n`);
    await verifyRuntime(bundleStage, id);
    const rootHashes = Object.fromEntries([...previous.files].filter(([file]) => file !== marker));
    rootHashes["extension.mjs"] = hash(loader(id));
    await writeFile(join(stage, "extension.mjs"), loader(id));
    await writeFile(join(stage, marker), `${JSON.stringify({ name, version: 2, runtime: id, hashes: rootHashes }, null, 2)}\n`);
    const changed = ["extension.mjs", marker];
    const staged = new Map(await Promise.all(changed.map(async file => [file, await fileHash(join(stage, file))])));
    for (const file of changed.filter(file => previous.files.has(file))) {
      await copyFile(join(target, file), join(backup, file));
      if (await fileHash(join(backup, file)) !== previous.files.get(file)) throw new Error("Installed files changed during backup.");
    }
    if (!sameRuntime(previous, await verifyOwned(target))) throw new Error("Installed files changed during installation.");
    await mkdir(target, { recursive: true });
    const runtimesPath = join(target, runtimeFolder);
    await mkdir(runtimesPath, { recursive: true, mode: 0o700 });
    if (!(await lstat(runtimesPath)).isDirectory()) throw new Error("Refusing a symlink runtimes location.");
    const runtimePath = join(runtimesPath, id);
    if (!previous.runtimes.has(id)) {
      if (await exists(runtimePath)) throw new Error("Runtime files changed during installation.");
      await rename(bundleStage, runtimePath);
      bundleStage = undefined;
    }
    const touched = [];
    try {
      // One atomic entry-point switch activates a complete runtime; legacy files and artifacts stay put.
      for (const file of changed) {
        if (await fileHash(join(target, file)) !== previous.files.get(file)) throw new Error("Installed files changed during publication.");
        touched.push(file);
        await rename(join(stage, file), join(target, file));
      }
    } catch (error) {
      for (const file of new Set([...touched].reverse().concat(changed))) {
        try {
          const current = await fileHash(join(target, file));
          if (current === previous.files.get(file)) continue;
          if (current !== undefined && current !== staged.get(file)) throw new Error("Runtime changed during rollback.", { cause: error });
          if (previous.files.has(file)) await rename(join(backup, file), join(target, file));
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
      if (bundleStage) await removeOwnedDirectory(bundleStage);
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
