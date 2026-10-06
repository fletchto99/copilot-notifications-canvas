import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { install } from "../scripts/install.mjs";

async function home(t) {
  const path = await mkdtemp(join(tmpdir(), "notifications-install-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("installation is repeatable, scoped to the supplied Copilot home, and copies only runtime files", async t => {
  const root = await home(t);
  const target = await install(root);
  assert.equal(target, join(root, "extensions", "github-notifications"));
  assert.equal(await install(root), target);
  const entries = await readdir(target);
  assert.equal(entries.length, 17);
  assert.equal(entries.includes("extension.mjs"), true);
  assert.equal(entries.includes("README.md"), false);
  assert.equal(entries.includes("test"), false);
  assert.equal(entries.includes("node_modules"), false);
  assert.equal(entries.includes("sound.mjs"), false);
  assert.equal(entries.includes("updates.mjs"), true);
  assert.equal(entries.includes("version.json"), true);
  const { Updates } = await import(pathToFileURL(join(target, "updates.mjs")).href);
  const version = JSON.parse(await readFile(join(target, "version.json"), "utf8")).version;
  assert.equal(new Updates().snapshot().currentVersion, version);
});

test("an untouched pre-sound installation upgrades without overwriting unrelated files", async t => {
  const root = await home(t);
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  for (const file of ["settings.mjs", "startup.mjs", "batch.mjs", "desktop.mjs", "notifier.mjs", "lock.mjs", "updates.mjs", "version.json"]) {
    delete manifest.hashes[file];
    await unlink(join(target, file));
  }
  await writeFile(marker, JSON.stringify(manifest));
  assert.equal(await install(root), target);
  assert.match(await readFile(join(target, "notifier.mjs"), "utf8"), /notifyDesktop/);
});

test("a pre-desktop installation upgrades and a missing current desktop file is rejected", async t => {
  const root = await home(t);
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  for (const file of ["desktop.mjs", "notifier.mjs", "lock.mjs"]) {
    delete manifest.hashes[file];
    await unlink(join(target, file));
  }
  await writeFile(marker, JSON.stringify(manifest));
  await install(root);
  assert.match(await readFile(join(target, "desktop.mjs"), "utf8"), /class DesktopNotifications/);
  await unlink(join(target, "desktop.mjs"));
  await assert.rejects(install(root), /incomplete/);
});

test("a pre-batch installation upgrades while preserving settings", async t => {
  const root = await home(t);
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  delete manifest.hashes["batch.mjs"];
  await writeFile(marker, JSON.stringify(manifest));
  await unlink(join(target, "batch.mjs"));
  await install(root);
  assert.match(await readFile(join(target, "batch.mjs"), "utf8"), /class ReadBatch/);
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
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  for (const file of ["updates.mjs", "version.json"]) {
    delete manifest.hashes[file];
    await unlink(join(target, file));
  }
  await writeFile(marker, JSON.stringify(manifest));
  const artifacts = join(target, "artifacts");
  await mkdir(artifacts);
  const settings = '{\n  "autoOpen": true,\n  "darkMode": true,\n  "future": {"nested": [1, 2]}\n}\n';
  await writeFile(join(artifacts, "settings.json"), settings);
  await writeFile(join(artifacts, "user-note.txt"), "preserve");
  await install(root);
  assert.equal(await readFile(join(artifacts, "settings.json"), "utf8"), settings);
  assert.equal(await readFile(join(artifacts, "user-note.txt"), "utf8"), "preserve");
  assert.match(await readFile(join(target, "updates.mjs"), "utf8"), /class Updates/);
  assert.match(await readFile(join(target, "version.json"), "utf8"), /"version"/);
});

test("missing update files are not mistaken for a legacy installation", async t => {
  for (const files of [["updates.mjs"], ["version.json"], ["updates.mjs", "version.json"]]) {
    const root = await home(t);
    const target = await install(root);
    for (const file of files) await unlink(join(target, file));
    await assert.rejects(install(root), /incomplete/);
  }
});

test("a missing current runtime module is rejected as an incomplete installation", async t => {
  const root = await home(t);
  const target = await install(root);
  await unlink(join(target, "app.mjs"));
  await assert.rejects(install(root), /incomplete/);
});

test("upgrades remove only an unchanged installer-owned legacy sound module", async t => {
  const root = await home(t);
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  const source = "export const legacySound = true;\n";
  manifest.hashes["sound.mjs"] = createHash("sha256").update(source).digest("hex");
  await writeFile(marker, JSON.stringify(manifest));
  await writeFile(join(target, "sound.mjs"), "local edit");
  await assert.rejects(install(root), /modified/);
  assert.equal(await readFile(join(target, "sound.mjs"), "utf8"), "local edit");
  await writeFile(join(target, "sound.mjs"), source);
  await install(root);
  assert.equal((await readdir(target)).includes("sound.mjs"), false);
  await install(root);
});

test("the documented install command respects COPILOT_HOME without touching the real user directory", async t => {
  const root = await home(t);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../scripts/install.mjs", import.meta.url))],
    { env: { ...process.env, COPILOT_HOME: root } });
  assert.ok(stdout.includes(join(root, "extensions", "github-notifications")));
  assert.match(await readFile(join(root, "extensions", "github-notifications", "extension.mjs"), "utf8"), /joinSession/);
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
