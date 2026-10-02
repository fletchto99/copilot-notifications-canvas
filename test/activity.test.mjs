import test from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../.github/extensions/github-notifications/inbox.mjs";
import { GitHubClient, POLL_MS } from "../.github/extensions/github-notifications/github.mjs";
import { http, next, thread } from "./fixtures.mjs";

const epoch = Date.parse("2026-01-10T12:00:00Z");
const updated = (id, time) => thread(id, { updated_at: new Date(time).toISOString() });

function setup(response = () => http([thread()])) {
  let now = epoch;
  const client = new GitHubClient({ now: () => now, run: async args => response(args.at(-1)) });
  return { inbox: new Inbox(client), advance() { now += POLL_MS; return now; } };
}

test("initial load, cached reads, unchanged 304 and searches are silent baselines", async () => {
  let requests = 0;
  const { inbox, advance } = setup(() => ++requests === 1 ?
    http([thread()], { etag: '"initial"' }) : http(null, {}, 304));
  await inbox.refresh();
  assert.deepEqual(inbox.snapshot().activity, { sequence: 0, latestAt: null });
  await inbox.refresh();
  assert.equal(requests, 1);
  advance();
  await inbox.refresh();
  assert.equal(requests, 2);
  await inbox.setFilters({ query: "no matching rows" });
  assert.equal(inbox.snapshot().matching, 0);
  assert.equal(inbox.summary().activity.sequence, 0);
});

test("new activity batches are independent of search and include later activity on existing IDs", async () => {
  let rows = [thread()];
  const { inbox, advance } = setup(() => http(rows));
  await inbox.refresh();
  await inbox.setFilters({ query: "no matching rows" });
  const later = advance();
  rows = [updated("2", later), updated("3", later - 1000), thread()];
  await inbox.refresh();
  assert.equal(inbox.snapshot().matching, 0);
  assert.deepEqual(inbox.snapshot().activity, { sequence: 1, latestAt: later });
  advance();
  await inbox.refresh();
  assert.equal(inbox.snapshot().activity.sequence, 1);
  const newest = advance();
  rows = [updated("1", newest), ...rows];
  await inbox.refresh();
  assert.deepEqual(inbox.snapshot().activity, { sequence: 2, latestAt: newest });
  await inbox.setFilters({ query: "" });
  assert.equal(inbox.summary().activity.sequence, 2);
});

test("loading older pages and promoting unseen older rows never count as arrivals", async () => {
  let firstRows = [thread()];
  let moreAvailable = true;
  const { inbox, advance } = setup(path => path.includes("page=1") ?
    http(firstRows, moreAvailable ? { link: next } : {}) : http([updated("2", epoch - 1000)]));
  await inbox.refresh();
  await inbox.more();
  assert.equal(inbox.summary().activity.sequence, 0);
  firstRows = [updated("3", epoch - 500)];
  moreAvailable = false;
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().loaded, 1);
  assert.equal(inbox.summary().activity.sequence, 0);
  const later = advance();
  firstRows = [updated("3", later)];
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 1);
});

test("load-more seeds known activity without ringing even if pages shift during pagination", async () => {
  let promoted = false;
  const { inbox, advance } = setup(path => path.includes("page=1") ?
    http([promoted ? updated("2", epoch + 1000) : thread()], { link: next }) :
    http([updated("2", epoch + 1000)]));
  await inbox.refresh();
  await inbox.more();
  promoted = true;
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 0);
});

test("an empty initial inbox ignores pre-baseline backlog but detects genuinely later activity", async () => {
  let rows = [];
  const { inbox, advance } = setup(() => http(rows));
  await inbox.refresh();
  advance();
  rows = [updated("1", epoch - 1000)];
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 0);
  const later = advance();
  rows = [updated("2", later)];
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 1);
});

test("partial refresh failures preserve the baseline and recover one batch without duplicate sounds", async () => {
  let later = epoch;
  let failSecondPage = false;
  const { inbox, advance } = setup(path => path.includes("page=1") ?
    http([updated("1", later)], { link: next }) :
    failSecondPage ? http({}, {}, 500) : http([updated("2", epoch - 1000)]));
  await inbox.refresh();
  await inbox.more();
  later = advance();
  failSecondPage = true;
  await assert.rejects(inbox.refresh(), { code: "github_http" });
  assert.equal(inbox.summary().activity.sequence, 0);
  assert.equal(inbox.activityWatermark, epoch);
  failSecondPage = false;
  advance();
  await inbox.refresh();
  assert.deepEqual(inbox.summary().activity, { sequence: 1, latestAt: later });
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 1);
});

test("same-time IDs, read rows and reappearing unchanged threads do not repeat activity", async () => {
  let rows = [thread()];
  const { inbox, advance } = setup(() => http(rows));
  await inbox.refresh();
  rows = [thread("2"), thread("3", { unread: false, updated_at: new Date(epoch + 500).toISOString() })];
  advance();
  await inbox.refresh();
  rows = [thread()];
  advance();
  await inbox.refresh();
  assert.equal(inbox.summary().activity.sequence, 0);
});
