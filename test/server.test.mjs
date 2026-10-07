import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { http, thread } from "./fixtures.mjs";

async function setup(t, run = async () => http([thread()])) {
  const client = new GitHubClient({ run });
  const inbox = new Inbox(client);
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const origin = url.origin;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: origin };
  return { ...server, origin, headers };
}

test("HTTP integration serves a protected inbox, rejects cross-origin access and never enables CORS", async t => {
  const { origin, headers } = await setup(t);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Unread Notifications/);
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
  const desktop = { sync: async ({ since }) => {
    syncs++;
    assert.equal(since, 0);
    assert.equal(inbox.pages[0].sequence, 1);
    assert.equal(inbox.snapshot().groups[0].items[0].id, "1");
  } };
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
