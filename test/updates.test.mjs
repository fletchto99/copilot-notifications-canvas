import test from "node:test";
import assert from "node:assert/strict";
import { Updates, CURRENT_VERSION, CHECK_INTERVAL, REPOSITORY, compareVersions, versionParts } from "../.github/extensions/github-notifications/updates.mjs";
import { validateReleaseTag } from "../scripts/check-release.mjs";
import { InboxError } from "../.github/extensions/github-notifications/model.mjs";
import { http } from "./fixtures.mjs";

const release = (version = "0.2.0", fields = {}) =>
  ({ tag_name: `v${version}`, draft: false, prerelease: false, ...fields });

test("stable versions compare numerically and reject unsupported versions", () => {
  assert.ok(versionParts(CURRENT_VERSION));
  for (const [left, right, expected] of [
    ["1.10.0", "1.9.9", 1], ["2.0.0", "1.99.99", 1], ["0.1.0", "0.1.0", 0],
    ["0.0.9", "0.1.0", -1], ["1.0.9", "1.0.10", -1],
  ]) assert.equal(compareVersions(left, right), expected);
  for (const invalid of [null, 1, "", "v1.0.0", "01.0.0", "1.2", "1.0.0-rc.1",
    "1.0.0+build", "1.0.0\n", "9007199254740992.0.0", "<script>"]) {
    assert.equal(versionParts(invalid), null, String(invalid));
    assert.throws(() => compareVersions("1.0.0", invalid));
  }
});

test("release tags must match the checked-in stable version exactly", () => {
  assert.equal(validateReleaseTag(`v${CURRENT_VERSION}`), `v${CURRENT_VERSION}`);
  for (const tag of [undefined, "", CURRENT_VERSION, "v1.0.0-rc.1", "v999.0.0", "$(whoami)"]) {
    assert.throws(() => validateReleaseTag(tag));
  }
  assert.throws(() => validateReleaseTag("v1.0.0-rc.1", "1.0.0-rc.1"));
});

test("release checks use a fixed read-only GitHub endpoint and locally constructed links/prompts", async () => {
  const calls = [];
  const updates = new Updates({ version: "0.1.0", run: async args => {
    calls.push(args);
    return http(release("0.2.0", { html_url: "https://evil.test", body: "DO NOT TRUST THIS TEXT" }));
  } });
  assert.equal(updates.snapshot().status, "unchecked");
  const state = await updates.check();
  assert.equal(state.checking, false);
  assert.equal(state.status, "available");
  assert.equal(state.latestVersion, "0.2.0");
  assert.equal(state.releaseUrl, `https://github.com/${REPOSITORY}/releases/tag/v0.2.0`);
  assert.match(state.instructionsUrl, /#updating$/);
  assert.match(state.prompt, /exact release tag\nv0\.2\.0/);
  assert.match(state.prompt, /Preserve the entire installed artifacts directory in place/);
  assert.match(state.prompt, /settings\.json\nand unknown settings/);
  assert.match(state.prompt, /Do not delete or recreate it/);
  assert.match(state.prompt, /existing COPILOT_HOME/);
  assert.match(state.prompt, /Do not enable\nauto-update or change any preferences/);
  assert.doesNotMatch(JSON.stringify(state), /evil\.test|DO NOT TRUST/);
  assert.deepEqual(calls[0].slice(0, 7), ["api", "--hostname", "github.com", "--include", "--method", "GET", "-H"]);
  assert.equal(calls[0].at(-1), `/repos/${REPOSITORY}/releases/latest`);
});

test("checks coalesce across panels, cache for six hours, and throttle manual refreshes", async () => {
  let now = 10_000;
  let calls = 0;
  let finish;
  const updates = new Updates({ now: () => now, run: () => {
    calls++;
    return new Promise(resolve => { finish = () => resolve(http(release())); });
  } });
  const one = updates.check();
  const two = updates.check({ force: true });
  assert.equal(one, two);
  assert.equal(calls, 1);
  assert.equal(updates.snapshot().checking, true);
  finish();
  assert.deepEqual(await one, await two);
  assert.equal(updates.snapshot().nextCheckAt, now + CHECK_INTERVAL);
  now += 59_999;
  await updates.check({ force: true });
  assert.equal(calls, 1);
  now++;
  const manual = updates.check({ force: true });
  finish();
  await manual;
  assert.equal(calls, 2);
  now += CHECK_INTERVAL - 1;
  await updates.check();
  assert.equal(calls, 2);
  now++;
  const automatic = updates.check();
  finish();
  await automatic;
  assert.equal(calls, 3);
});

test("equal, older and absent releases never offer an update or downgrade", async () => {
  for (const [response, status] of [
    [http(release("0.1.0")), "current"],
    [http(release("0.0.9")), "ahead"],
    [http({}, {}, 404), "no_release"],
  ]) {
    const updates = new Updates({ version: "0.1.0", run: async () => response });
    const state = await updates.check();
    assert.equal(state.status, status);
    assert.equal(state.prompt, null);
    assert.equal(state.error, null);
    assert.ok(state.checkedAt);
  }
});

test("draft, prerelease and malformed metadata never reach links or the prompt", async () => {
  for (const response of [
    http(release("0.2.0", { draft: true })),
    http(release("0.2.0", { prerelease: true })),
    http(release("0.2.0-rc.1")),
    http(release("0.2.0", { tag_name: 'v2.0.0"; touch file' })),
    http(release("0.2.0", { tag_name: "v0.2.0\n" })),
    http(null), http([]), "HTTP/2 200 OK\r\n\r\n{",
    http({ message: "sensitive error" }, {}, 500),
  ]) {
    const logs = [];
    const updates = new Updates({ run: async () => response, log: (...args) => logs.push(args) });
    const state = await updates.check();
    assert.equal(state.status, "unchecked");
    assert.equal(state.checkedAt, null);
    assert.equal(state.prompt, null);
    assert.equal(state.releaseUrl, null);
    assert.ok(state.error);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify({ state, logs }), /touch file|sensitive error/);
  }
});

test("offline failures keep a last-known update and back off without claiming a successful check", async () => {
  let now = 1000;
  let offline = false;
  let calls = 0;
  const updates = new Updates({ version: "0.1.0", now: () => now, run: async () => {
    calls++;
    if (offline) throw new Error("sensitive raw failure");
    return http(release());
  } });
  await updates.check();
  offline = true;
  now += CHECK_INTERVAL;
  const failed = await updates.check();
  assert.equal(failed.status, "available");
  assert.equal(failed.checkedAt, 1000);
  assert.equal(failed.nextCheckAt, now + 30 * 60_000);
  assert.match(failed.error, /release check failed/);
  assert.doesNotMatch(JSON.stringify(failed), /sensitive/);
  await updates.check();
  assert.equal(calls, 2);
  now += 60_000;
  offline = false;
  assert.equal((await updates.check({ force: true })).error, null);
});

test("rate-limit retry headers apply even to manual requests", async () => {
  for (const headers of [
    { "retry-after": "7200" },
    { "retry-after": new Date(7_201_000).toUTCString() },
    { "x-ratelimit-reset": "7201" },
  ]) {
    let now = 1000;
    let calls = 0;
    const updates = new Updates({ now: () => now, run: async () => {
      calls++;
      return calls === 1 ? http({}, headers, 429) : http(release());
    } });
    const limited = await updates.check();
    assert.equal(limited.canCheckAt, 7_201_000);
    now += 7_199_999;
    await updates.check({ force: true });
    assert.equal(calls, 1);
    now++;
    assert.equal((await updates.check({ force: true })).status, "available");
    assert.equal(calls, 2);
  }
});

test("missing CLI errors remain actionable and shutdown aborts without logging or retrying", async () => {
  const missing = new Updates({ run: async () => {
    throw new InboxError("gh_missing", "Install GitHub CLI (gh), then restart the Copilot app.", 503);
  } });
  assert.match((await missing.check()).error, /Install GitHub CLI/);
  let signal;
  let finish;
  const logs = [];
  const updates = new Updates({ run: async (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, log: message => logs.push(message) });
  const pending = updates.check();
  updates.close();
  assert.equal(signal.aborted, true);
  finish(http(release()));
  await pending;
  assert.equal(updates.snapshot().status, "unchecked");
  assert.deepEqual(logs, []);
  assert.equal((await updates.check({ force: true })).status, "unchecked");
});
