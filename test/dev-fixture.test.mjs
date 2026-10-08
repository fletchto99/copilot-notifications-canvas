import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePreviewArgs, previewUsage, startPreview, runPreview } from "../scripts/dev-fixture.mjs";
import { createCanvasFixture } from "./canvas-fixtures.mjs";
import { getPreviewScenario, previewScenarios } from "./preview-scenarios.mjs";

function requests(url) {
  const { origin, hash } = new URL(url);
  const headers = { Authorization: `Bearer ${hash.slice(1)}`, Origin: origin, "Content-Type": "application/json" };
  return {
    origin,
    get: path => fetch(`${origin}${path}`, { headers }),
    post: async (path, input = {}, expectedStatus = 200) => {
      const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(input) });
      assert.equal(response.status, expectedStatus, `${path} returned ${response.status}`);
      return response.json();
    },
  };
}

test("preview arguments select only known presets and reject ambiguous, missing or extra arguments", async () => {
  assert.deepEqual(parsePreviewArgs([]), { scenario: "populated" });
  assert.deepEqual(parsePreviewArgs(["--help"]), { help: true });
  for (const scenario of Object.keys(previewScenarios)) {
    assert.deepEqual(parsePreviewArgs([`--scenario=${scenario}`]), { scenario });
    assert.deepEqual(parsePreviewArgs(["--scenario", scenario]), { scenario });
    assert.ok(previewUsage.includes(`${scenario}:`));
  }
  for (const args of [
    ["--scenario"], ["--live"], ["empty"], ["--scenario=empty", "--scenario=stale"],
    ["--scenario", "empty", "--help"], ["--help", "extra"], ["--scenario=empty", "extra"],
  ]) {
    assert.throws(() => parsePreviewArgs(args), /Invalid preview arguments/);
  }
  for (const scenario of ["", "unknown", "__proto__", "constructor", "toString"]) {
    assert.throws(() => parsePreviewArgs([`--scenario=${scenario}`]), /Unknown preview scenario/);
    await assert.rejects(startPreview({
      scenario, create: () => assert.fail("Invalid presets must fail before creating resources"),
    }), /Unknown preview scenario/);
  }
});

test("empty and long-title presets produce valid synthetic responses without changing user preferences", async t => {
  for (const scenario of ["empty", "long-titles"]) {
    await t.test(scenario, async t => {
      const preview = await startPreview({ scenario });
      t.after(() => preview.close());
      const { post } = requests(preview.url);
      const state = await post("/api/refresh");
      assert.equal(preview.scenario, scenario);
      assert.ok(state.development.branch.includes(`(${scenario})`));
      assert.equal(state.status, "ready");
      if (scenario === "empty") {
        assert.equal(state.loaded, 0);
        assert.equal(state.hasMore, false);
        assert.deepEqual(state.groups, []);
        assert.ok(Object.values(state.attentionCounts).every(count => count === 0));
      } else {
        assert.equal(state.loaded, 50);
        const items = state.groups.flatMap(group => group.items);
        assert.ok(items.some(item => item.title.length > 1000));
        assert.ok(items.some(item => /x{512}/.test(item.title)));
        assert.ok(items.some(item => item.repository.length > 150));
      }
      assert.equal((await preview.preferences.read()).autoOpen, false);
      assert.equal((await preview.preferences.read()).desktopNotifications, false);
      assert.deepEqual(preview.writes, []);
      assert.deepEqual(preview.deliveries, []);
      assert.deepEqual(preview.errors, []);
    });
  }
});

test("rate-limited preview uses real 429 handling and force refresh cannot bypass retry or exponential backoff", async t => {
  const preview = await startPreview({ scenario: "rate-limited" });
  t.after(() => preview.close());
  const { get, post } = requests(preview.url);
  const started = Date.now();
  assert.equal((await post("/api/refresh", {}, 429)).error.code, "rate_limited");
  const state = await (await get("/api/state")).json();
  assert.equal(state.status, "error");
  assert.equal(state.loaded, 0);
  assert.equal(state.error.code, "rate_limited");
  assert.ok(state.nextRefreshAt >= started + 120_000);
  const reads = () => preview.requests.filter(path => path.startsWith("/notifications?")).length;
  assert.equal(reads(), 1);
  await post("/api/refresh", { force: true }, 429);
  assert.equal(reads(), 1);
  const retried = preview.advance(120_001);
  await post("/api/refresh", { force: true }, 429);
  assert.equal(reads(), 2);
  assert.ok((await (await get("/api/state")).json()).nextRefreshAt >= retried + 240_000);
  await post("/api/settings", { darkMode: true });
  await post("/api/updates", {}, 202);
  assert.equal((await (await get("/api/state")).json()).updates.status, "current");
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.writes, []);
});

test("stale preview fails subsequent reads without discarding loaded rows or sharing failure state between instances", async t => {
  const preview = await startPreview({ scenario: "stale" });
  t.after(() => preview.close());
  const { get, post } = requests(preview.url);
  const initial = await post("/api/refresh");
  assert.equal(initial.status, "ready");
  assert.equal(initial.loaded, 50);
  const failedAt = Date.now();
  const failure = await post("/api/refresh", { force: true }, 502);
  assert.equal(failure.error.code, "github_http");
  assert.match(failure.error.message, /HTTP 503/);
  const stale = await (await get("/api/state")).json();
  assert.equal(stale.status, "stale");
  assert.equal(stale.loaded, 50);
  assert.deepEqual(stale.groups, initial.groups);
  assert.ok(stale.nextRefreshAt >= failedAt + 120_000);
  assert.equal((await post("/api/filters", { query: "Needle" })).matching, 3);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.writes, []);
  assert.deepEqual(preview.deliveries, []);
  const fresh = await startPreview({ scenario: "stale" });
  t.after(() => fresh.close());
  assert.equal((await requests(fresh.url).post("/api/refresh")).status, "ready");
});

test("error presets intercept notification reads only, not writes or release checks", () => {
  for (const name of ["rate-limited", "stale"]) {
    let hook;
    getPreviewScenario(name).configure({ setRequestHook: value => { hook = value; } });
    for (const args of [
      ["--method", "GET", "/repos/fletchto99/copilot-notifications-canvas/releases/latest"],
      ["--method", "PATCH", "/notifications/threads/1"],
    ]) assert.equal(hook(args), undefined);
  }
});

test("synthetic preview uses the protected server, temporary preferences and in-memory read updates", async t => {
  const preview = await startPreview();
  t.after(() => preview.close());
  const launcher = await readFile(new URL(preview.launcher), "utf8");
  assert.ok(launcher.includes(preview.url));
  if (process.platform !== "win32") {
    assert.equal((await stat(new URL(preview.launcher))).mode & 0o777, 0o600);
    assert.equal((await stat(preview.root)).mode & 0o777, 0o700);
  }
  assert.equal((await preview.preferences.read()).desktopNotifications, false);
  assert.equal((await preview.preferences.read()).autoOpen, false);
  assert.ok(preview.preferences.directory.startsWith(join(preview.root, "home")));
  const { origin, get, post } = requests(preview.url);
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert.equal((await fetch(`${origin}/api/state`)).status, 403);
  assert.equal((await fetch(origin)).status, 200);
  const initial = await post("/api/refresh");
  assert.equal(initial.loaded, 50);
  assert.ok(initial.development.branch.includes("synthetic preview"));
  assert.ok(Object.values(initial.attentionCounts).every(count => count > 0));
  assert.equal((await post("/api/more")).loaded, 53);
  assert.equal((await post("/api/filters", { query: "Needle" })).matching, 4);
  assert.equal((await post("/api/read", { id: "3" })).loaded, 52);
  assert.deepEqual(preview.writes, ["3"]);
  assert.equal(preview.rows[2].unread, false);
  await post("/api/settings", { darkMode: true, autoOpen: true });
  assert.equal((await preview.preferences.read()).darkMode, true);
  assert.equal((await preview.preferences.read()).autoOpen, true);
  assert.equal((await (await get("/api/state")).json()).updates.status, "current");
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.warnings, []);
  await Promise.all([preview.close(), preview.close()]);
  await assert.rejects(stat(preview.root), { code: "ENOENT" });
  await assert.rejects(fetch(origin));
});

test("enabling preview alerts only records synthetic deliveries and keeps the first baseline silent", async t => {
  const preview = await startPreview();
  t.after(() => preview.close());
  const { post } = requests(preview.url);
  await post("/api/settings", { desktopNotifications: true });
  await post("/api/refresh");
  await preview.desktop.sync();
  assert.deepEqual(preview.deliveries, []);
  preview.rows[0].updated_at = new Date(preview.advance(61_000)).toISOString();
  preview.rows[0].subject.title = "Synthetic preview alert";
  await post("/api/refresh", { force: true });
  await preview.desktop.sync();
  assert.deepEqual(preview.deliveries.map(alert => alert.body), ["Synthetic preview alert"]);
  assert.deepEqual(preview.errors, []);
});

test("preview instances do not share preferences, read state, listeners or launcher files", async t => {
  const one = await startPreview();
  t.after(() => one.close());
  const two = await startPreview();
  t.after(() => two.close());
  assert.notEqual(one.root, two.root);
  assert.notEqual(new URL(one.url).origin, new URL(two.url).origin);
  await one.preferences.update({ autoOpen: true });
  one.rows[0].unread = false;
  assert.equal((await two.preferences.read()).autoOpen, false);
  assert.equal(two.rows[0].unread, true);
  await one.close();
  assert.equal((await fetch(new URL(two.url).origin)).status, 200);
});

test("preview creation cleans up the fixture if writing the launcher fails", async () => {
  let fixture;
  await assert.rejects(startPreview({
    create: async options => { fixture = await createCanvasFixture(options); return fixture; },
    write: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
  }), { code: "EACCES" });
  await assert.rejects(stat(fixture.root), { code: "ENOENT" });
  await assert.rejects(fetch(new URL(fixture.url).origin));
});

test("preview forwards sanitized provider failures rather than hiding them in fixture assertions", async t => {
  const logs = [];
  const preview = await startPreview({ log: (message, options) => logs.push([message, options.level]) });
  t.after(() => preview.close());
  preview.desktop.setStatus("error", "Synthetic delivery failed.");
  assert.deepEqual(logs, [["Synthetic delivery failed.", "error"]]);
  assert.deepEqual(preview.errors, ["Synthetic delivery failed."]);
});

test("preview command handles both stop signals, startup races, and failure cleanup without logging capabilities", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const signals = new EventEmitter();
    let closed = 0;
    let output = "";
    await runPreview({
      signals, scenario: "empty",
      start: async options => {
        assert.deepEqual(options, { scenario: "empty" });
        return { launcher: "file:///synthetic/preview.html", url: "http://127.0.0.1:12345/#private",
          close: async () => { closed++; } };
      },
      write: text => { output += text; signals.emit(signal); signals.emit(signal); },
    });
    assert.equal(closed, 1);
    assert.match(output, /preview: empty/);
    assert.match(output, /file:\/\/\/synthetic\/preview\.html/);
    assert.doesNotMatch(output, /127\.0\.0\.1|#private/);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
  const signals = new EventEmitter();
  let closed = false;
  await runPreview({
    signals,
    start: async () => { signals.emit("SIGTERM"); return { close: async () => { closed = true; } }; },
    write: () => assert.fail("Do not report a preview that was stopped while starting"),
  });
  assert.equal(closed, true);
  await assert.rejects(runPreview({ signals, start: async () => { throw new Error("start failed"); } }), /start failed/);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  closed = false;
  await assert.rejects(runPreview({
    signals,
    start: async () => ({ close: async () => { closed = true; } }),
    write: () => { throw new Error("output failed"); },
  }), /output failed/);
  assert.equal(closed, true);
});

test("standalone preview runs without external tools and SIGTERM removes its private temporary files", {
  skip: process.platform === "win32", timeout: 20_000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), "notification-preview-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/dev-fixture.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--scenario", "empty"], {
    env: { ...process.env, PATH: home, COPILOT_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  let output = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const launcher = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Preview exited before startup")));
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = /^file:\/\/.+\/preview\.html$/m.exec(output);
      if (match) resolve(new URL(match[0]));
    });
  });
  const html = await readFile(launcher, "utf8");
  const url = /content="0; url=([^"]+)"/.exec(html)[1];
  const { post } = requests(url);
  assert.equal((await post("/api/refresh")).loaded, 0);
  assert.match(output, /preview: empty/);
  assert.ok(!output.includes(new URL(url).hash));
  assert.deepEqual(await readdir(home), []);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stderr, "");
  await assert.rejects(stat(launcher), { code: "ENOENT" });
  assert.deepEqual(await readdir(home), []);
});

test("preview CLI rejects unknown arguments rather than ignoring them", async () => {
  const script = fileURLToPath(new URL("../scripts/dev-fixture.mjs", import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--live"]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage: npm run dev:fixture/);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("preview CLI prints help without creating state and reports startup failures separately from argument errors", async t => {
  const home = await mkdtemp(join(tmpdir(), "notification-preview-help-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/dev-fixture.mjs", import.meta.url));
  const missing = join(home, "missing");
  const options = {
    env: { ...process.env, PATH: home, COPILOT_HOME: home, TMPDIR: missing, TMP: missing, TEMP: missing },
    timeout: 15_000,
  };
  const help = await promisify(execFile)(process.execPath, [script, "--help"], options);
  assert.equal(help.stdout, previewUsage);
  assert.equal(help.stderr, "");
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--scenario=typo"], options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown preview scenario/);
    assert.doesNotMatch(error.stderr, /Synthetic preview failed/);
    assert.equal(error.stdout, "");
    return true;
  });
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--scenario=empty"], options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Synthetic preview failed \(ENOENT\)/);
    assert.doesNotMatch(error.stderr, /Invalid preview arguments/);
    assert.equal(error.stdout, "");
    return true;
  });
  assert.deepEqual(await readdir(home), []);
});
