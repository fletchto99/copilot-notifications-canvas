import test from "node:test";
import assert from "node:assert/strict";
import { attentionCounts, attentionFilters, dateLabel, filterSchema, groupThreads, groupThreadsByDate, normalizeThreads, notificationLink, notificationTitle, orderedThreads, validateFilters } from "../src/model.mjs";
import { thread } from "./fixtures.mjs";

test("calendar grouping uses the requested zone rather than the provider's local date", () => {
  const items = normalizeThreads([
    thread("1", { updated_at: "2026-01-01T00:30:00Z" }),
    thread("2", { updated_at: "2026-01-01T08:30:00Z" }),
    thread("3", { updated_at: "2026-01-02T08:30:00Z", unread: false }),
  ]);
  const west = groupThreadsByDate(items, "America/Los_Angeles");
  assert.deepEqual(west.map(group => [group.date, group.items.map(item => item.id)]), [
    ["2026-01-01", ["2"]], ["2025-12-31", ["1"]],
  ]);
  assert.equal(west[0].key, "date:2026-1-1");
  assert.equal(west[0].timeZone, "America/Los_Angeles");
  assert.equal(west[0].label, dateLabel("2026-01-01"));
  const east = groupThreadsByDate(items, "Asia/Tokyo");
  assert.deepEqual(east.map(group => [group.date, group.items.map(item => item.id)]), [["2026-01-01", ["2", "1"]]]);
  assert.equal(east[0].unread, 2);
});

test("calendar grouping rejects unsupported zones and surfaces unexpected formatter failures", t => {
  for (const zone of [undefined, null, 1, "", "x".repeat(129), "Invalid/Zone"]) {
    assert.throws(() => groupThreadsByDate([], zone), { code: "invalid_time_zone", status: 400 });
  }
  const failure = new Error("Synthetic formatter failure");
  t.mock.method(Intl, "DateTimeFormat", function () { throw failure; });
  assert.throws(() => groupThreadsByDate([], "UTC"), error => error === failure);
});

test("groups alphabetically while deduplicating and ordering notifications newest first, then by ID", () => {
  const items = normalizeThreads([
    thread("1", { updated_at: "2026-01-01T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/another" }, updated_at: "2026-01-15T00:00:00Z" }),
    thread("1", { updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { unread: false }),
    thread("5", { updated_at: "2026-01-20T00:00:00Z" }),
    thread("4", { updated_at: "2026-01-10T00:00:00Z" }),
  ]);
  const groups = groupThreads(items, { query: "" });
  assert.deepEqual(groups.map(group => group.repository), ["example/another", "example/widgets"]);
  assert.deepEqual(groups[1].items.map(item => item.id), ["1", "5", "4"]);
  assert.equal(groups[1].unread, 3);
  assert.equal(orderedThreads(items).length, 5);
  assert.equal(groupThreads(items, { query: " WIDGETS " })[0].items.length, 3);
  assert.equal(groupThreads(items, { query: "synthetic notification 2" })[0].repository, "example/another");
  assert.deepEqual(groupThreads(items, { query: "missing" }), []);
  assert.deepEqual(groupThreads(items, { query: "synthetic notification 3" }), []);
});

test("group order follows the full repository name regardless of activity, input order or search", () => {
  const items = normalizeThreads([
    thread("1", { repository: { full_name: "zeta/alpha" }, updated_at: "2026-01-30T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/Zebra" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { repository: { full_name: "Alpha/widgets" }, updated_at: "2026-01-10T00:00:00Z" }),
    thread("4", { repository: { full_name: "example/another" }, updated_at: "2026-01-01T00:00:00Z" }),
  ]);
  for (const threads of [items, [...items].reverse()]) {
    assert.deepEqual(groupThreads(threads, { query: "" }).map(group => group.repository),
      ["Alpha/widgets", "example/another", "example/Zebra", "zeta/alpha"]);
    assert.deepEqual(groupThreads(threads, { query: "example/" }).map(group => group.repository),
      ["example/another", "example/Zebra"]);
  }
});

test("attention filters use exact notification reasons and combine with unread search", () => {
  const reasons = ["review_requested", "mention", "team_mention", "assign", "author", "comment",
    "subscribed", "manual", "state_change", "security_alert", "unknown", "constructor"];
  const items = normalizeThreads(reasons.map((reason, index) => thread(String(index + 1), { reason })));
  const expected = {
    all: reasons, review_requested: ["review_requested"], mentioned: ["mention", "team_mention"],
    assigned: ["assign"], participating: ["author", "comment"],
  };
  for (const [attention, selected] of Object.entries(expected)) {
    const groups = groupThreads([...items, { ...items[0], id: "99", unread: false }], { query: "", attention });
    assert.deepEqual(groups[0].items.map(item => item.reason).sort(), [...selected].sort());
    assert.equal(groups[0].unread, selected.length);
  }
  assert.deepEqual(groupThreads(items, { query: "notification 3", attention: "mentioned" })[0].items.map(item => item.id), ["3"]);
  assert.deepEqual(groupThreads(items, { query: "notification 3", attention: "assigned" }), []);
  assert.throws(() => groupThreads(items, { query: "", attention: "invalid" }), { code: "invalid_filters" });
});

test("attention counts include every deduplicated unread notification", () => {
  const items = normalizeThreads([
    thread("1", { reason: "review_requested" }),
    thread("2", { reason: "mention" }),
    thread("3", { reason: "team_mention" }),
    thread("4", { reason: "assign" }),
    thread("5", { reason: "author" }),
    thread("6", { reason: "comment" }),
    thread("7", { reason: "unknown" }),
    thread("8", { reason: "mention", unread: false }),
    thread("1", { reason: "mention", updated_at: "2026-01-01T00:00:00Z" }),
  ]);
  for (const threads of [items, [...items].reverse()]) {
    const counts = attentionCounts(threads);
    assert.deepEqual(counts,
      { all: 7, review_requested: 1, mentioned: 2, assigned: 1, participating: 2 });
    for (const filter of attentionFilters) {
      const groups = groupThreads(threads, { query: "", attention: filter.value });
      assert.equal(counts[filter.value], groups.reduce((total, group) => total + group.items.length, 0));
    }
  }
  assert.deepEqual(attentionCounts([]),
    { all: 0, review_requested: 0, mentioned: 0, assigned: 0, participating: 0 });
});

test("known API subject links become safe GitHub web links", () => {
  for (const [type, path, expected, number] of [
    ["Issue", "issues/7", "issues/7", "7"],
    ["PullRequest", "pulls/8", "pull/8", "8"],
    ["Commit", "commits/abcdef0123456", "commit/abcdef0123456", null],
    ["Discussion", "discussions/9", "discussions/9", null],
  ]) {
    const result = notificationLink({ type, url: `https://api.github.com/repos/example/widgets/${path}` }, "example/widgets");
    assert.equal(result.url, `https://github.com/example/widgets/${expected}`);
    assert.equal(result.direct, true);
    assert.equal(result.number, number);
  }
});

test("release IDs and check-suite IDs are never mistaken for web tags or run IDs", () => {
  for (const [type, suffix] of [["Release", "releases"], ["CheckSuite", "actions"]]) {
    const result = notificationLink({ type, url: `https://api.github.com/repos/example/widgets/${suffix}/123` }, "example/widgets");
    assert.equal(result.url, `https://github.com/example/widgets/${suffix}`);
    assert.equal(result.direct, false);
    assert.equal(result.number, null);
    assert.match(result.label, /^Open repository/);
  }
});

test("unsafe, unsupported, null and cross-repository URLs fall back honestly", () => {
  for (const url of [
    null, undefined, "javascript:alert(1)", "http://api.github.com/repos/example/widgets/issues/2",
    "https://api.github.com.evil.test/repos/example/widgets/issues/2",
    "https://secret@api.github.com/repos/example/widgets/issues/2",
    "https://api.github.com/repos/example/other/issues/2",
    "https://api.github.com/repos/example/widgets/issues/2?next=https://evil.test",
    "https://api.github.com/repos/example/widgets/issues/2#oops",
    "https://api.github.com/repos/example/widgets/issues/%2e%2e",
    "https://api.github.com/repos/example/widgets/issues/0",
    "https://api.github.com/repos/example/widgets/issues/01",
    "https://api.github.com/repos/example/widgets/issues/7/comments",
    "https://api.github.com/repos/example/widgets/pulls/7",
  ]) {
    const result = notificationLink({ type: "Issue", url }, "example/widgets");
    assert.equal(result.url, "https://github.com/notifications");
    assert.equal(result.direct, false);
    assert.equal(result.number, null);
  }
  assert.equal(notificationLink({ type: "Unknown", url: null }, "example/widgets").direct, false);
  for (const type of ["__proto__", "constructor", "toString"]) {
    assert.equal(notificationLink({ type, url: null }, "example/widgets").direct, false);
  }
  assert.equal(notificationLink({ type: "Release" }, "example/..").url, "https://github.com/notifications");
});

test("issue and PR numbers come from validated subject links, not notification thread IDs", () => {
  const title = "<img src=x onerror=alert(1)> Fix login";
  for (const [type, path] of [["Issue", "issues"], ["PullRequest", "pulls"]]) {
    for (const number of ["42", "9007199254740993"]) {
      const [item] = normalizeThreads([thread("987654321", {
        subject: { title, type, url: `https://api.github.com/repos/example/widgets/${path}/${number}` },
      })]);
      assert.equal(item.id, "987654321");
      assert.equal(item.title, title);
      assert.equal(item.number, number);
      assert.equal(notificationTitle(item), `#${number} ${title}`);
      for (const query of [number, `#${number}`]) {
        assert.deepEqual(groupThreads([item], { query })[0].items, [item]);
      }
      assert.deepEqual(groupThreads([item], { query: "#987654321" }), []);
    }
  }
});

test("unnumbered notifications keep their titles and empty titles keep display fallbacks", () => {
  for (const [type, path] of [
    ["Issue", null], ["PullRequest", "issues/7"], ["Release", "releases/7"],
    ["CheckSuite", "check-suites/7"], ["Commit", "commits/abcdef0123456"],
    ["Discussion", "discussions/7"], ["Unknown", "issues/7"],
  ]) {
    const [item] = normalizeThreads([thread("987654321", {
      subject: { title: "Unnumbered title", type, url: path && `https://api.github.com/repos/example/widgets/${path}` },
    })]);
    assert.equal(item.number, null);
    assert.equal(notificationTitle(item), "Unnumbered title");
    assert.deepEqual(groupThreads([item], { query: "#7" }), []);
  }
  assert.equal(notificationTitle({ title: "", number: "42" }), "#42");
  assert.equal(notificationTitle({ title: "", number: "42" }, "(Untitled notification)"), "#42 (Untitled notification)");
  assert.equal(notificationTitle({ title: "", number: null }, "(Untitled notification)"), "(Untitled notification)");
  assert.equal(notificationTitle({ title: "" }), "");
});

test("normalization drops API bodies, secrets and unrelated fields, preserving untrusted text as text", () => {
  const title = '<img src=x onerror="alert(1)">';
  const result = normalizeThreads([thread("1", {
    subject: { title, type: "Unknown", url: null, body: "not retained" },
    subscription_url: "not retained",
    repository: { full_name: "example/widgets", temp_clone_token: "not retained" },
  })]);
  assert.equal(result[0].title, title);
  assert.equal(JSON.stringify(result).includes("not retained"), false);
});

test("malformed payloads fail explicitly instead of silently dropping rows", () => {
  for (const value of [null, {}, [null], [thread("x")], [thread("1", { unread: "true" })],
    [thread("1", { subject: {} })], [thread("1", { updated_at: "invalid" })],
    [thread("1", { repository: { full_name: "../../x" } })]]) {
    assert.throws(() => normalizeThreads(value), { code: "invalid_response" });
  }
});

test("filters match the public schema and reject invalid or surplus input", () => {
  assert.deepEqual(validateFilters({ query: "", mode: "unread" }), { query: "", mode: "unread" });
  assert.equal(filterSchema.additionalProperties, false);
  assert.deepEqual(filterSchema.properties.mode.enum, ["unread"]);
  assert.deepEqual(filterSchema.properties.attention.enum, attentionFilters.map(filter => filter.value));
  for (const attention of filterSchema.properties.attention.enum) {
    assert.deepEqual(validateFilters({ attention }), { attention });
  }
  for (const input of [null, [], "all", { mode: "all" }, { mode: "read" }, { query: 1 }, { query: "x".repeat(201) }, { token: "x" },
    ...[null, 1, [], {}, "", "mention", "subscribed", "constructor"].map(attention => ({ attention }))]) {
    assert.throws(() => validateFilters(input), { code: "invalid_filters" });
  }
});
