import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Preferences } from "../src/settings.mjs";
import { acquireLock } from "../src/lock.mjs";
import { fixture, home } from "./install-fixtures.mjs";

test("platform filesystem supports bundle replacement and preserves settings across upgrades", async t => {
  const first = await fixture(t);
  await first.install();
  const directory = join(first.target, "artifacts");
  const preferences = new Preferences({ directory });
  await preferences.update({ autoOpen: true, groupBy: "date" });
  await writeFile(join(directory, "keep.txt"), "preserved");
  const upgraded = await fixture(t, { root: first.root, version: "2.0.0" });
  assert.equal((await upgraded.install()).status, "installed");
  assert.equal((await upgraded.install()).status, "current");
  assert.equal(await readFile(join(first.target, "extension.mjs"), "utf8"), upgraded.content);
  assert.equal((await preferences.read()).groupBy, "date");
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "preserved");
  await assert.rejects(first.install(), /downgrade/);
  assert.deepEqual((await readdir(first.target)).sort(), ["artifacts", "extension.mjs"]);
});

test("platform directory locks exclude live owners and recover a crashed process", async t => {
  const directory = await home(t);
  const path = join(directory, "lock");
  const release = await acquireLock(path);
  try {
    assert.equal(await acquireLock(path), null);
  } finally {
    await release();
  }
  const module = new URL("../src/lock.mjs", import.meta.url).href;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import { acquireLock } from ${JSON.stringify(module)}; await acquireLock(process.argv[1]); process.exit(73);`, path]),
  { code: 73 });
  const recovered = await acquireLock(path);
  assert.equal(typeof recovered, "function");
  await recovered();
  assert.deepEqual(await readdir(directory), []);
});
