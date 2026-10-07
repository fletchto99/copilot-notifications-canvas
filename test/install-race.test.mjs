import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Preferences } from "../src/settings.mjs";
import { inspectBundle } from "../scripts/package.mjs";
import { fixture, intercept } from "./install-fixtures.mjs";

const execute = promisify(execFile);

test("one atomic rename activates code, assets and ownership without removing the installed directory", async t => {
  const old = await fixture(t);
  await old.install();
  const next = await fixture(t, { root: old.root, version: "2.0.0" });
  const before = await fs.stat(old.target);
  let activations = 0;
  intercept(t, "rename", async (rename, from, to) => {
    assert.notEqual(from, old.target);
    if (from.includes("-stage-")) {
      assert.equal(await fs.readFile(join(old.target, "extension.mjs"), "utf8"), old.content);
      assert.equal(to, join(old.target, "extension.mjs"));
      await rename(from, to);
      assert.equal(inspectBundle(await fs.readFile(to)).version, "2.0.0");
      activations++;
      return;
    }
    return rename(from, to);
  });
  await next.install();
  assert.equal(activations, 1);
  assert.equal((await fs.stat(old.target)).ino, before.ino);
  assert.deepEqual(await fs.readdir(old.target), ["extension.mjs"]);
});

test("staging or activation failure leaves the previous bundle intact and releases the lock", async t => {
  for (const operation of ["writeFile", "rename"]) {
    await t.test(operation, async t => {
      const old = await fixture(t);
      await old.install();
      const next = await fixture(t, { root: old.root, version: "2.0.0" });
      let failed = false;
      intercept(t, operation, async (original, path, ...args) => {
        if (!failed && path.includes("-stage-")) {
          failed = true;
          throw new Error("Synthetic installation failure");
        }
        return original(path, ...args);
      });
      await assert.rejects(next.install(), /Synthetic installation failure/);
      assert.equal(await fs.readFile(join(old.target, "extension.mjs"), "utf8"), old.content);
      assert.deepEqual(await fs.readdir(join(old.root, "extensions")), ["github-notifications"]);
      await next.install();
    });
  }
});

test("an error after atomic activation leaves a complete new bundle recognizable on retry", async t => {
  const old = await fixture(t);
  await old.install();
  const next = await fixture(t, { root: old.root, version: "2.0.0" });
  intercept(t, "rename", async (rename, from, to) => {
    await rename(from, to);
    if (from.includes("-stage-")) throw new Error("Synthetic interruption after activation");
  });
  await assert.rejects(next.install(), /after activation/);
  assert.equal(await fs.readFile(join(old.target, "extension.mjs"), "utf8"), next.content);
  assert.equal((await next.install()).status, "current");
  assert.deepEqual(await fs.readdir(join(old.root, "extensions")), ["github-notifications"]);
});

test("concurrent edits and unexpected files during staging are never overwritten", async t => {
  for (const extra of [false, true]) {
    await t.test(extra ? "extra file" : "edited bundle", async t => {
      const old = await fixture(t);
      await old.install();
      const next = await fixture(t, { root: old.root, version: "2.0.0" });
      const changed = join(old.target, extra ? "notes.txt" : "extension.mjs");
      intercept(t, "writeFile", async (write, path, ...args) => {
        await write(path, ...args);
        if (path.includes("-stage-")) await write(changed, "local changes");
      });
      await assert.rejects(next.install(), /unrelated|Unrecognized/);
      assert.equal(await fs.readFile(changed, "utf8"), "local changes");
    });
  }
});

test("a damaged staged bundle is rejected before activation", async t => {
  const f = await fixture(t);
  intercept(t, "writeFile", async (write, path, ...args) =>
    write(path, ...(path.includes("-stage-") ? ["damaged"] : args)));
  await assert.rejects(f.install(), /Unrecognized/);
  assert.deepEqual(await fs.readdir(join(f.root, "extensions")), []);
});

test("concurrent providers can save settings during an upgrade without moving artifacts", async t => {
  const old = await fixture(t);
  await old.install();
  const next = await fixture(t, { root: old.root, version: "2.0.0" });
  const directory = join(old.target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: false, groupBy: "none" });
  await fs.writeFile(join(directory, "keep.txt"), "keep");
  const before = await fs.stat(directory);
  let writes = 0;
  intercept(t, "rename", async (rename, from, to) => {
    if (from.includes("-stage-")) {
      const module = new URL("../src/settings.mjs", import.meta.url).href;
      await execute(process.execPath, ["--input-type=module", "-e",
        `import { Preferences } from ${JSON.stringify(module)}; await new Preferences({directory:process.argv[1]}).update({autoOpen:true});`,
        directory]);
      writes++;
    }
    return rename(from, to);
  });
  await next.install();
  assert.equal(writes, 1);
  assert.equal((await preferences.read()).autoOpen, true);
  assert.equal((await preferences.read()).groupBy, "none");
  assert.equal((await fs.stat(directory)).ino, before.ino);
  assert.equal(await fs.readFile(join(directory, "keep.txt"), "utf8"), "keep");
});

test("a settings writer holding its original lock can finish after activation", async t => {
  const old = await fixture(t);
  await old.install();
  const next = await fixture(t, { root: old.root, version: "2.0.0" });
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const preferences = new Preferences({ directory: join(old.target, "artifacts"), io: { ...fs, rename: async (...args) => {
    entered();
    await new Promise(resolve => { release = resolve; });
    await fs.rename(...args);
  } } });
  const saving = preferences.update({ autoOpen: true });
  await ready;
  await next.install();
  release();
  await saving;
  assert.equal((await preferences.read()).autoOpen, true);
});

test("an artifacts-only destination created while staging is preserved", async t => {
  const f = await fixture(t);
  const preferences = new Preferences({ directory: join(f.target, "artifacts") });
  intercept(t, "writeFile", async (write, path, ...args) => {
    if (path.includes("-stage-")) await preferences.update({ autoOpen: true });
    return write(path, ...args);
  });
  await f.install();
  assert.equal((await preferences.read()).autoOpen, true);
});

test("concurrent installers cannot interleave publication", async t => {
  const f = await fixture(t);
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  intercept(t, "writeFile", async (write, path, ...args) => {
    if (path.includes("-stage-")) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return write(path, ...args);
  });
  const first = f.install();
  await ready;
  await assert.rejects(f.install(), /Another notification installation is running/);
  release();
  await first;
  assert.equal((await f.install()).status, "current");
  assert.deepEqual(await fs.readdir(join(f.root, "extensions")), ["github-notifications"]);
});

test("dead-owner locks are recoverable, while unrecognized lock content is preserved", async t => {
  const f = await fixture(t);
  const lock = join(f.root, "extensions", ".github-notifications-install-lock");
  await fs.mkdir(lock, { recursive: true });
  const child = execute(process.execPath, ["-e", ""]);
  const pid = child.child.pid;
  await child;
  await fs.writeFile(join(lock, `owner-${pid}-${randomUUID()}`), "");
  await f.install();
  assert.deepEqual(await fs.readdir(join(f.root, "extensions")), ["github-notifications"]);
  await fs.mkdir(lock);
  await fs.writeFile(join(lock, "unrelated.txt"), "keep");
  await assert.rejects(f.install(), /unrecognized installer lock/);
  assert.equal(await fs.readFile(join(lock, "unrelated.txt"), "utf8"), "keep");
});
