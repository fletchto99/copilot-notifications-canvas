import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { install } from "../scripts/install.mjs";
import { inspectBundle } from "../scripts/package.mjs";
import { fixture, home } from "./install-fixtures.mjs";

test("installation publishes only one owned bundle and an already-current install changes nothing", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.install(), { target: f.target, version: f.version, status: "installed" });
  assert.deepEqual(await readdir(f.target), ["extension.mjs"]);
  const path = join(f.target, "extension.mjs");
  const before = await stat(path);
  assert.equal(inspectBundle(await readFile(path)).version, f.version);
  assert.equal((await f.install()).status, "current");
  assert.equal((await stat(path)).ino, before.ino);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(join(f.root, "extensions")), ["github-notifications"]);
});

test("upgrades replace the entire runtime without leaving old code, assets, or metadata files", async t => {
  const old = await fixture(t);
  await old.install();
  const next = await fixture(t, { root: old.root, version: "1.1.0" });
  assert.equal((await next.install()).status, "installed");
  assert.equal(await readFile(join(old.target, "extension.mjs"), "utf8"), next.content);
  assert.deepEqual(await readdir(old.target), ["extension.mjs"]);
  assert.deepEqual(await readdir(join(old.root, "extensions")), ["github-notifications"]);
});

test("fresh installs and upgrades preserve the artifacts directory and all contents in place", async t => {
  const f = await fixture(t);
  const directory = join(f.target, "artifacts");
  await mkdir(directory, { recursive: true });
  const settings = '{"autoOpen":true,"darkMode":true,"desktopNotifications":true,"desktopSound":"default","future":{"x":42}}\n';
  await writeFile(join(directory, "settings.json"), settings);
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "keep.txt"), "untouched");
  const before = await stat(directory);
  await f.install();
  await (await fixture(t, { root: f.root, version: "2.0.0" })).install();
  assert.equal(await readFile(join(directory, "settings.json"), "utf8"), settings);
  assert.equal(await readFile(join(directory, "nested", "keep.txt"), "utf8"), "untouched");
  assert.equal((await stat(directory)).ino, before.ino);
});

test("downgrades and different contents under the same version are refused", async t => {
  const f = await fixture(t);
  await f.install();
  await assert.rejects((await fixture(t, { root: f.root, version: "0.9.0" })).install(), /downgrade/);
  await assert.rejects((await fixture(t, { root: f.root, code: "export const different = true;\n" })).install(), /same version/);
  assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), f.content);
});

test("legacy flat and versioned installations require explicit offline migration and are never changed", async t => {
  for (const version of [1, 2]) {
    const f = await fixture(t);
    await mkdir(f.target, { recursive: true });
    await writeFile(join(f.target, "extension.mjs"), "old provider with local edits");
    await writeFile(join(f.target, ".copilot-notifications-install.json"), JSON.stringify({ version }));
    if (version === 2) await mkdir(join(f.target, "runtimes"));
    else await writeFile(join(f.target, "sound.mjs"), "old sound");
    const before = await readdir(f.target);
    await assert.rejects(f.install(), /Legacy installation.*one-time migration/);
    assert.deepEqual(await readdir(f.target), before);
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "old provider with local edits");
  }
});

test("unowned files, malformed headers and edited bundles are preserved", async t => {
  for (const change of [
    f => writeFile(join(f.target, "extension.mjs"), "unrelated source code"),
    f => writeFile(join(f.target, "extension.mjs"), f.content + "// local edit\n"),
    f => writeFile(join(f.target, "extension.mjs"), f.content.replace('"version":"1.0.0"', '"version":"9.0.0"')),
    f => writeFile(join(f.target, "extension.mjs"), f.content.replace('"format":1', '"note":"local edit","format":1')),
    f => writeFile(join(f.target, "extension.mjs"), "// copilot-notifications-bundle: {\ninvalid\n"),
    f => writeFile(join(f.target, "notes.txt"), "user notes"),
  ]) {
    const f = await fixture(t);
    await f.install();
    await change(f);
    const before = await readFile(join(f.target, "extension.mjs"), "utf8");
    await assert.rejects(f.install(), /modified|modifications|unrelated|Unrecognized/);
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), before);
  }
});

test("symlinked installation, artifacts and runtime paths are never followed", async t => {
  for (const location of ["target", "artifacts", "extension.mjs"]) {
    const f = await fixture(t);
    const elsewhere = await home(t);
    await writeFile(join(elsewhere, "keep.mjs"), f.content);
    await mkdir(join(f.root, "extensions"));
    if (location === "target") await symlink(elsewhere, f.target);
    else {
      await mkdir(f.target);
      await symlink(location === "artifacts" ? elsewhere : join(elsewhere, "keep.mjs"), join(f.target, location));
    }
    await assert.rejects(f.install(), /symlink/);
    assert.equal(await readFile(join(elsewhere, "keep.mjs"), "utf8"), f.content);
  }
});

test("missing, extra, symlinked and checksum-invalid package files fail before installation", async t => {
  for (const change of [
    f => unlink(join(f.directory, "install.mjs")),
    f => writeFile(join(f.directory, "extra.txt"), "unexpected"),
    f => writeFile(join(f.directory, "extension.mjs"), "corrupt"),
    f => writeFile(join(f.directory, "install.mjs"), "corrupt"),
    async f => {
      await unlink(join(f.directory, "extension.mjs"));
      await symlink(join(f.directory, "install.mjs"), join(f.directory, "extension.mjs"));
    },
    f => writeFile(join(f.directory, "release.json"), JSON.stringify({ ...f.manifest, version: "2.0.0" })),
    f => writeFile(join(f.directory, "release.json"), JSON.stringify({ ...f.manifest, hashes: {} })),
    f => writeFile(join(f.directory, "release.json"), "{"),
  ]) {
    const f = await fixture(t);
    await change(f);
    await assert.rejects(f.install());
    assert.deepEqual(await readdir(f.root), []);
  }
});

test("package version and tag must agree, including the bundle's embedded version", async t => {
  const f = await fixture(t);
  for (const tag of [undefined, "", "1.0.0", "v1.0.0-rc.1", "v2.0.0", "v1.0.0\n"]) {
    await assert.rejects(install({ home: f.root, directory: f.directory, tag }));
  }
  await writeFile(join(f.directory, "release.json"), JSON.stringify({ ...f.manifest, version: "2.0.0" }));
  await assert.rejects(install({ home: f.root, directory: f.directory, tag: "v2.0.0" }), /Bundle version/);
  assert.deepEqual(await readdir(f.root), []);
});

test("the source installer refuses source-based installation and missing CLI arguments", async t => {
  const root = await home(t);
  const script = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
  for (const args of [[], ["v0.2.0"], ["v0.2.0", "--force"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, [script, ...args],
      { env: { ...process.env, COPILOT_HOME: root } }), { code: 1 });
  }
  assert.deepEqual(await readdir(root), []);
});
