import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const name = "github-notifications";
const marker = ".copilot-notifications-install.json";
const files = ["extension.mjs", "github.mjs", "inbox.mjs", "model.mjs", "server.mjs", "app.mjs", "index.html", "styles.css"];
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
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to replace a non-directory or symlink.");
  const entries = await readdir(target);
  if (entries.length !== files.length + 1 || entries.some(file => ![...files, marker].includes(file))) {
    throw new Error("Refusing to overwrite an unrelated or incomplete extension directory.");
  }
  for (const file of [...files, marker]) {
    if (!(await lstat(join(target, file))).isFile()) throw new Error("Refusing to overwrite non-regular files.");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(target, marker), "utf8"));
  } catch {
    throw new Error("Refusing to replace an extension without a valid installer ownership marker.");
  }
  if (manifest.name !== name || manifest.version !== 1) throw new Error("Unrecognized installer ownership marker.");
  for (const file of files) {
    if (hash(await readFile(join(target, file))) !== manifest.hashes?.[file]) {
      throw new Error("Installed files were modified. Preserve your changes and move that directory before reinstalling.");
    }
  }
  return true;
}

async function removeOwnedDirectory(path) {
  for (const file of await readdir(path)) await unlink(join(path, file));
  await rmdir(path);
}

export async function install(home = process.env.COPILOT_HOME || join(homedir(), ".copilot")) {
  const target = resolve(home, "extensions", name);
  const owned = await verifyOwned(target);
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), ".github-notifications-stage-"));
  let backup;
  try {
    const hashes = {};
    for (const file of files) {
      await copyFile(join(source, file), join(stage, file));
      hashes[file] = hash(await readFile(join(stage, file)));
    }
    await writeFile(join(stage, marker), `${JSON.stringify({ name, version: 1, hashes }, null, 2)}\n`);
    // Recheck immediately before the directory swap; never merge into someone else's files.
    if (await verifyOwned(target) !== owned) throw new Error("Install target changed during installation.");
    if (owned) {
      backup = `${stage}-previous`;
      await rename(target, backup);
    }
    try {
      await rename(stage, target);
    } catch (error) {
      if (backup) await rename(backup, target);
      backup = undefined;
      throw error;
    }
    if (backup) await removeOwnedDirectory(backup);
  } finally {
    if (await exists(stage)) await removeOwnedDirectory(stage);
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
