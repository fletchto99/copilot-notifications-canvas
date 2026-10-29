import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Preferences } from "../src/settings.mjs";
import { startServer } from "../src/server.mjs";
import { Inbox } from "../src/inbox.mjs";
import { GitHubClient } from "../src/github.mjs";

const defaults = { autoOpen: false, darkMode: null, desktopNotifications: false, desktopSound: "default", groupBy: "repo", triageConsentVersion: 0 };

async function setup(t, io) {
  const directory = await fs.mkdtemp(join(tmpdir(), "notification-settings-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new Preferences({ directory, io });
}

test("settings default to auto-open off, app theme and repo grouping, persist across instances and preserve unknown keys", async t => {
  const preferences = await setup(t);
  assert.deepEqual(await preferences.read(), defaults);
  await fs.writeFile(preferences.path, '{"future":{"theme":"custom"},"autoOpen":false}');
  await preferences.update({ autoOpen: true });
  const other = new Preferences({ directory: preferences.directory });
  assert.deepEqual(await other.read(), { ...defaults, autoOpen: true });
  assert.deepEqual(JSON.parse(await fs.readFile(preferences.path, "utf8")).future, { theme: "custom" });
  await other.update({ autoOpen: false });
  assert.deepEqual(await preferences.read(), defaults);
  if (process.platform !== "win32") assert.equal((await fs.stat(preferences.path)).mode & 0o777, 0o600);
});

test("dark mode persists across instances without replacing auto-open or unknown preferences", async t => {
  const preferences = await setup(t);
  await fs.writeFile(preferences.path, '{"autoOpen":true,"future":42}');
  assert.deepEqual(await preferences.update({ darkMode: true }), { ...defaults, autoOpen: true, darkMode: true });
  const other = new Preferences({ directory: preferences.directory });
  assert.deepEqual(await other.read(), { ...defaults, autoOpen: true, darkMode: true });
  assert.deepEqual(await other.update({ autoOpen: false }), { ...defaults, darkMode: true });
  assert.deepEqual(await preferences.update({ darkMode: false }), { ...defaults, darkMode: false });
  assert.deepEqual(await other.read(), { ...defaults, darkMode: false });
  assert.equal(JSON.parse(await fs.readFile(preferences.path, "utf8")).future, 42);
  assert.deepEqual(await preferences.update({ autoOpen: true, darkMode: null }), { ...defaults, autoOpen: true });
  assert.deepEqual(await other.read(), { ...defaults, autoOpen: true });
});

test("all grouping choices persist across instances and survive unrelated settings updates", async t => {
  const preferences = await setup(t);
  await fs.writeFile(preferences.path, '{"autoOpen":true,"darkMode":false,"future":42}');
  const other = new Preferences({ directory: preferences.directory });
  for (const groupBy of ["none", "date", "repo"]) {
    assert.deepEqual(await preferences.update({ groupBy }), { ...defaults, autoOpen: true, darkMode: false, groupBy });
    assert.deepEqual(await other.read(), { ...defaults, autoOpen: true, darkMode: false, groupBy });
    await other.update({ darkMode: true });
    assert.deepEqual(await preferences.read(), { ...defaults, autoOpen: true, darkMode: true, groupBy });
    await other.update({ darkMode: false });
    assert.equal(JSON.parse(await fs.readFile(preferences.path, "utf8")).future, 42);
  }
});

test("malformed stored settings and invalid updates fail explicitly without overwriting data", async t => {
  const preferences = await setup(t);
  for (const data of ["{", "[]", "null", '{"autoOpen":"yes"}', '{"desktopNotifications":1}',
    '{"desktopSound":null}', '{"desktopGeneration":false}', '{"darkMode":"dark"}', '{"darkMode":0}',
    '{"groupBy":null}', '{"groupBy":"unknown"}', '{"groupBy":false}', '{"groupBy":[]}', " ".repeat(17000)]) {
    await fs.writeFile(preferences.path, data);
    await assert.rejects(preferences.read(), { code: "settings_read" });
    await assert.rejects(preferences.update({ autoOpen: true }), { code: "settings_read" });
    assert.equal(await fs.readFile(preferences.path, "utf8"), data);
  }
  for (const input of [null, [], {}, { autoOpen: "yes" }, { darkMode: "dark" }, { darkMode: 0 },
    { darkMode: undefined }, { autoOpen: null }, { autoOpen: true, token: "not accepted" },
    { groupBy: undefined }, { groupBy: null }, { groupBy: "unknown" }, { groupBy: "Repo" },
    { groupBy: false }, { groupBy: [] }, { groupBy: { value: "date" } }]) {
    await assert.rejects(preferences.update(input), { code: "invalid_settings" });
  }
});

test("triage acknowledgment stores only a version across instances and can be reset without losing settings", async t => {
  const preferences = await setup(t);
  await fs.writeFile(preferences.path, '{"future":{"keep":true},"autoOpen":true}');
  await preferences.update({ triageConsentVersion: 1 });
  const other = new Preferences({ directory: preferences.directory });
  assert.equal((await other.read()).triageConsentVersion, 1);
  await other.update({ darkMode: true });
  assert.equal((await preferences.read()).triageConsentVersion, 1);
  await preferences.update({ triageConsentVersion: 0 });
  assert.equal((await other.read()).triageConsentVersion, 0);
  assert.deepEqual(await other.document(), { future: { keep: true }, autoOpen: true, darkMode: true, triageConsentVersion: 0 });
  for (const value of [null, true, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(preferences.update({ triageConsentVersion: value }), { code: "invalid_settings" });
    await fs.writeFile(preferences.path, JSON.stringify({ triageConsentVersion: value }));
    await assert.rejects(preferences.read(), { code: "settings_read" });
  }
  await fs.writeFile(preferences.path, '{"triageConsentVersion":2,"future":true}');
  assert.equal((await other.read()).triageConsentVersion, 2, "Future versions are preserved, not treated as the current acknowledgment");
});

test("missing settings use defaults but explicit undefined and unknown patches are rejected", async t => {
  const preferences = await setup(t);
  const stored = JSON.parse('{"future":42,"constructor":"opaque","__proto__":{"keep":true},"desktopGeneration":"retained"}');
  await fs.writeFile(preferences.path, JSON.stringify(stored));
  assert.deepEqual(await preferences.read(), defaults);
  for (const key of Object.keys(defaults)) {
    await assert.rejects(preferences.update({ [key]: undefined }), { code: "invalid_settings" });
    const input = Object.defineProperty({ autoOpen: false, groupBy: "repo" }, key, { value: undefined, enumerable: false });
    await assert.rejects(preferences.update(input), { code: "invalid_settings" });
  }
  for (const key of Object.keys(stored)) {
    await assert.rejects(preferences.update({ [key]: true }), { code: "invalid_settings" });
  }
  await preferences.update({ groupBy: "date" });
  assert.deepEqual(await preferences.document(), { ...stored, groupBy: "date" });
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
  await assert.rejects(denied.update({ autoOpen: true }), { code: "settings_read" });
});

test("a crashed settings writer releases ownership on the next save without losing preferences", async t => {
  const preferences = await setup(t);
  await fs.writeFile(preferences.path, '{"autoOpen":false,"future":{"keep":true}}');
  const module = new URL("../src/settings.mjs", import.meta.url).href;
  const script = `
    import * as fs from "node:fs/promises";
    import { Preferences } from ${JSON.stringify(module)};
    const preferences = new Preferences({ directory: process.argv[1], io: {
      ...fs, rename: async () => process.exit(73),
    } });
    await preferences.update({ autoOpen: true });
  `;
  await assert.rejects(promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", script, preferences.directory]), { code: 73 });
  assert.equal((await preferences.read()).autoOpen, false);
  await new Preferences({ directory: preferences.directory }).update({ darkMode: true });
  assert.equal((await preferences.read()).darkMode, true);
  assert.deepEqual((await preferences.document()).future, { keep: true });
  assert.equal((await fs.readdir(preferences.directory)).includes(".settings.lock"), false);
});

test("live settings writers and legacy ownerless locks are never removed", async t => {
  const preferences = await setup(t);
  let entered;
  let finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const writer = new Preferences({ directory: preferences.directory, io: {
    ...fs, rename: async (...args) => { entered(); await waiting; return fs.rename(...args); },
  } });
  const saving = writer.update({ autoOpen: true });
  try {
    await ready;
    await assert.rejects(preferences.update({ darkMode: true }), { code: "settings_busy" });
  } finally {
    finish();
    await saving;
  }
  const lock = join(preferences.directory, ".settings.lock");
  await fs.writeFile(lock, "");
  await assert.rejects(preferences.update({ darkMode: true }),
    error => error.code === "settings_busy" && /legacy/i.test(error.message));
  assert.equal(await fs.readFile(lock, "utf8"), "");
  assert.equal((await preferences.read()).autoOpen, true);
});

test("settings size limits include the final newline and preserve oversized updates", async t => {
  const preferences = await setup(t);
  const overhead = Buffer.byteLength(`${JSON.stringify({ future: "", autoOpen: true }, null, 2)}\n`);
  for (const bytes of [16_383, 16_384, 16_385]) {
    const future = "x".repeat(bytes - overhead);
    const before = JSON.stringify({ future });
    await fs.writeFile(preferences.path, before);
    if (bytes > 16_384) {
      await assert.rejects(preferences.update({ autoOpen: true }), { code: "settings_write" });
      assert.equal(await fs.readFile(preferences.path, "utf8"), before);
    } else {
      await preferences.update({ autoOpen: true });
      assert.equal((await fs.stat(preferences.path)).size, bytes);
      assert.equal((await preferences.read()).autoOpen, true);
    }
  }
});

test("unknown settings lock contents are preserved and cleanup errors still release ownership", async t => {
  const preferences = await setup(t);
  const lock = join(preferences.directory, ".settings.lock");
  await fs.mkdir(lock);
  await fs.writeFile(join(lock, "keep.txt"), "unrecognized");
  await assert.rejects(preferences.update({ autoOpen: true }), { code: "settings_write" });
  assert.equal(await fs.readFile(join(lock, "keep.txt"), "utf8"), "unrecognized");
  await fs.unlink(join(lock, "keep.txt"));
  await fs.rmdir(lock);
  const failing = new Preferences({ directory: preferences.directory, io: {
    ...fs,
    rename: async () => { throw new Error("Synthetic publication failure"); },
    unlink: async () => { throw new Error("Synthetic cleanup failure"); },
  } });
  await assert.rejects(failing.update({ autoOpen: true }), { code: "settings_cleanup" });
  assert.equal((await fs.readdir(preferences.directory)).includes(".settings.lock"), false);
  await preferences.update({ autoOpen: true });
  assert.equal((await preferences.read()).autoOpen, true);
});

test("settings HTTP routes require capability/origin and persist only permitted preferences", async t => {
  const preferences = await setup(t);
  const server = await startServer(new Inbox(new GitHubClient()), { preferences });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${url.origin}/api/settings`)).status, 403);
  assert.deepEqual(await (await fetch(`${url.origin}/api/settings`, { headers })).json(), {
    ...defaults,
    desktopStatus: { supported: false, state: "off", message: "Desktop notifications are unavailable." },
  });
  for (const [input, status] of [[{ autoOpen: true }, 200], [{ darkMode: true }, 200],
    [{ groupBy: "none" }, 200], [{ groupBy: "repo" }, 200], [{ groupBy: "date" }, 200],
    [{ groupBy: "unknown" }, 400], [{ groupBy: null }, 400],
    [{ autoOpen: "yes" }, 400], [{ darkMode: "dark" }, 400], [{ sound: true }, 400]]) {
    const response = await fetch(`${url.origin}/api/settings`, { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(response.status, status);
    if (status === 200) {
      assert.deepEqual(await response.json(), {
        ...await preferences.read(),
        desktopStatus: { supported: false, state: "off", message: "Desktop notifications are unavailable." },
      });
    }
  }
  assert.deepEqual(await preferences.read(), { ...defaults, autoOpen: true, darkMode: true, groupBy: "date" });
  assert.deepEqual(await (await fetch(`${url.origin}/api/settings`, { headers })).json(), {
    ...defaults, autoOpen: true, darkMode: true, groupBy: "date",
    desktopStatus: { supported: false, state: "off", message: "Desktop notifications are unavailable." },
  });
  assert.equal((await fetch(`${url.origin}/api/settings`, {
    method: "POST", headers: { ...headers, Origin: "https://evil.test" }, body: '{"autoOpen":false}',
  })).status, 403);
});

test("desktop preference patches preserve other settings and create a fresh generation only on enabling", async t => {
  const preferences = await setup(t);
  await preferences.update({ autoOpen: true, groupBy: "none" });
  await preferences.update({ desktopNotifications: true });
  const initial = (await preferences.document()).desktopGeneration;
  assert.equal(typeof initial, "string");
  await preferences.update({ desktopSound: "Ping" });
  await preferences.update({ desktopNotifications: true });
  assert.equal((await preferences.document()).desktopGeneration, initial);
  assert.deepEqual(await preferences.read(), { ...defaults, autoOpen: true, desktopNotifications: true, desktopSound: "Ping", groupBy: "none" });
  await preferences.update({ desktopNotifications: false });
  await preferences.update({ desktopNotifications: true });
  assert.notEqual((await preferences.document()).desktopGeneration, initial);
  await assert.rejects(preferences.update({ desktopGeneration: "forged" }), { code: "invalid_settings" });
});

test("desktop settings require a supported backend and wake it only after an explicit authorized save", async t => {
  const preferences = await setup(t);
  const saves = [];
  const desktop = { supported: true, platform: "darwin", snapshot: () => ({ supported: true, state: "watching", message: "Watching" }),
    wake: settings => saves.push(settings) };
  const server = await startServer(new Inbox(new GitHubClient()), { preferences, desktop });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = input => fetch(`${url.origin}/api/settings`, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal((await post({ desktopNotifications: true })).status, 200);
  assert.equal((await post({ desktopSound: "Glass" })).status, 200);
  assert.equal(saves.length, 2);
  assert.equal(saves[1].desktopSound, "Glass");
  assert.equal((await post({ desktopSound: "Mail" })).status, 400);
  assert.equal((await post({ desktopSound: 'Glass"; run something' })).status, 400);
  desktop.supported = false;
  assert.equal((await post({ desktopNotifications: true })).status, 400);
  assert.equal(saves.length, 2);
  assert.equal((await post({ desktopNotifications: false })).status, 200);
});

test("stored desktop sound booleans are rejected without rewriting settings", async t => {
  const preferences = await setup(t);
  for (const value of [true, false]) {
    const content = JSON.stringify({ desktopSound: value, autoOpen: true, darkMode: false, future: 42 });
    await fs.writeFile(preferences.path, content);
    await assert.rejects(preferences.read(), { code: "settings_read" });
    await assert.rejects(preferences.update({ groupBy: "none" }), { code: "settings_read" });
    assert.equal(await fs.readFile(preferences.path, "utf8"), content);
    await assert.rejects(preferences.update({ desktopSound: value }), { code: "invalid_settings" });
  }
  await assert.rejects(preferences.update({ desktopSound: "../../file.wav" }), { code: "invalid_settings" });
});

test("system default is used only when no sound is saved, preserving explicit silence and named choices", async t => {
  const preferences = await setup(t);
  assert.equal((await preferences.read()).desktopSound, "default");
  for (const choice of ["none", "Submarine", "default"]) {
    await preferences.update({ desktopSound: choice });
    await preferences.update({ darkMode: true, autoOpen: true });
    assert.equal((await preferences.read()).desktopSound, choice);
  }
});
