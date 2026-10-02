import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.equal(entries.length, 9);
  assert.equal(entries.includes("extension.mjs"), true);
  assert.equal(entries.includes("README.md"), false);
  assert.equal(entries.includes("test"), false);
  assert.equal(entries.includes("node_modules"), false);
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
