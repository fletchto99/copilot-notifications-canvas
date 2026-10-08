import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github.mjs";
import { http } from "./fixtures.mjs";

const item = { direct: true, type: "Issue", repository: "example/widgets", number: "42", url: "https://github.com/example/widgets/issues/42" };
const subject = { title: "Synthetic", state: "open", body: null, comments: 0 };

test("issue context is bounded, read-only and never cached with inbox pages", async () => {
  const calls = [];
  const client = new GitHubClient({ run: async args => { calls.push(args); return http(subject); } });
  const result = await client.triageContext(item);
  assert.equal(result.available, true);
  assert.equal(result.body, "");
  assert.deepEqual(result.comments, []);
  assert.equal(client.cache.size, 0);
  assert.ok(calls[0].includes("GET"));
  assert.equal(calls[0].at(-1), "/repos/example/widgets/issues/42");
  assert.equal(calls[0].includes("auth"), false);
});

test("context link validation rejects unsafe hosts, repositories and IDs before any requests", async () => {
  const client = new GitHubClient({ run: async () => assert.fail("No request allowed") });
  for (const override of [
    { repository: "../widgets" }, { repository: "example/.." }, { number: "1?unsafe" },
    { number: "1".repeat(40) }, { url: "https://evil.test" }, { repository: null },
  ]) await assert.rejects(client.triageContext({ ...item, ...override }), { code: "triage_scope" });
  assert.equal((await client.triageContext(null)).available, false);
});

test("malformed subjects and comments fail explicitly", async () => {
  for (const body of [null, {}, { ...subject, body: 1 }, { ...subject, comments: -1 },
    { ...subject, comments: 0.5 }, { ...subject, state: "other" }]) {
    const client = new GitHubClient({ run: async () => http(body) });
    await assert.rejects(client.triageContext(item), { code: "triage_context" });
  }
  for (const comments of [{}, [null], [{ body: 1 }], [{ body: "a", updated_at: 1 }],
    Array.from({ length: 11 }, () => ({ body: "a", updated_at: "2026-01-01" }))]) {
    const client = new GitHubClient({ run: async args => http(args.at(-1).includes("/comments?")
      ? comments : { ...subject, comments: 2 }) });
    await assert.rejects(client.triageContext(item), { code: "triage_context" });
  }
});

test("context reads share rate-limit backoff and permission errors never leak response content", async () => {
  for (const status of [403, 404, 429]) {
    let calls = 0;
    const client = new GitHubClient({ now: () => 0, run: async () => {
      calls++;
      return http({ message: "PRIVATE CONTEXT" }, {}, status);
    } });
    await assert.rejects(client.triageContext(item), error =>
      error.code === (status === 429 ? "rate_limited" : "permission") && !error.message.includes("PRIVATE"));
    await assert.rejects(client.triageContext(item));
    assert.equal(calls, 1);
    assert.ok(client.blockedUntil > 0);
  }
});
