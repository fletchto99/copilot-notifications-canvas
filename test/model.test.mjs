import test from "node:test";
import assert from "node:assert/strict";
import { filterSchema, groupThreads, normalizeThreads, notificationLink, orderedThreads, validateFilters } from "../.github/extensions/github-notifications/model.mjs";
import { thread } from "./fixtures.mjs";

test("groups, deduplicates and orders newest activity first, then stable IDs/names", () => {
  const items = normalizeThreads([
    thread("1", { updated_at: "2026-01-01T00:00:00Z" }),
    thread("2", { repository: { full_name: "example/another" }, updated_at: "2026-01-15T00:00:00Z" }),
    thread("1", { updated_at: "2026-01-20T00:00:00Z" }),
    thread("3", { unread: false }),
  ]);
  const groups = groupThreads(items, { mode: "all", query: "" });
  assert.deepEqual(groups.map(group => group.repository), ["example/widgets", "example/another"]);
  assert.deepEqual(groups[0].items.map(item => item.id), ["1", "3"]);
  assert.equal(groups[0].unread, 1);
  assert.equal(orderedThreads(items).length, 3);
  assert.equal(groupThreads(items, { mode: "unread", query: " WIDGETS " })[0].items.length, 1);
  assert.equal(groupThreads(items, { mode: "all", query: "synthetic notification 2" })[0].repository, "example/another");
  assert.deepEqual(groupThreads(items, { mode: "all", query: "missing" }), []);
});

test("known API subject links become safe GitHub web links", () => {
  for (const [type, path, expected] of [
    ["Issue", "issues/7", "issues/7"],
    ["PullRequest", "pulls/8", "pull/8"],
    ["Commit", "commits/abcdef0123456", "commit/abcdef0123456"],
    ["Discussion", "discussions/9", "discussions/9"],
  ]) {
    const result = notificationLink({ type, url: `https://api.github.com/repos/example/widgets/${path}` }, "example/widgets");
    assert.equal(result.url, `https://github.com/example/widgets/${expected}`);
    assert.equal(result.direct, true);
  }
});

test("release IDs and check-suite IDs are never mistaken for web tags or run IDs", () => {
  for (const [type, suffix] of [["Release", "releases"], ["CheckSuite", "actions"]]) {
    const result = notificationLink({ type, url: `https://api.github.com/repos/example/widgets/${suffix}/123` }, "example/widgets");
    assert.equal(result.url, `https://github.com/example/widgets/${suffix}`);
    assert.equal(result.direct, false);
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
  ]) {
    const result = notificationLink({ type: "Issue", url }, "example/widgets");
    assert.equal(result.url, "https://github.com/notifications");
    assert.equal(result.direct, false);
  }
  assert.equal(notificationLink({ type: "Unknown", url: null }, "example/widgets").direct, false);
  for (const type of ["__proto__", "constructor", "toString"]) {
    assert.equal(notificationLink({ type, url: null }, "example/widgets").direct, false);
  }
  assert.equal(notificationLink({ type: "Release" }, "example/..").url, "https://github.com/notifications");
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
  assert.deepEqual(validateFilters({ query: "", mode: "all" }), { query: "", mode: "all" });
  assert.equal(filterSchema.additionalProperties, false);
  for (const input of [null, [], "all", { mode: "read" }, { query: 1 }, { query: "x".repeat(201) }, { token: "x" }]) {
    assert.throws(() => validateFilters(input), { code: "invalid_filters" });
  }
});
