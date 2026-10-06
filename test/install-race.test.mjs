import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { install } from "../scripts/install.mjs";
import { Preferences } from "../.github/extensions/github-notifications/settings.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";
import { home, intercept, legacyAssets, legacyInstallation, marker, olderRuntime, runtimePath, sourceContents } from "./install-fixtures.mjs";

const execute = promisify(execFile);

async function writeFromProvider(directory, autoOpen) {
  const module = new URL("../.github/extensions/github-notifications/settings.mjs", import.meta.url).href;
  await execute(process.execPath, ["--input-type=module", "-e",
    `import { Preferences } from ${JSON.stringify(module)}; await new Preferences({directory:process.argv[1]}).update({autoOpen:${autoOpen}});`,
    directory]);
}

async function serverFactory(directory) {
  return (await import(pathToFileURL(join(directory, "server.mjs")).href)).startServer;
}

async function startCanvas(factory) {
  return factory(new Inbox(new GitHubClient({ run: async () => assert.fail("Asset checks must not call GitHub") })));
}

async function assertAssets(server, contents) {
  const origin = new URL(server.url).origin;
  await Promise.all([["/", "index.html"], ["/app.mjs", "app.mjs"], ["/styles.css", "styles.css"]].map(async ([route, file]) => {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, file);
    assert.equal(await response.text(), contents[file], file);
  }));
  const sound = await fetch(`${origin}/sound.mjs`);
  assert.equal(sound.status, contents["sound.mjs"] === undefined ? 404 : 200);
  if (contents["sound.mjs"] !== undefined) assert.equal(await sound.text(), contents["sound.mjs"]);
}

test("servers opened at upgrade boundaries always cache a complete old or new asset set", async t => {
  for (const legacy of [true, false]) {
    await t.test(legacy ? "Web Audio migration" : "versioned runtime upgrade", async t => {
      const root = await home(t);
      const { target, contents } = legacy ? await legacyInstallation(root) : await olderRuntime(root);
      const oldFactory = await serverFactory(await runtimePath(target));
      const expected = await sourceContents();
      const servers = [];
      t.after(() => Promise.all(servers.map(({ server }) => server.close())));
      const capture = async (factory, assets) => {
        const server = await startCanvas(factory);
        servers.push({ server, assets });
        await assertAssets(server, assets);
      };
      await capture(oldFactory, contents);
      const phases = new Set();
      intercept(t, "copyFile", async (copy, from, to) => {
        const result = await copy(from, to);
        if (to.includes("-bundle-") && ["server.mjs", "app.mjs", "index.html"].includes(basename(to))) {
          phases.add(`copy:${basename(to)}`);
          await capture(oldFactory, contents);
        }
        return result;
      });
      intercept(t, "rename", async (rename, from, to) => {
        const result = await rename(from, to);
        if (from.includes("-bundle-") && dirname(to) === join(target, "runtimes")) {
          phases.add("runtime");
          await capture(await serverFactory(to), expected);
          await capture(oldFactory, contents);
        }
        if (from.includes("-stage-") && dirname(to) === target) {
          assert.ok(["extension.mjs", marker].includes(basename(to)));
          phases.add(basename(to));
          await capture(await serverFactory(await runtimePath(target)), expected);
          await capture(oldFactory, contents);
        }
        return result;
      });
      await install(root);
      assert.deepEqual(phases, new Set(["copy:server.mjs", "copy:app.mjs", "copy:index.html", "runtime", "extension.mjs", marker]));
      for (const { server, assets } of servers) await assertAssets(server, assets);
      await capture(oldFactory, contents);
      assert.equal((await fs.readdir(join(target, "runtimes"))).length, legacy ? 1 : 2);
      if (legacy) assert.equal(await fs.readFile(join(target, "sound.mjs"), "utf8"), legacyAssets["sound.mjs"]);
    });
  }
});

test("failed activation keeps every server's runtime available and restores the previous entry point", async t => {
  for (const failingFile of ["extension.mjs", marker]) {
    await t.test(`failure after ${failingFile}`, async t => {
      const root = await home(t);
      const { target, contents } = await legacyInstallation(root);
      const previousMarker = await fs.readFile(join(target, marker), "utf8");
      const newContents = await sourceContents();
      const servers = [];
      t.after(() => Promise.all(servers.map(({ server }) => server.close())));
      let failed = false;
      intercept(t, "rename", async (rename, from, to) => {
        const result = await rename(from, to);
        if (from.includes("-stage-") && dirname(to) === target) {
          const server = await startCanvas(await serverFactory(await runtimePath(target)));
          servers.push({ server, contents: newContents });
          if (!failed && basename(to) === failingFile) {
            failed = true;
            throw new Error("Synthetic activation failure");
          }
        }
        return result;
      });
      await assert.rejects(install(root), /Synthetic activation failure/);
      assert.equal(await fs.readFile(join(target, "extension.mjs"), "utf8"), contents["extension.mjs"]);
      assert.equal(await fs.readFile(join(target, marker), "utf8"), previousMarker);
      for (const [file, content] of Object.entries(contents)) assert.equal(await fs.readFile(join(target, file), "utf8"), content);
      for (const entry of servers) await assertAssets(entry.server, entry.contents);
      const oldServer = await startCanvas(await serverFactory(target));
      servers.push({ server: oldServer, contents });
      await assertAssets(oldServer, contents);
      assert.equal((await fs.readdir(join(target, "runtimes"))).length, 1);
      await install(root);
      for (const entry of servers) await assertAssets(entry.server, entry.contents);
    });
  }
});

test("an interrupted bundle publication leaves an owned, reusable runtime without activating it", async t => {
  const root = await home(t);
  const { target, contents } = await legacyInstallation(root);
  const previousMarker = await fs.readFile(join(target, marker), "utf8");
  let failed = false;
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (!failed && from.includes("-bundle-") && dirname(to) === join(target, "runtimes")) {
      failed = true;
      throw new Error("Synthetic interrupted bundle publication");
    }
    return result;
  });
  await assert.rejects(install(root), /Synthetic interrupted bundle publication/);
  assert.equal(await fs.readFile(join(target, "extension.mjs"), "utf8"), contents["extension.mjs"]);
  assert.equal(await fs.readFile(join(target, marker), "utf8"), previousMarker);
  assert.equal((await fs.readdir(join(target, "runtimes"))).length, 1);
  await install(root);
  assert.equal((await fs.readdir(join(target, "runtimes"))).length, 1);
  assert.notEqual(await runtimePath(target), target);
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
});

test("failed first activation can be retried while a server from the failed attempt still works", async t => {
  const root = await home(t);
  const target = join(root, "extensions", "github-notifications");
  let server;
  let failed = false;
  t.after(() => server?.close());
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (!failed && from.includes("-stage-") && to === join(target, marker)) {
      failed = true;
      server = await startCanvas(await serverFactory(await runtimePath(target)));
      throw new Error("Synthetic first activation failure");
    }
    return result;
  });
  await assert.rejects(install(root), /Synthetic first activation failure/);
  assert.deepEqual(await fs.readdir(target), ["runtimes"]);
  await assertAssets(server, await sourceContents());
  await install(root);
  await assertAssets(server, await sourceContents());
});

test("a concurrent provider can save settings during publication without moving artifacts or losing the entry point", async t => {
  const root = await home(t);
  const target = await install(root);
  const directory = join(target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: false, groupBy: "none" });
  await fs.writeFile(join(directory, "user-note.txt"), "preserved");
  const before = await fs.stat(directory);
  let writes = 0;
  intercept(t, "rename", async (rename, from, to) => {
    assert.notEqual(from, target, "The installed directory must never disappear");
    if (from.includes("-stage-") && to === join(target, "extension.mjs")) {
      await writeFromProvider(directory, true);
      await fs.access(join(target, "extension.mjs"));
      writes++;
    }
    return rename(from, to);
  });
  await install(root);
  assert.equal(writes, 1);
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null, desktopNotifications: false, desktopSound: "default", groupBy: "none" });
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
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null, desktopNotifications: false, desktopSound: "default", groupBy: "repo" });
  assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
});

test("an artifacts-only destination created by a provider during staging is preserved", async t => {
  const root = await home(t);
  const target = join(root, "extensions", "github-notifications");
  const directory = join(target, "artifacts");
  let written = false;
  intercept(t, "copyFile", async (copy, from, to) => {
    if (!written && to.includes("-bundle-")) {
      written = true;
      await writeFromProvider(directory, true);
    }
    return copy(from, to);
  });
  await install(root);
  assert.equal(written, true);
  assert.deepEqual(await new Preferences({ directory }).read(), { autoOpen: true, darkMode: null, desktopNotifications: false, desktopSound: "default", groupBy: "repo" });
  await fs.access(join(target, "extension.mjs"));
});

test("publication failure restores the previous runtime and retains the latest concurrent settings", async t => {
  const root = await home(t);
  const { target, directory: oldRuntime, contents } = await olderRuntime(root);
  const previousEntry = await fs.readFile(join(target, "extension.mjs"), "utf8");
  const previousMarker = await fs.readFile(join(target, marker), "utf8");
  const directory = join(target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: false });
  let failed = false;
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (!failed && from.includes("-stage-") && to === join(target, "extension.mjs")) {
      failed = true;
      await writeFromProvider(directory, true);
      throw Object.assign(new Error("Synthetic publication failure"), { code: "EIO" });
    }
    return result;
  });
  await assert.rejects(install(root), /Synthetic publication failure/);
  assert.equal(await fs.readFile(join(target, "extension.mjs"), "utf8"), previousEntry);
  assert.equal(await fs.readFile(join(oldRuntime, "app.mjs"), "utf8"), contents["app.mjs"]);
  assert.equal(await fs.readFile(join(target, marker), "utf8"), previousMarker);
  assert.deepEqual(await preferences.read(), { autoOpen: true, darkMode: null, desktopNotifications: false, desktopSound: "default", groupBy: "repo" });
  await fs.access(join(target, "extension.mjs"));
  assert.deepEqual(await fs.readdir(join(root, "extensions")), ["github-notifications"]);
  await install(root);
});

test("rollback preserves an unexpected user edit and keeps original runtime backups for recovery", async t => {
  const root = await home(t);
  const target = await install(root);
  const oldEntry = await fs.readFile(join(target, "extension.mjs"), "utf8");
  intercept(t, "rename", async (rename, from, to) => {
    const result = await rename(from, to);
    if (from.includes("-stage-") && to === join(target, "extension.mjs")) {
      await fs.writeFile(to, "// Unrelated user edit.\n");
      throw new Error("Synthetic interrupted publication");
    }
    return result;
  });
  await assert.rejects(install(root), /rollback needs attention/);
  assert.equal(await fs.readFile(join(target, "extension.mjs"), "utf8"), "// Unrelated user edit.\n");
  await fs.access(join(target, "extension.mjs"));
  const parentEntries = await fs.readdir(join(root, "extensions"));
  const backup = parentEntries.find(name => name.startsWith(".github-notifications-backup-"));
  assert.ok(backup);
  assert.equal(await fs.readFile(join(root, "extensions", backup, "extension.mjs"), "utf8"), oldEntry);
  assert.equal(parentEntries.some(name => name.includes("install-lock")), false);
});

test("concurrent installers cannot interleave publication and the lock is released", async t => {
  const root = await home(t);
  let release;
  let entered;
  let paused = false;
  const ready = new Promise(resolve => { entered = resolve; });
  intercept(t, "copyFile", async (copy, from, to) => {
    if (!paused && to.includes("-bundle-")) {
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
