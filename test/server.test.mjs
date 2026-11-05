import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient, firstPage, POLL_MS } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { DesktopNotifications } from "../src/desktop.mjs";
import { Preferences } from "../src/settings.mjs";
import { http, thread } from "./fixtures.mjs";

async function setup(t, run = async () => http([thread()]), options = {}) {
  const client = new GitHubClient({ run: args => args.at(-1) === "graphql"
    ? http({ data: { repository: { pullRequest: { isInMergeQueue: false } } } })
    : /^\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/\d+$/.test(args.at(-1))
    ? http({ state: "open", merged: false, draft: false }) : run(args) });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, options);
  t.after(() => server.close());
  const url = new URL(server.url);
  const origin = url.origin;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: origin };
  return { ...server, origin, headers };
}

test("unreadable or invalid preferences warn without disabling a loaded inbox", async t => {
  for (const invalid of ["{", '{"autoOpen":"yes"}', '{"desktopSound":true}', '{"matchGitHubInbox":"all"}', "EACCES"]) {
    await t.test(invalid, async subtest => {
      const directory = await mkdtemp(join(tmpdir(), "notification-settings-recovery-"));
      const preferences = new Preferences({ directory });
      await preferences.update({ matchGitHubInbox: false });
      const valid = await readFile(preferences.path, "utf8");
      let denied = false;
      const io = preferences.io;
      preferences.io = { ...io, open: (...args) => denied
        ? Promise.reject(Object.assign(new Error("Synthetic access failure"), { code: "EACCES" }))
        : io.open(...args) };
      const rows = Array.from({ length: 53 }, (_, index) => thread(String(index + 1), { unread: index !== 0 }));
      const { origin, headers } = await setup(subtest, async args => {
        assert.ok(args.includes("GET"));
        const url = new URL(args.at(-1), "https://api.github.com");
        assert.equal(url.searchParams.get("all"), "false");
        const page = Number(url.searchParams.get("page"));
        const selected = rows.filter(row => row.unread);
        url.searchParams.set("page", String(page + 1));
        return http(selected.slice((page - 1) * 50, page * 50),
          selected.length > page * 50 ? { link: `<${url.href}>; rel="next"` } : {});
      }, { preferences });
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const call = async (path, method = "POST", body = {}) => {
        const response = await fetch(`${origin}/api/${path}`, {
          method, headers: { ...headers, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, data: await response.json() };
      };
      assert.equal((await call("refresh")).status, 200);
      if (invalid === "EACCES") denied = true;
      else await writeFile(preferences.path, invalid);
      for (const [path, method] of [["state", "GET"], ["refresh", "POST"], ["more", "POST"], ["filters", "POST"]]) {
        const { status, data } = await call(path, method);
        assert.equal(status, 200, path);
        assert.equal(data.settingsError.code, "settings_read", path);
        assert.equal(data.error, null);
        assert.equal(data.matchGitHubInbox, false);
        assert.equal(data.unread, data.loaded);
      }
      const settings = await call("settings", "GET");
      assert.equal(settings.status, 500);
      assert.equal(settings.data.error.code, "settings_read");
      assert.equal(await readFile(preferences.path, "utf8"), invalid === "EACCES" ? valid : invalid);
      denied = false;
      await writeFile(preferences.path, valid);
      const repaired = await call("state", "GET");
      assert.equal(repaired.status, 200);
      assert.equal(repaired.data.settingsError, null);
      assert.equal(repaired.data.loaded, 52);
    });
  }
});

test("HTTP integration serves a protected inbox, rejects cross-origin access and never enables CORS", async t => {
  const { origin, headers } = await setup(t);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /GitHub Notifications/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(html.headers.get("content-security-policy"), /default-src 'none'/);
  const sound = await fetch(`${origin}/sound.mjs`);
  assert.equal(sound.status, 404);
  const model = await fetch(`${origin}/model.mjs`);
  assert.equal(model.status, 200);
  assert.match(model.headers.get("content-type"), /javascript/);
  assert.match(await model.text(), /export function orderedThreads/);
  const unauthenticated = await fetch(`${origin}/api/state`);
  assert.equal(unauthenticated.status, 403);
  assert.equal((await unauthenticated.text()).includes("Synthetic"), false);
  for (const override of [{ Authorization: "Bearer wrong" }, { Origin: "https://evil.test" },
    { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await fetch(`${origin}/api/state`, { headers: { ...headers, ...override } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const refreshed = await fetch(`${origin}/api/refresh`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).loaded, 1);
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.equal((await state.json()).groups[0].items[0].title, "Synthetic notification 1");
});

test("methods, paths, origins, hosts, JSON, filter input and oversized bodies are checked", async t => {
  const { origin, headers } = await setup(t);
  for (const [path, method, body, expected] of [
    ["/api/state", "POST", "{}", 405],
    ["/api/refresh", "GET", undefined, 405],
    ["/api/state", "OPTIONS", undefined, 405],
    ["/api/filters", "POST", '{"mode":"done"}', 400],
    ["/api/filters", "POST", '{"mode":"all"}', 400],
    ["/api/filters", "POST", '{"attention":"bad"}', 400],
    ["/api/filters", "POST", '{"attention":null}', 400],
    ["/api/filters", "POST", '{"unexpected":true}', 400],
    ["/api/refresh", "POST", '{"unexpected":true}', 400],
    ["/api/refresh", "POST", '{"force":"true"}', 400],
    ["/api/refresh", "POST", '{"force":null}', 400],
    ["/api/refresh", "POST", '{"force":true,"unexpected":true}', 400],
    ["/api/refresh", "POST", "{", 400],
    ["/api/refresh", "POST", "null", 400],
    ["/api/refresh", "POST", "[]", 400],
    ["/api/state?token=x", "GET", undefined, 404],
    ["/extension.mjs", "GET", undefined, 404],
    ["/.git/config", "GET", undefined, 404],
    ["/", "POST", "{}", 405],
    ["/api/filters", "POST", JSON.stringify({ query: "x".repeat(5000) }), 413],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { ...headers, "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, expected, `${method} ${path}`);
  }
  const missingOrigin = await fetch(`${origin}/api/refresh`, {
    method: "POST", headers: { Authorization: headers.Authorization, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(missingOrigin.status, 403);
  const wrongType = await fetch(`${origin}/api/refresh`, { method: "POST", headers, body: "{}" });
  assert.equal(wrongType.status, 415);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(`${origin}/api/state`, { headers: { ...headers, Host: "evil.test" } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
});

test("HTTP filters combine attention and search without fetching or writing GitHub state", async t => {
  const calls = [];
  const { origin, headers } = await setup(t, async args => {
    calls.push(args);
    return http([thread("1", { reason: "review_requested" }), thread("2", { reason: "mention" })]);
  });
  const options = { method: "POST", headers: { ...headers, "Content-Type": "application/json" } };
  await fetch(`${origin}/api/refresh`, { ...options, body: "{}" });
  const response = await fetch(`${origin}/api/filters`, {
    ...options, body: JSON.stringify({ attention: "review_requested", query: "widgets" }),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.filters, { mode: "inbox", query: "widgets", attention: "review_requested" });
  assert.equal(state.loaded, 2);
  assert.equal(state.matching, 1);
  assert.deepEqual(state.groups[0].items.map(item => item.id), ["1"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("PATCH"), false);
});

test("separate panels have separate ephemeral ports/capabilities, and close releases the listener", async t => {
  const one = await setup(t);
  const two = await setup(t);
  assert.notEqual(one.origin, two.origin);
  assert.notEqual(one.headers.Authorization, two.headers.Authorization);
  const response = await fetch(`${two.origin}/api/state`, { headers: { ...two.headers, Authorization: one.headers.Authorization } });
  assert.equal(response.status, 403);
  await one.close();
  await one.close();
  await assert.rejects(fetch(one.origin));
  assert.equal((await fetch(two.origin)).status, 200);
});

test("HTTP force refresh bypasses the polling cache only when explicitly requested", async t => {
  let calls = 0;
  const { origin, headers } = await setup(t, async () => http([thread(String(++calls))]));
  const refresh = input => fetch(`${origin}/api/refresh`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  for (const [input, expected] of [[{}, "1"], [{ force: false }, "1"], [{ force: true }, "2"]]) {
    const response = await refresh(input);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).groups[0].items[0].id, expected);
  }
  assert.equal(calls, 2);
});

test("only successful foreground refreshes feed the desktop watcher, after updating the inbox", async t => {
  let fail = false;
  let syncs = 0;
  const inbox = new Inbox(new GitHubClient({ run: async () => fail ? http({}, {}, 500) : http([thread()]) }));
  let prepared = false;
  const desktop = {
    prepareForeground: async () => {
      assert.equal(inbox.client.sequence, syncs ? 1 : 0);
      prepared = true;
    },
    sync: async () => {
      syncs++;
      assert.equal(prepared, true);
      assert.equal(inbox.pages[0].sequence, 1);
      assert.equal(inbox.snapshot().groups[0].items[0].id, "1");
    },
  };
  const server = await startServer(inbox, { desktop });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const refresh = input => fetch(`${url.origin}/api/refresh`, {
    method: "POST", headers, body: JSON.stringify(input),
  });
  assert.equal((await refresh({})).status, 200);
  assert.equal(syncs, 1);
  assert.equal((await fetch(`${url.origin}/api/state`, { headers })).status, 200);
  assert.equal((await refresh({ force: "invalid" })).status, 400);
  assert.equal(syncs, 1);
  fail = true;
  assert.equal((await refresh({ force: true })).status, 502);
  assert.equal(syncs, 1);
});

test("HTTP notification reads inherit another client's server deadline before a watcher tick", async t => {
  for (const [path, input] of [["refresh", { force: true }], ["more", {}], ["filters", { mode: "unread" }]]) {
    const directory = await mkdtemp(join(tmpdir(), "notification-http-backoff-"));
    const preferences = new Preferences({ directory });
    await preferences.update({ desktopNotifications: true });
    let now = Date.parse("2026-01-10T12:00:00Z");
    let limited = false;
    const calls = [];
    const response = args => {
      const url = new URL(args.at(-1), "https://api.github.com");
      const page = Number(url.searchParams.get("page"));
      url.searchParams.set("page", "2");
      return http([thread(String(page), { subject: { type: "Unknown", title: "Synthetic", url: null } })],
        page === 1 ? { link: `<${url.href}>; rel="next"` } : {});
    };
    const writerClient = new GitHubClient({ now: () => now,
      run: async args => limited ? http({}, { "retry-after": "600" }, 429) : response(args) });
    const readerClient = new GitHubClient({ now: () => now, run: async args => { calls.push(args); return response(args); } });
    const watcher = client => new DesktopNotifications({
      preferences, client, now: () => now, schedule: () => 0, cancel: () => {},
      notify: async () => assert.fail("This scenario must not deliver notifications"),
    });
    const writer = watcher(writerClient);
    const reader = watcher(readerClient);
    writer.add("writer");
    reader.add("reader");
    await writer.check();
    await reader.check();
    const inbox = new Inbox(readerClient);
    await inbox.refresh();
    const server = await startServer(inbox, { preferences, desktop: reader });
    t.after(async () => {
      await server.close();
      await writer.close();
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    });
    now += POLL_MS;
    limited = true;
    await assert.rejects(writerClient.page(firstPage(), undefined, { force: true }), { code: "rate_limited" });
    await writer.check();
    assert.equal(readerClient.blockedUntil, 0, "the reader has not observed the new deadline yet");
    const url = new URL(server.url);
    const call = () => fetch(new URL(`/api/${path}`, url), {
      method: "POST",
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const before = calls.length;
    const blocked = await call();
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, "rate_limited");
    assert.equal(calls.length, before, `${path} must not start an uncached request`);
    now = writerClient.serverBlockedUntil;
    const resumed = await call();
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).loaded, path === "more" ? 2 : 1);
    await reader.foregroundPending;
  }
});

test("activation during an in-flight foreground request establishes a fresh generation-scoped baseline", async t => {
  for (const alreadyEnabled of [false, true]) {
    for (const external of [false, true]) {
      await t.test(`${alreadyEnabled ? "re-enable" : "enable"} ${external ? "in another session" : "through the panel"}`, async t => {
        const directory = await mkdtemp(join(tmpdir(), "notifications-activation-http-"));
        const preferences = new Preferences({ directory });
        if (alreadyEnabled) await preferences.update({ desktopNotifications: true });
        let now = Date.parse("2026-01-10T12:00:00Z");
        let rows = [thread("1")];
        let holdNext = false;
        let entered;
        let release;
        const started = new Promise(resolve => { entered = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const deliveries = [];
        const client = new GitHubClient({
          now: () => now,
          sleep: async delay => { now += delay; },
          run: async () => {
            const snapshot = http(rows);
            if (holdNext) {
              holdNext = false;
              entered();
              await held;
            }
            return snapshot;
          },
        });
        const desktop = new DesktopNotifications({
          preferences, client, now: () => now, platform: "darwin",
          notify: async message => { deliveries.push(message); },
        });
        const wake = desktop.wake.bind(desktop);
        desktop.wake = settings => {
          wake(settings);
          // Let the old response finish before the activation timer gets its turn.
          if (settings?.desktopNotifications === true) release();
        };
        desktop.add("activation-http");
        await desktop.check();
        const server = await startServer(new Inbox(client, { mode: "unread" }), { preferences, desktop, development: null });
        t.after(async () => {
          release();
          await server.close();
          await desktop.close();
          await rm(directory, { recursive: true, force: true });
        });
        const url = new URL(server.url);
        const post = async (path, body) => {
          const response = await fetch(new URL(path, url), {
            method: "POST",
            headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        const setEnabled = desktopNotifications => external
          ? preferences.update({ desktopNotifications })
          : post("/api/settings", { desktopNotifications });
        holdNext = true;
        const refreshing = post("/api/refresh", { force: true });
        await started;
        if (alreadyEnabled) await setEnabled(false);
        now += 1000;
        const preActivationTime = now;
        rows = [thread("2", { updated_at: new Date(now).toISOString() }), thread("1")];
        await setEnabled(true);
        release();
        await refreshing;
        await desktop.foregroundPending;
        const baseline = JSON.parse(await readFile(join(directory, "desktop-state.json"), "utf8"));
        assert.equal(baseline.watermark, preActivationTime);
        assert.equal(baseline.generation, (await preferences.document()).desktopGeneration);
        assert.equal(deliveries.length, 0);

        now += 1000;
        rows = [thread("3", { updated_at: new Date(now).toISOString() }), ...rows];
        await post("/api/refresh", { force: true });
        await desktop.foregroundPending;
        assert.deepEqual(deliveries.map(message => message.body), ["#42 Synthetic notification 3"]);
      });
    }
  }
});

test("desktop preparation failures remain explicit without blocking foreground notification reads", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notifications-prepare-http-"));
  const logs = [];
  const desktop = new DesktopNotifications({
    preferences: { directory, document: async () => { throw new Error("Synthetic settings failure"); } },
    client: new GitHubClient({ run: async () => assert.fail("Desktop requests must not run") }),
    log: (message, options) => { logs.push({ message, ...options }); },
    schedule: () => 0, cancel: () => {},
  });
  desktop.add("prepare-http");
  const server = await startServer(new Inbox(new GitHubClient({ run: async () => http([thread()]) })), { desktop });
  t.after(async () => {
    await server.close();
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = new URL(server.url);
  const response = await fetch(new URL("/api/refresh", url), {
    method: "POST",
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).loaded, 1);
  await desktop.foregroundPending;
  assert.equal(desktop.snapshot().state, "error");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "error");
  assert.doesNotMatch(logs[0].message, /Synthetic settings failure/);
});

test("HTTP errors remain explicit and contain no upstream response or stderr", async t => {
  const { origin, headers } = await setup(t, async () => http({ message: "DO NOT LEAK synthetic secret" }, {}, 401));
  const response = await fetch(`${origin}/api/refresh`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 401);
  const body = await response.text();
  assert.match(body, /gh auth login/);
  assert.equal(body.includes("DO NOT LEAK"), false);
});

test("UTF-8 titles and filters survive the complete HTTP path", async t => {
  const { origin, headers } = await setup(t, async () => http([thread("1", {
    subject: { title: "Synthetic caf\u00e9", type: "Issue", url: null },
  })]));
  const options = { method: "POST", headers: { ...headers, "Content-Type": "application/json" } };
  await fetch(`${origin}/api/refresh`, { ...options, body: "{}" });
  const response = await fetch(`${origin}/api/filters`, { ...options, body: '{"query":"caf\\u00e9"}' });
  assert.equal((await response.json()).matching, 1);
});
