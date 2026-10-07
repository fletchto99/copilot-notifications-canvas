import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../.github/extensions/github-notifications/server.mjs";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient } from "../.github/extensions/github-notifications/github.mjs";
import { Updates } from "../.github/extensions/github-notifications/updates.mjs";
import { http, thread } from "./fixtures.mjs";

const stable = { tag_name: "v0.2.0", draft: false, prerelease: false };

async function panel(t, updates) {
  const server = await startServer(new Inbox(new GitHubClient({ run: async () => http([thread()]) })), { updates });
  t.after(() => server.close());
  const url = new URL(server.url);
  return {
    origin: url.origin,
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
  };
}

test("slow release checks never block the inbox, and all panels see one cached result", async t => {
  let resolve;
  let calls = 0;
  const updates = new Updates({ version: "0.1.0", run: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  t.after(() => updates.close());
  const one = await panel(t, updates);
  const two = await panel(t, updates);
  const response = await fetch(`${one.origin}/api/refresh`, {
    method: "POST", headers: one.headers, body: "{}",
  });
  const state = await response.json();
  assert.equal(state.loaded, 1);
  assert.equal(state.updates.checking, true);
  const second = await fetch(`${two.origin}/api/state`, { headers: two.headers });
  assert.equal((await second.json()).updates.checking, true);
  assert.equal(calls, 1);
  resolve(http(stable));
  await updates.pending;
  const checked = await fetch(`${one.origin}/api/state`, { headers: one.headers });
  assert.equal((await checked.json()).updates.status, "available");
  assert.equal(calls, 1);
});

test("manual checks require the capability, same origin, POST and an empty object", async t => {
  let calls = 0;
  const updates = new Updates({ version: "0.1.0", run: async () => { calls++; return http(stable); } });
  const { origin, headers } = await panel(t, updates);
  for (const [options, expected] of [
    [{ method: "POST", body: "{}" }, 403],
    [{ method: "GET", headers }, 405],
    [{ method: "POST", headers: { ...headers, Origin: "https://evil.test" }, body: "{}" }, 403],
    [{ method: "POST", headers: { ...headers, Origin: "" }, body: "{}" }, 403],
    [{ method: "POST", headers, body: '{"install":true}' }, 400],
    [{ method: "POST", headers, body: "null" }, 400],
  ]) {
    assert.equal((await fetch(`${origin}/api/updates`, options)).status, expected);
    assert.equal(calls, 0);
  }
  const checked = await fetch(`${origin}/api/updates`, { method: "POST", headers, body: "{}" });
  assert.equal(checked.status, 202);
  await updates.pending;
  assert.equal(calls, 1);
  assert.equal(updates.snapshot().status, "available");
  const again = await fetch(`${origin}/api/updates`, { method: "POST", headers, body: "{}" });
  assert.equal(again.status, 202);
  await updates.pending;
  assert.equal(calls, 2);
  const source = await fetch(`${origin}/updates.mjs`);
  assert.equal(source.status, 404);
});

test("release errors stay separate from notification state and settings", async t => {
  const updates = new Updates({ run: async () => { throw new Error("synthetic upstream failure"); } });
  const { origin, headers } = await panel(t, updates);
  await fetch(`${origin}/api/updates`, { method: "POST", headers, body: "{}" });
  await updates.pending;
  const response = await fetch(`${origin}/api/refresh`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.error, null);
  assert.equal(state.loaded, 1);
  assert.ok(state.updates.error);
  assert.doesNotMatch(JSON.stringify(state), /synthetic upstream failure/);
});
