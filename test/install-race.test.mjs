import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../scripts/install.mjs";
import { Preferences } from "../.github/extensions/github-notifications/settings.mjs";

const execute = promisify(execFile);
const digest = data => createHash("sha256").update(data).digest("hex");

async function home(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "notification-upgrade-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function intercept(t, name, handler) {
  const original = fs[name];
  fs[name] = (...args) => handler(original, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    fs[name] = original;
    syncBuiltinESMExports();
  });
}

async function writeFromProvider(directory, autoOpen) {
  const module = new URL("../.github/extensions/github-notifications/settings.mjs", import.meta.url).href;
  await execute(process.execPath, ["--input-type=module", "-e",
    `import { Preferences } from ${JSON.stringify(module)}; await new Preferences({directory:process.argv[1]}).update({autoOpen:${autoOpen}});`,
    directory]);
}

test("a concurrent provider can save settings during publication without moving artifacts or losing the entry point", async t => {
  const root = await home(t);
  const target = await install(root);
  const directory = join(target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: false });
  await fs.writeFile(join(directory, "user-note.txt"), "preserved");
  const before = await fs.stat(directory);
  let writes = 0;
  intercept(t, "rename", async (rename, from, to) => {
    assert.notEqual(from, target, "The installed directory must never disappear");
    if (from.includes("-stage-") && to === join(target, "github.mjs")) {
      await writeFromProvider(directory, true);
      await fs.access(join(target, "extension.mjs"));
      writes++;
    }
    return rename(from, to);
  });
  await install(root);
  assert.equal(writes, 1);
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null });
  assert.equal((await fs.stat(directory)).ino, before.ino);
  assert.equal(await fs.readFile(join(directory, "user-note.txt"), "utf8"), "preserved");
  await fs.access(join(target, "extension.mjs"));
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
});

test("a settings writer already holding its original lock can finish after an upgrade", async t => {
  const root = await home(t);
  const target = await install(root);
  const directory = join(target, "artifacts");
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const preferences = new Preferences({ directory, io: { ...fs, rename: async (...args) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    return fs.rename(...args);
  } } });
  const saving = preferences.update({ autoOpen: true });
  await ready;
  await install(root);
  release();
  await saving;
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null });
  assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
});

test("an artifacts-only destination created by a provider during staging is preserved", async t => {
  const root = await home(t);
  const target = join(root, "extensions", "github-notifications");
  const directory = join(target, "artifacts");
  let written = false;
  intercept(t, "copyFile", async (copy, from, to) => {
    if (!written && to.includes("-stage-")) {
      written = true;
      await writeFromProvider(directory, true);
    }
    return copy(from, to);
  });
  await install(root);
  assert.equal(written, true);
  assert.deepEqual(await new Preferences({ directory }).read(), { autoOpen: true, darkMode: null });
  await fs.access(join(target, "extension.mjs"));
});

test("publication failure restores the previous runtime and retains the latest concurrent settings", async t => {
  const root = await home(t);
  const target = await install(root);
  const oldApp = `${await fs.readFile(join(target, "app.mjs"), "utf8")}\n// Previous synthetic release.\n`;
  await fs.writeFile(join(target, "app.mjs"), oldApp);
  const marker = join(target, ".copilot-notifications-install.json");
  const manifest = JSON.parse(await fs.readFile(marker, "utf8"));
  manifest.hashes["app.mjs"] = digest(oldApp);
  await fs.writeFile(marker, JSON.stringify(manifest));
  const previousMarker = await fs.readFile(marker, "utf8");
  const directory = join(target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: false });
  let failed = false;
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (!failed && from.includes("-stage-") && to === join(target, "app.mjs")) {
      failed = true;
      await writeFromProvider(directory, true);
      throw Object.assign(new Error("Synthetic publication failure"), { code: "EIO" });
    }
    return result;
  });
  await assert.rejects(install(root), /Synthetic publication failure/);
  assert.equal(await fs.readFile(join(target, "app.mjs"), "utf8"), oldApp);
  assert.equal(await fs.readFile(marker, "utf8"), previousMarker);
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null });
  await fs.access(join(target, "extension.mjs"));
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
  await install(root);
});

test("rollback preserves an unexpected user edit and keeps original runtime backups for recovery", async t => {
  const root = await home(t);
  const target = await install(root);
  const oldApp = await fs.readFile(join(target, "app.mjs"), "utf8");
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (from.includes("-stage-") && to === join(target, "app.mjs")) {
      await fs.writeFile(to, "// Unrelated user edit.\n");
      throw new Error("Synthetic interrupted publication");
    }
    return result;
  });
  await assert.rejects(install(root), /rollback needs attention/);
  assert.equal(await fs.readFile(join(target, "app.mjs"), "utf8"), "// Unrelated user edit.\n");
  await fs.access(join(target, "extension.mjs"));
  const parentEntries = await fs.readdir(join(root, "extensions"));
  const backup = parentEntries.find(name => name.startsWith(".github-notifications-backup-"));
  assert.ok(backup);
  assert.equal(await fs.readFile(join(root, "extensions", backup, "app.mjs"), "utf8"), oldApp);
  assert.equal(parentEntries.some(name => name.includes("install-lock")), false);
});

test("concurrent installers cannot interleave publication and the lock is released", async t => {
  const root = await home(t);
  let release;
  let entered;
  let paused = false;
  const ready = new Promise(resolve => { entered = resolve; });
  intercept(t, "copyFile", async (copy, from, to) => {
    if (!paused && to.includes("-stage-")) {
      paused = true;
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return copy(from, to);
  });
  const first = install(root);
  await ready;
  await assert.rejects(install(root), /Another notification installation is running/);
  release();
  await first;
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
  await install(root);
});

test("dead-owner installer locks recover without a stale-lock deadlock", async t => {
  const root = await home(t);
  const lock = join(root, "extensions", ".github-notifications-install-lock");
  await fs.mkdir(lock, { recursive: true });
  const child = execute(process.execPath, ["-e", ""]);
  const pid = child.child.pid;
  await child;
  await fs.writeFile(join(lock, `owner-${pid}-${randomUUID()}`), "");
  await install(root);
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
});

test("unrecognized lock content is never removed", async t => {
  const root = await home(t);
  const lock = join(root, "extensions", ".github-notifications-install-lock");
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(join(lock, "unrelated.txt"), "keep");
  await assert.rejects(install(root), /unrecognized installer lock/);
  assert.equal(await fs.readFile(join(lock, "unrelated.txt"), "utf8"), "keep");
});
