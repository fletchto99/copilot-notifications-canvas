import test from "node:test";
import assert from "node:assert/strict";
import { attentionCounts, attentionFilters, dateLabel, filterSchema, groupThreads, groupThreadsByDate, normalizeThreads, notificationLink, notificationTitle, orderedThreads, uniqueThreads, validateFilters } from "../src/model.mjs";
import { thread } from "./fixtures.mjs";

test("calendar grouping uses the requested zone rather than the provider's local date", () => {
  const items = normalizeThreads([
    thread("1", { updated_at: "2026-01-01T00:30:00Z" }),
    thread("2", { updated_at: "2026-01-01T08:30:00Z" }),
    thread("3", { updated_at: "2026-01-02T08:30:00Z", unread: false }),
  ]);
  const west = groupThreadsByDate(items, "America/Los_Angeles");
  assert.deepEqual(west.map(group => [group.date, group.items.map(item => item.id)]), [
    ["2026-01-02", ["3"]], ["2026-01-01", ["2"]], ["2025-12-31", ["1"]],
  ]);
  assert.equal(west[0].key, "date:2026-1-2");
  assert.equal(west[0].timeZone, "America/Los_Angeles");
  assert.equal(west[0].label, dateLabel("2026-01-02"));
  const east = groupThreadsByDate(items, "Asia/Tokyo");
  assert.deepEqual(east.map(group => [group.date, group.items.map(item => item.id)]), [["2026-01-02", ["3"]], ["2026-01-01", ["1", "2"]]]);
  assert.equal(east[0].unread, 0);
  assert.equal(east[1].unread, 2);
});

test("calendar grouping rejects unsupported zones and surfaces unexpected formatter failures", t => {
  for (const zone of [undefined, null, 1, "", "x".repeat(129), "Invalid/Zone"]) {
    assert.throws(() => groupThreadsByDate([], zone), { code: "invalid_time_zone", status: 400 });
  }
  const failure = new Error("Synthetic formatter failure");
  t.mock.method(Intl, "DateTimeFormat", function () { throw failure; });
  assert.throws(() => groupThreadsByDate([], "UTC"), error => error === failure);
});

test("repository grouping preserves first-seen positions while accepting newer duplicate data", () => {
  const items = normalizeThreads([
    thread("1", { updated_at: "2026-01-01T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/another" }, updated_at: "2026-01-15T00:00:00Z" }),
    thread("1", { updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { unread: false }),
    thread("5", { updated_at: "2026-01-20T00:00:00Z" }),
    thread("4", { updated_at: "2026-01-10T00:00:00Z" }),
  ]);
  const groups = groupThreads(items, { query: "" });
  assert.deepEqual(groups.map(group => group.repository), ["example/widgets", "example/another"]);
  assert.deepEqual(groups[0].items.map(item => item.id), ["1", "3", "5", "4"]);
  assert.equal(groups[0].items[0].updatedAt, "2026-01-20T00:00:00.000Z");
  assert.equal(groups[0].unread, 3);
  assert.equal(orderedThreads(items).length, 5);
  assert.deepEqual(uniqueThreads(items).map(item => item.id), ["1", "2", "3", "5", "4"]);
  assert.deepEqual(orderedThreads(items).map(item => item.id), ["1", "5", "2", "3", "4"]);
  assert.equal(groupThreads(items, { query: " WIDGETS " })[0].items.length, 4);
  assert.equal(groupThreads(items, { query: "synthetic notification 2" })[0].repository, "example/another");
  assert.deepEqual(groupThreads(items, { query: "missing" }), []);
  assert.deepEqual(groupThreads(items, { query: "synthetic notification 3" })[0].items.map(item => item.id), ["3"]);
});

test("group order follows the API rather than repository names, timestamps or ID tie-breakers", () => {
  const items = normalizeThreads([
    thread("9", { repository: { full_name: "zeta/alpha" }, updated_at: "2026-01-10T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/Zebra" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("1", { repository: { full_name: "Alpha/widgets" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("4", { repository: { full_name: "example/another" }, updated_at: "2026-01-30T00:00:00Z" }),
  ]);
  for (const [threads, repositories, matches] of [
    [items, ["zeta/alpha", "example/Zebra", "Alpha/widgets", "example/another"], ["example/Zebra", "example/another"]],
    [[...items].reverse(), ["example/another", "Alpha/widgets", "example/Zebra", "zeta/alpha"], ["example/another", "example/Zebra"]],
  ]) {
    assert.deepEqual(groupThreads(threads, { query: "" }).map(group => group.repository),
      repositories);
    assert.deepEqual(groupThreads(threads, { query: "example/" }).map(group => group.repository),
      matches);
  }
});

test("search and attention preserve the first matching API occurrence of each repository", () => {
  const items = normalizeThreads([
    thread("1", { repository: { full_name: "example/alpha" }, reason: "mention",
      updated_at: "2026-01-30T00:00:00Z", subject: { title: "Different task", type: "Issue", url: null } }),
    thread("2", { repository: { full_name: "example/zulu" }, updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { repository: { full_name: "example/alpha" }, updated_at: "2026-01-10T00:00:00Z" }),
  ]);
  assert.deepEqual(groupThreads(items, { query: "" }).map(group => group.repository), ["example/alpha", "example/zulu"]);
  for (const filters of [{ query: "Synthetic" }, { query: "", attention: "review_requested" }]) {
    assert.deepEqual(groupThreads(items, filters).map(group => group.repository), ["example/zulu", "example/alpha"]);
  }
});

test("attention filters use exact notification reasons and include read search matches", () => {
  const reasons = ["review_requested", "mention", "team_mention", "assign", "author", "comment",
    "subscribed", "manual", "state_change", "security_alert", "unknown", "constructor",
    "invitation", "security_advisory_credit", "ci_activity"];
  const items = normalizeThreads(reasons.map((reason, index) => thread(String(index + 1), { reason })));
  const expected = {
    all: reasons, review_requested: ["review_requested"], mentioned: ["mention"], team_mentioned: ["team_mention"],
    assigned: ["assign"], participating: ["author", "comment", "mention", "team_mention", "assign",
      "manual", "state_change", "invitation", "review_requested", "security_advisory_credit"],
  };
  for (const [attention, selected] of Object.entries(expected)) {
    const groups = groupThreads([...items, { ...items[0], id: "99", unread: false }], { query: "", attention });
    const selectedReasons = selected.includes("review_requested") ? [...selected, "review_requested"] : selected;
    assert.deepEqual(groups[0].items.map(item => item.reason).sort(), [...selectedReasons].sort());
    assert.equal(groups[0].unread, selected.length);
  }
  assert.deepEqual(groupThreads(items, { query: "notification 2", attention: "mentioned" })[0].items.map(item => item.id), ["2"]);
  assert.deepEqual(groupThreads(items, { query: "notification 3", attention: "team_mentioned" })[0].items.map(item => item.id), ["3"]);
  assert.deepEqual(groupThreads(items, { query: "notification 3", attention: "mentioned" }), []);
  assert.deepEqual(groupThreads(items, { query: "notification 3", attention: "assigned" }), []);
  assert.throws(() => groupThreads(items, { query: "", attention: "invalid" }), { code: "invalid_filters" });
});

test("attention counts include every deduplicated read and unread notification", () => {
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
      { all: 8, review_requested: 1, mentioned: 2, team_mentioned: 1, assigned: 1, participating: 7 });
    for (const filter of attentionFilters) {
      const groups = groupThreads(threads, { query: "", attention: filter.value });
      assert.equal(counts[filter.value], groups.reduce((total, group) => total + group.items.length, 0));
    }
  }
  assert.deepEqual(attentionCounts([]),
    { all: 0, review_requested: 0, mentioned: 0, team_mentioned: 0, assigned: 0, participating: 0 });
});

test("attention tabs use GitHub's requested order and expose team mentions in the public schema", () => {
  assert.deepEqual(attentionFilters.map(({ value, label }) => [value, label]), [
    ["all", "All"], ["assigned", "Assigned"], ["participating", "Participating"],
    ["mentioned", "Mentioned"], ["team_mentioned", "Team Mentioned"], ["review_requested", "Review Requested"],
  ]);
  assert.deepEqual(validateFilters({ attention: "team_mentioned" }), { attention: "team_mentioned" });
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
    if (type === "Discussion") assert.equal(result.discussionNumber, "9");
    if (type === "Commit") assert.equal(result.commitRef, "abcdef0123456");
  }
});

test("release IDs and check-suite IDs are never mistaken for web tags or run IDs", () => {
  for (const [type, suffix] of [["Release", "releases"], ["CheckSuite", "actions"]]) {
    const result = notificationLink({ type, url: `https://api.github.com/repos/example/widgets/${suffix}/123` }, "example/widgets");
    assert.equal(result.url, `https://github.com/example/widgets/${suffix}`);
    assert.equal(result.direct, false);
    assert.equal(result.number, null);
    assert.match(result.label, /^Open repository/);
    if (type === "Release") assert.equal(result.releaseId, "123");
  }
});

test("release handoff IDs come only from exact same-repository API release links", () => {
  const [item] = normalizeThreads([thread("987", {
    subject: { title: "Not a tag", type: "Release", url: "https://api.github.com/repos/example/widgets/releases/123" },
  })]);
  assert.equal(item.releaseId, "123");
  assert.equal(item.number, null);
  assert.equal(item.url, "https://github.com/example/widgets/releases");
  for (const url of [null, "https://api.github.com/repos/other/widgets/releases/123",
    "https://evil.test/repos/example/widgets/releases/123", "https://github.com/example/widgets/releases/tag/v1",
    ...["latest", "tags/v1", "0", "01", "123/assets", "123?latest=true", "123#tag"]
      .map(path => `https://api.github.com/repos/example/widgets/releases/${path}`)]) {
    assert.equal(notificationLink({ type: "Release", title: "v1", url }, "example/widgets").releaseId, null);
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
  assert.deepEqual(filterSchema.properties.mode.enum, ["inbox", "unread"]);
  assert.deepEqual(validateFilters({ mode: "inbox" }), { mode: "inbox" });
  assert.deepEqual(filterSchema.properties.attention.enum, attentionFilters.map(filter => filter.value));
  for (const attention of filterSchema.properties.attention.enum) {
    assert.deepEqual(validateFilters({ attention }), { attention });
  }
  for (const input of [null, [], "all", { mode: "all" }, { mode: "read" }, { query: 1 }, { query: "x".repeat(201) }, { token: "x" },
    ...[null, 1, [], {}, "", "mention", "subscribed", "constructor"].map(attention => ({ attention }))]) {
    assert.throws(() => validateFilters(input), { code: "invalid_filters" });
  }
});
