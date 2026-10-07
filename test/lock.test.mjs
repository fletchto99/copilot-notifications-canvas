import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireLock, processAlive } from "../src/lock.mjs";
import { home, intercept } from "./install-fixtures.mjs";

test("process probes distinguish missing and inaccessible owners and propagate unexpected errors", t => {
  let error;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, 12345);
    assert.equal(signal, 0);
    if (error) throw error;
  });
  assert.equal(processAlive(12345), true);
  error = Object.assign(new Error("Missing process"), { code: "ESRCH" });
  assert.equal(processAlive(12345), false);
  error = Object.assign(new Error("Access denied"), { code: "EPERM" });
  assert.equal(processAlive(12345), true);
  error = Object.assign(new Error("Unexpected process probe failure"), { code: "EINVAL" });
  assert.throws(() => processAlive(12345), value => value === error);
});

test("a lock disappearing during inspection is retried without leaving a candidate behind", async t => {
  for (const operation of ["lstat", "readdir"]) {
    await t.test(operation, async t => {
      const directory = await home(t);
      const path = join(directory, "lock");
      const release = await acquireLock(path);
      let removed = false;
      intercept(t, operation, async (original, target, ...args) => {
        if (target === path && !removed) {
          removed = true;
          await release();
        }
        return original(target, ...args);
      });
      const recovered = await acquireLock(path);
      assert.equal(removed, true);
      assert.equal(typeof recovered, "function");
      assert.deepEqual(await fs.readdir(directory), ["lock"]);
      await recovered();
      assert.deepEqual(await fs.readdir(directory), []);
    });
  }
});

test("empty-lock cleanup tolerates disappearance and preserves a replacement owner", async t => {
  for (const replacement of [false, true]) {
    await t.test(replacement ? "replacement owner" : "disappeared directory", async t => {
      const directory = await home(t);
      const path = join(directory, "lock");
      const oldOwner = `owner-${process.pid}-${randomUUID()}`;
      const newOwner = `owner-${process.pid}-${randomUUID()}`;
      await fs.mkdir(path);
      await fs.writeFile(join(path, oldOwner), "");
      let inspected = false;
      let raced = false;
      intercept(t, "readdir", async (read, target, ...args) => {
        if (target === path && !inspected) {
          inspected = true;
          await fs.unlink(join(path, oldOwner));
        }
        return read(target, ...args);
      });
      intercept(t, "rmdir", async (remove, target) => {
        if (target === path && !raced) {
          raced = true;
          if (replacement) await fs.writeFile(join(path, newOwner), "");
          else await remove(path);
        }
        return remove(target);
      });
      const release = await acquireLock(path);
      assert.equal(inspected, true);
      assert.equal(raced, true);
      if (replacement) {
        assert.equal(release, null);
        assert.deepEqual(await fs.readdir(path), [newOwner]);
        assert.equal(await fs.readFile(join(path, newOwner), "utf8"), "");
        assert.deepEqual(await fs.readdir(directory), ["lock"]);
      } else {
        assert.equal(typeof release, "function");
        await release();
        assert.deepEqual(await fs.readdir(directory), []);
      }
    });
  }
});

test("dead-owner recovery never deletes a replacement owner's marker", async t => {
  const directory = await home(t);
  const path = join(directory, "lock");
  const oldOwner = `owner-12345-${randomUUID()}`;
  const newOwner = `owner-54321-${randomUUID()}`;
  await fs.mkdir(path);
  await fs.writeFile(join(path, oldOwner), "");
  let replaced = false;
  intercept(t, "unlink", async (unlink, target) => {
    if (target === join(path, oldOwner) && !replaced) {
      replaced = true;
      await unlink(target);
      await fs.writeFile(join(path, newOwner), "");
    }
    return unlink(target);
  });
  const probes = [];
  assert.equal(await acquireLock(path, { alive: pid => {
    probes.push(pid);
    return pid === 54321;
  } }), null);
  assert.equal(replaced, true);
  assert.deepEqual(probes, [12345, 54321]);
  assert.deepEqual(await fs.readdir(path), [newOwner]);
  assert.deepEqual(await fs.readdir(directory), ["lock"]);
});

test("repeated release leaves a replacement lock intact", async t => {
  const directory = await home(t);
  const path = join(directory, "lock");
  const release = await acquireLock(path);
  await release();
  await release();
  const replacement = await acquireLock(path);
  const owners = await fs.readdir(path);
  await release();
  assert.deepEqual(await fs.readdir(path), owners);
  assert.equal(await acquireLock(path), null);
  await replacement();
  assert.deepEqual(await fs.readdir(directory), []);
});

test("repeated lock races exhaust the bounded retry loop and clean up the unpublished candidate", async t => {
  const directory = await home(t);
  const path = join(directory, "lock");
  let attempts = 0;
  intercept(t, "rename", async (rename, from, to) => {
    if (to !== path) return rename(from, to);
    attempts++;
    throw Object.assign(new Error("Synthetic concurrent publication"), { code: "EEXIST" });
  });
  intercept(t, "lstat", async (lstat, target) => {
    if (target !== path) return lstat(target);
    throw Object.assign(new Error("Synthetic concurrent removal"), { code: "ENOENT" });
  });
  await assert.rejects(acquireLock(path, { label: "test" }),
    { message: "The test lock changed concurrently. Retry shortly." });
  assert.equal(attempts, 5);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("unexpected publication and inspection errors preserve existing ownership and clean up candidates", async t => {
  for (const operation of ["rename", "lstat"]) {
    await t.test(operation, async t => {
      const directory = await home(t);
      const path = join(directory, "lock");
      const release = await acquireLock(path);
      const owners = await fs.readdir(path);
      const denied = Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" });
      intercept(t, operation, async () => { throw denied; });
      await assert.rejects(acquireLock(path), error => error === denied);
      assert.deepEqual(await fs.readdir(path), owners);
      assert.deepEqual(await fs.readdir(directory), ["lock"]);
      await release();
      assert.deepEqual(await fs.readdir(directory), []);
    });
  }
});

test("unexpected release errors are surfaced and allow cleanup on retry", async t => {
  const directory = await home(t);
  const path = join(directory, "lock");
  const release = await acquireLock(path);
  const denied = Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" });
  let failing = true;
  intercept(t, "rmdir", async (rmdir, target) => {
    if (target === path && failing) {
      failing = false;
      throw denied;
    }
    return rmdir(target);
  });
  await assert.rejects(release(), error => error === denied);
  assert.deepEqual(await fs.readdir(path), []);
  await release();
  assert.deepEqual(await fs.readdir(directory), []);
});
