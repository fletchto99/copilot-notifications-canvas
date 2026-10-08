import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { Preferences } from "../src/settings.mjs";
import { InboxError } from "../src/model.mjs";
import { home } from "./install-fixtures.mjs";
import { syntheticTriage } from "./triage-fixtures.mjs";
import { http, thread } from "./fixtures.mjs";

test("triage HTTP actions require the panel capability, same-origin consent and the exact selection", async t => {
  let finish;
  let started = 0;
  const inbox = new Inbox(new GitHubClient({ run: async () => http([thread()]) }));
  await inbox.refresh();
  const preferences = new Preferences({ directory: await home(t) });
  const server = await startServer(inbox, { preferences, triageRun: async options => {
    started++;
    await new Promise(resolve => { finish = resolve; });
    return syntheticTriage(options);
  } });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const start = { selectionKey: inbox.shownSelection().selectionKey, consent: true };
  const post = (action, input, extra = {}) => fetch(new URL(`/api/triage/${action}`, url), {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input),
  });
  for (const extra of [{ Authorization: "" }, { Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await post("start", start, extra)).status, 403);
  }
  assert.equal((await post("start", { ...start, consent: false })).status, 400);
  assert.equal((await post("start", { ...start, selectionKey: "a".repeat(64) })).status, 409);
  assert.equal((await fetch(new URL("/api/triage/start", url), { headers })).status, 405);
  assert.equal(started, 0);
  const response = await post("start", start);
  assert.equal(response.status, 202);
  const state = await response.json();
  assert.equal(state.triage.status, "running");
  assert.equal((await post("start", start)).status, 409);
  assert.equal((await post("dismiss", { token: state.triage.token })).status, 409);
  assert.equal((await post("cancel", { token: "wrong" })).status, 409);
  assert.equal((await post("cancel", { token: state.triage.token })).status, 200);
  finish();
  let current;
  for (let i = 0; i < 20; i++) {
    current = await (await fetch(new URL("/api/state", url), { headers })).json();
    if (!current.triage.settling) break;
  }
  assert.equal(current.triage.status, "cancelled");
  assert.equal(current.triage.settling, false);
  assert.equal((await post("dismiss", { token: current.triage.token })).status, 200);
  assert.equal("triage" in inbox.summary(), false);
});

async function consentFixture(t, overrides = {}) {
  const preferences = overrides.preferences ?? new Preferences({ directory: await home(t) });
  const inbox = new Inbox(new GitHubClient({ run: async () => http([thread()]) }));
  await inbox.refresh();
  let runs = 0;
  const server = await startServer(inbox, { preferences, triageRun: async options => {
    runs++;
    return syntheticTriage(options);
  } });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (route, input) => fetch(new URL(`/api/${route}`, url), {
    method: "POST", headers, body: JSON.stringify(input),
  });
  return { inbox, preferences, post, runs: () => runs, selection: () => ({ selectionKey: inbox.shownSelection().selectionKey }) };
}

test("acknowledgment is saved once, subsequent starts omit consent, and reset is enforced across panels", async t => {
  const f = await consentFixture(t);
  assert.equal((await f.post("triage/start", f.selection())).status, 400);
  assert.equal(f.runs(), 0);
  assert.equal((await f.preferences.read()).triageConsentVersion, 0);
  const first = await f.post("triage/start", { ...f.selection(), consent: true });
  assert.equal(first.status, 202);
  const state = await first.json();
  assert.equal(state.settings.triageConsentVersion, 1);
  assert.equal((await f.preferences.read()).triageConsentVersion, 1);
  const other = await consentFixture(t, { preferences: new Preferences({ directory: f.preferences.directory }) });
  assert.equal((await other.post("triage/start", other.selection())).status, 202);
  assert.equal(other.runs(), 1);
  assert.equal((await f.post("settings", { triageConsentVersion: 0 })).status, 200);
  const resetPanel = await consentFixture(t, { preferences: f.preferences });
  assert.equal((await resetPanel.post("triage/start", resetPanel.selection())).status, 400);
  assert.equal(resetPanel.runs(), 0);
  for (const value of [true, 1, 2]) {
    assert.equal((await f.post("settings", { triageConsentVersion: value })).status, 400,
      "Settings may reset but cannot manufacture an acknowledgment");
  }
});

test("an unrecognized disclosure version requires new acknowledgment", async t => {
  const f = await consentFixture(t);
  await f.preferences.update({ triageConsentVersion: 2 });
  assert.equal((await f.post("triage/start", f.selection())).status, 400);
  assert.equal(f.runs(), 0);
  assert.equal((await f.preferences.read()).triageConsentVersion, 2);
  assert.equal((await f.post("triage/start", { ...f.selection(), consent: true })).status, 202);
  assert.equal((await f.preferences.read()).triageConsentVersion, 1);
});

test("failed preference reads or writes cannot launch AI or claim acknowledgment", async t => {
  for (const failure of ["read", "write"]) {
    const f = await consentFixture(t, { preferences: {
      read: async () => {
        if (failure === "read") throw new InboxError("settings_read", "Cannot read settings.", 500);
        return { triageConsentVersion: 0 };
      },
      update: async () => { throw new InboxError("settings_write", "Cannot save settings.", 500); },
    } });
    const response = await f.post("triage/start", { ...f.selection(), consent: true });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, `settings_${failure}`);
    assert.equal(f.runs(), 0);
  }
});

test("starting revalidates the shown selection after awaiting acknowledgment storage", async t => {
  let saving;
  let finish;
  const entered = new Promise(resolve => { saving = resolve; });
  const f = await consentFixture(t, { preferences: {
    read: async () => ({ triageConsentVersion: 0 }),
    update: async () => {
      saving();
      await new Promise(resolve => { finish = resolve; });
      return { triageConsentVersion: 1 };
    },
  } });
  const response = f.post("triage/start", { ...f.selection(), consent: true });
  await entered;
  await f.inbox.setFilters({ query: "absent" });
  finish();
  assert.equal((await response).status, 409);
  assert.equal(f.runs(), 0);
});

test("triage without a preferences service fails explicitly", async t => {
  const inbox = new Inbox(new GitHubClient());
  const server = await startServer(inbox);
  t.after(() => server.close());
  const url = new URL(server.url);
  const response = await fetch(new URL("/api/triage/start", url), {
    method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ selectionKey: inbox.shownSelection().selectionKey, consent: true }),
  });
  assert.equal(response.status, 503);
});
