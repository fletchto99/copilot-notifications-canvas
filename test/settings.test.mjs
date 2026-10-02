import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Preferences } from "../.github/extensions/github-notifications/settings.mjs";
import { startServer } from "../.github/extensions/github-notifications/server.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";

async function setup(t, io) {
  const directory = await fs.mkdtemp(join(tmpdir(), "notification-settings-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new Preferences({ directory, io });
}

test("settings default off, persist across instances and preserve unknown keys", async t => {
  const preferences = await setup(t);
  assert.deepEqual(await preferences.read(), { autoOpen: false });
  await fs.writeFile(preferences.path, '{"future":{"theme":"custom"},"autoOpen":false}');
  await preferences.update({ autoOpen: true });
  const other = new Preferences({ directory: preferences.directory });
  assert.deepEqual(await other.read(), { autoOpen: true });
  assert.deepEqual(JSON.parse(await fs.readFile(preferences.path, "utf8")).future, { theme: "custom" });
  await other.update({ autoOpen: false });
  assert.deepEqual(await preferences.read(), { autoOpen: false });
  assert.equal((await fs.stat(preferences.path)).mode & 0o777, 0o600);
});

test("malformed stored settings and invalid updates fail explicitly without overwriting data", async t => {
  const preferences = await setup(t);
  for (const data of ["{", "[]", "null", '{"autoOpen":"yes"}', " ".repeat(17000)]) {
    await fs.writeFile(preferences.path, data);
    await assert.rejects(preferences.read(), { code: "settings_read" });
    await assert.rejects(preferences.update({ autoOpen: true }), { code: "settings_read" });
    assert.equal(await fs.readFile(preferences.path, "utf8"), data);
  }
  for (const input of [null, [], {}, { autoOpen: "yes" }, { autoOpen: true, token: "not accepted" }]) {
    await assert.rejects(preferences.update(input), { code: "invalid_settings" });
  }
});

test("storage errors and concurrent-writer locks are actionable, not success-shaped", async t => {
  const preferences = await setup(t);
  await fs.writeFile(join(preferences.directory, ".settings.lock"), "");
  await assert.rejects(preferences.update({ autoOpen: true }), { code: "settings_busy" });
  await fs.unlink(join(preferences.directory, ".settings.lock"));
  const failing = new Preferences({ directory: preferences.directory, io: {
    ...fs, rename: async () => { throw new Error("synthetic disk error"); },
  } });
  await assert.rejects(failing.update({ autoOpen: true }), error =>
    error.code === "settings_write" && !error.message.includes("synthetic"));
  assert.deepEqual(await fs.readdir(preferences.directory), []);
  const denied = new Preferences({ directory: preferences.directory, io: {
    ...fs, open: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  } });
  await assert.rejects(denied.read(), { code: "settings_read" });
  await assert.rejects(denied.update({ autoOpen: true }), { code: "settings_write" });
});

test("settings HTTP routes require capability/origin and persist only the permitted preference", async t => {
  const preferences = await setup(t);
  const server = await startServer(new Inbox(new GitHubClient()), { preferences });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${url.origin}/api/settings`)).status, 403);
  assert.deepEqual(await (await fetch(`${url.origin}/api/settings`, { headers })).json(), { autoOpen: false });
  for (const [input, status] of [[{ autoOpen: true }, 200], [{ autoOpen: "yes" }, 400], [{ sound: true }, 400]]) {
    const response = await fetch(`${url.origin}/api/settings`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(response.status, status);
  }
  assert.deepEqual(await preferences.read(), { autoOpen: true });
  assert.equal((await fetch(`${url.origin}/api/settings`, {
    method: "POST", headers: { ...headers, Origin: "https://evil.test" }, body: '{"autoOpen":false}',
  })).status, 403);
});
