import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
  assert.equal(entries.length, 13);
  assert.equal(entries.includes("extension.mjs"), true);
  assert.equal(entries.includes("README.md"), false);
  assert.equal(entries.includes("test"), false);
  assert.equal(entries.includes("node_modules"), false);
  assert.equal(entries.includes("sound.mjs"), true);
});

test("an untouched pre-sound installation upgrades without overwriting unrelated files", async t => {
  const root = await home(t);
  const target = await install(root);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  for (const file of ["sound.mjs", "settings.mjs", "startup.mjs", "batch.mjs"]) {
    delete manifest.hashes[file];
    await unlink(join(target, file));
  }
  await writeFile(marker, JSON.stringify(manifest));
  assert.equal(await install(root), target);
  assert.match(await readFile(join(target, "sound.mjs"), "utf8"), /class NotificationSound/);
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

test("a missing current audio module is not mistaken for a pre-sound installation", async t => {
  const root = await home(t);
  const target = await install(root);
  await unlink(join(target, "sound.mjs"));
  await assert.rejects(install(root), /incomplete/);
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
