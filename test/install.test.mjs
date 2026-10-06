import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install } from "../scripts/install.mjs";
import { home, legacyAssets, legacyInstallation, olderRuntime, runtimePath, sourceFiles } from "./install-fixtures.mjs";

test("installation is repeatable, scoped to the supplied Copilot home, and copies only runtime files", async t => {
  const root = await home(t);
  const target = await install(root);
  assert.equal(target, join(root, "extensions", "github-notifications"));
  assert.equal(await install(root), target);
  assert.equal((await readdir(target)).length, 3);
  const runtime = await runtimePath(target);
  const entries = await readdir(runtime);
  assert.equal(entries.length, 17);
  assert.equal((await readdir(join(target, "runtimes"))).length, 1);
  assert.equal(entries.includes("extension.mjs"), true);
  assert.equal(entries.includes("README.md"), false);
  assert.equal(entries.includes("test"), false);
  assert.equal(entries.includes("node_modules"), false);
  assert.equal(entries.includes("sound.mjs"), false);
  assert.equal(entries.includes("updates.mjs"), true);
  assert.equal(entries.includes("version.json"), true);
  const { Updates } = await import(pathToFileURL(join(runtime, "updates.mjs")).href);
  const version = JSON.parse(await readFile(join(runtime, "version.json"), "utf8")).version;
  assert.equal(new Updates().snapshot().currentVersion, version);
  assert.match(await readFile(join(target, "extension.mjs"), "utf8"), /^await import\("\.\/runtimes\/[a-f0-9]{64}\/extension\.mjs"\);\n$/);
});

test("an untouched pre-sound installation upgrades without overwriting unrelated files", async t => {
  const root = await home(t);
  const { target } = await legacyInstallation(root, { omit: ["sound.mjs", "settings.mjs", "startup.mjs", "batch.mjs", "updates.mjs", "version.json"] });
  assert.equal(await install(root), target);
  assert.match(await readFile(join(await runtimePath(target), "notifier.mjs"), "utf8"), /notifyDesktop/);
});

test("a pre-desktop installation upgrades and a missing current desktop file is rejected", async t => {
  const root = await home(t);
  const { target } = await legacyInstallation(root);
  await install(root);
  const runtime = await runtimePath(target);
  assert.match(await readFile(join(runtime, "desktop.mjs"), "utf8"), /class DesktopNotifications/);
  await unlink(join(runtime, "desktop.mjs"));
  await assert.rejects(install(root), /incomplete/);
});

test("a pre-batch installation upgrades while preserving settings", async t => {
  const root = await home(t);
  const { target } = await legacyInstallation(root, { omit: ["batch.mjs"] });
  await install(root);
  assert.match(await readFile(join(await runtimePath(target), "batch.mjs"), "utf8"), /class ReadBatch/);
});

test("installation preserves existing user settings and unknown artifact files on every upgrade", async t => {
  const root = await home(t);
  const artifacts = join(root, "extensions", "github-notifications", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "settings.json"), '{"autoOpen":true,"future":42}');
  await writeFile(join(artifacts, "preserve.txt"), "user artifact");
  await install(root);
  await install(root);
  assert.equal(await readFile(join(artifacts, "settings.json"), "utf8"), '{"autoOpen":true,"future":42}');
  assert.equal(await readFile(join(artifacts, "preserve.txt"), "utf8"), "user artifact");
});

test("a pre-update-check installation upgrades with settings and artifacts byte-for-byte intact", async t => {
  const root = await home(t);
  const { target } = await legacyInstallation(root, { omit: ["updates.mjs", "version.json"] });
  const artifacts = join(target, "artifacts");
  await mkdir(artifacts);
  const settings = '{\n  "autoOpen": true,\n  "darkMode": true,\n  "future": {"nested": [1, 2]}\n}\n';
  await writeFile(join(artifacts, "settings.json"), settings);
  await writeFile(join(artifacts, "user-note.txt"), "preserve");
  await install(root);
  assert.equal(await readFile(join(artifacts, "settings.json"), "utf8"), settings);
  assert.equal(await readFile(join(artifacts, "user-note.txt"), "utf8"), "preserve");
  const runtime = await runtimePath(target);
  assert.match(await readFile(join(runtime, "updates.mjs"), "utf8"), /class Updates/);
  assert.match(await readFile(join(runtime, "version.json"), "utf8"), /"version"/);
});

test("missing update files are not mistaken for a legacy installation", async t => {
  for (const files of [["updates.mjs"], ["version.json"], ["updates.mjs", "version.json"]]) {
    const root = await home(t);
    const target = await install(root);
    const runtime = await runtimePath(target);
    for (const file of files) await unlink(join(runtime, file));
    await assert.rejects(install(root), /incomplete/);
  }
});

test("a missing current runtime module is rejected as an incomplete installation", async t => {
  const root = await home(t);
  const target = await install(root);
  await unlink(join(await runtimePath(target), "app.mjs"));
  await assert.rejects(install(root), /incomplete/);
});

test("upgrades preserve unchanged legacy assets for old sessions without including Web Audio in new runtimes", async t => {
  const root = await home(t);
  const { target, contents } = await legacyInstallation(root);
  await writeFile(join(target, "sound.mjs"), "local edit");
  await assert.rejects(install(root), /modified/);
  assert.equal(await readFile(join(target, "sound.mjs"), "utf8"), "local edit");
  await writeFile(join(target, "sound.mjs"), legacyAssets["sound.mjs"]);
  await install(root);
  for (const [file, content] of Object.entries(contents)) {
    if (file !== "extension.mjs") assert.equal(await readFile(join(target, file), "utf8"), content);
  }
  assert.equal((await readdir(await runtimePath(target))).includes("sound.mjs"), false);
  await install(root);
});

test("versioned upgrades retain the previous complete runtime without modifying its files", async t => {
  const root = await home(t);
  const { target, directory, contents } = await olderRuntime(root);
  await install(root);
  assert.notEqual(await runtimePath(target), directory);
  assert.equal((await readdir(join(target, "runtimes"))).length, 2);
  for (const file of sourceFiles) assert.equal(await readFile(join(directory, file), "utf8"), contents[file]);
  await install(root);
  assert.equal((await readdir(join(target, "runtimes"))).length, 2);
  await writeFile(join(directory, "app.mjs"), "local edit to retained runtime");
  await assert.rejects(install(root), /modified/);
  assert.equal(await readFile(join(directory, "app.mjs"), "utf8"), "local edit to retained runtime");
});

test("the documented install command respects COPILOT_HOME without touching the real user directory", async t => {
  const root = await home(t);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../scripts/install.mjs", import.meta.url))],
    { env: { ...process.env, COPILOT_HOME: root } });
  assert.ok(stdout.includes(join(root, "extensions", "github-notifications")));
  const runtime = await runtimePath(join(root, "extensions", "github-notifications"));
  assert.match(await readFile(join(runtime, "extension.mjs"), "utf8"), /joinSession/);
});

test("the installed entry point loads its complete runtime with the host-provided SDK", async t => {
  const root = await home(t);
  const target = await install(root);
  const sdk = `export const createCanvas = options => options;
export class CanvasError extends Error {}
export async function joinSession(options) {
  globalThis.registeredCanvases = options.canvases.map(canvas => canvas.id);
  return { workspacePath: process.argv[2], log: async () => {} };
}`;
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "@github/copilot-sdk/extension") return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(sdk)}`)}, shortCircuit: true };
  return next(specifier, context);
}`;
  const script = `
import { register } from "node:module";
import assert from "node:assert/strict";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
await import(process.argv[1]);
assert.deepEqual(globalThis.registeredCanvases, ["github-notifications"]);
`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script,
    pathToFileURL(join(target, "extension.mjs")).href, join(root, "session")],
  { env: { ...process.env, COPILOT_HOME: root } });
});

test("installer refuses unrelated content and preserves it exactly", async t => {
  const root = await home(t);
  const target = join(root, "extensions", "github-notifications");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "extension.mjs"), "unrelated user extension");
  await assert.rejects(install(root), /unrelated or incomplete/);
  assert.equal(await readFile(join(target, "extension.mjs"), "utf8"), "unrelated user extension");
});

test("installer refuses locally edited owned files, extra content and symlink destinations", async t => {
  const root = await home(t);
  const target = await install(root);
  await writeFile(join(target, "extension.mjs"), "local changes");
  await assert.rejects(install(root), /modified/);
  const secondRoot = await home(t);
  const second = await install(secondRoot);
  await writeFile(join(second, "notes.txt"), "preserve");
  await assert.rejects(install(secondRoot), /unrelated/);
  const thirdRoot = await home(t);
  await mkdir(join(thirdRoot, "extensions"));
  await symlink(target, join(thirdRoot, "extensions", "github-notifications"));
  await assert.rejects(install(thirdRoot), /symlink/);
});

test("unrecognized or symlinked runtime directories are never replaced", async t => {
  const root = await home(t);
  const target = await install(root);
  const unowned = join(target, "runtimes", "notes");
  await mkdir(unowned);
  await writeFile(join(unowned, "keep.txt"), "keep");
  await assert.rejects(install(root), /unrecognized runtime/);
  assert.equal(await readFile(join(unowned, "keep.txt"), "utf8"), "keep");
  const other = await home(t);
  const second = await install(other);
  const runtime = await runtimePath(second);
  await unlink(join(runtime, "styles.css"));
  await symlink(join(runtime, "app.mjs"), join(runtime, "styles.css"));
  await assert.rejects(install(other), /non-regular/);
});
