import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/lock.mjs";
import { compareVersions } from "../src/version.mjs";
import { inspectBundle, loadPackage, name, readRegular } from "./package.mjs";

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
  if (!stat) return null;
  if (!stat.isDirectory()) throw new Error("Refusing a symlink or non-directory installation.");
  const entries = await readdir(target);
  if (entries.includes("artifacts") && !(await lstat(join(target, "artifacts"))).isDirectory()) {
    throw new Error("Refusing a symlink or non-directory artifacts location.");
  }
  if (entries.some(file => [".copilot-notifications-install.json", "runtimes"].includes(file))) {
    throw new Error("Legacy installation detected. Preserve the existing files; this layout cannot be upgraded automatically.");
  }
  if (entries.some(file => !["extension.mjs", "artifacts"].includes(file))) {
    throw new Error("Refusing an unrelated or legacy installation. Preserve its files; only packaged installations can be upgraded.");
  }
  return entries.includes("extension.mjs") ? inspectBundle(await readRegular(join(target, "extension.mjs"))) : null;
}

export async function install({
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  directory = dirname(fileURLToPath(import.meta.url)),
  tag,
} = {}) {
  const bundle = await loadPackage(directory, tag);
  const target = resolve(home, "extensions", name);
  await mkdir(dirname(target), { recursive: true });
  const release = await acquireLock(join(dirname(target), ".github-notifications-install-lock"), { label: "installer" });
  if (!release) throw new Error("Another notification installation is running. Retry when it finishes.");
  let stage;
  try {
    const previous = await verifyOwned(target);
    if (previous) {
      const comparison = compareVersions(bundle.version, previous.version);
      if (comparison < 0) throw new Error(`Refusing to downgrade v${previous.version} to v${bundle.version}.`);
      if (comparison === 0) {
        if (previous.digest !== bundle.digest) throw new Error("The same version has different contents. Publish a new version instead.");
        return { target, version: bundle.version, status: "current" };
      }
    }
    stage = await mkdtemp(join(dirname(target), ".github-notifications-stage-"));
    const staged = join(stage, "extension.mjs");
    await writeFile(staged, bundle.content, { flag: "wx", mode: 0o600 });
    if (inspectBundle(await readRegular(staged)).digest !== bundle.digest) throw new Error("Staged bundle changed during installation.");
    await mkdir(target, { recursive: true });
    if ((await verifyOwned(target))?.digest !== previous?.digest) throw new Error("Installed files changed during installation.");
    // Code, assets, version, and ownership move together; artifacts never move.
    await rename(staged, join(target, "extension.mjs"));
    return { target, version: bundle.version, status: "installed" };
  } finally {
    try {
      if (stage) {
        const staged = join(stage, "extension.mjs");
        if (await exists(staged)) await unlink(staged);
        await rmdir(stage);
      }
    } finally {
      await release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node install.mjs <release-tag>");
    const result = await install({ tag: process.argv[2] });
    process.stdout.write(result.status === "current"
      ? `Already current: v${result.version} in ${result.target}. No files changed.\n`
      : `Installed v${result.version} in ${result.target}.\nReload extensions in Copilot to activate it.\n`);
  } catch (error) {
    process.stderr.write(`Installation stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
