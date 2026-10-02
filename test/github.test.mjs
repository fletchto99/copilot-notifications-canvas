import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { firstPage, GitHubClient, nextPage, parseResponse, POLL_MS, runGh } from "../.github/extensions/github-notifications/github.mjs";
import { http, next, thread } from "./fixtures.mjs";

test("gh calls use explicit GET, fixed host, safe argument arrays and no auth token extraction", async () => {
  const calls = [];
  const client = new GitHubClient({ run: async args => { calls.push(args); return http([thread()]); } });
  await client.page(firstPage());
  assert.deepEqual(calls[0].slice(0, 7), ["api", "--hostname", "github.com", "--method", "GET", "--include", "-H"]);
  assert.match(calls[0].at(-1), /^\/notifications\?/);
  assert.match(calls[0].at(-1), /all=false/);
  assert.ok(calls[0].includes("X-GitHub-Api-Version: 2022-11-28"));
  assert.equal(calls[0].includes("auth"), false);
});

test("poll floor and server interval are enforced even across concurrent panels; ETag handles 304", async () => {
  let now = 0;
  const calls = [];
  const client = new GitHubClient({
    now: () => now,
    run: async args => {
      calls.push(args);
      return calls.length === 1 ? http([thread()], { etag: '"sample"', "x-poll-interval": "300", link: next }) :
        http(null, { "x-poll-interval": "400" }, 304);
    },
  });
  const results = await Promise.all([client.page(firstPage()), client.page(firstPage())]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].nextRefreshAt, 300_000);
  now = 299_999;
  await client.page(firstPage());
  assert.equal(calls.length, 1);
  now = 300_000;
  const page = await client.page(firstPage());
  assert.ok(calls[1].includes('If-None-Match: "sample"'));
  assert.equal(page.items.length, 1);
  assert.match(page.next, /page=2/);
  assert.equal(page.nextRefreshAt, 700_000);
});

test("Last-Modified is used when ETag is absent and cacheless 304 fails", async () => {
  let now = 0;
  const calls = [];
  const modified = "Mon, 01 Jan 2024 00:00:00 GMT";
  const client = new GitHubClient({ now: () => now, run: async args => {
    calls.push(args);
    return calls.length === 1 ? http([], { "last-modified": modified }) : http(null, {}, 304);
  } });
  await client.page(firstPage());
  now = POLL_MS;
  await client.page(firstPage());
  assert.ok(calls[1].includes(`If-Modified-Since: ${modified}`));
  const empty = new GitHubClient({ run: async () => http(null, {}, 304) });
  await assert.rejects(empty.page(firstPage()), { code: "invalid_response" });
});

test("pagination follows and validates Link rather than guessing page count", () => {
  assert.match(nextPage(next, firstPage()), /page=2/);
  assert.equal(nextPage(undefined, firstPage()), null);
  assert.equal(nextPage('<https://api.github.com/notifications?page=1>; rel="prev"', firstPage()), null);
  for (const header of [next.replace("api.github.com", "evil.test"), next.replace("page=2", "page=1"),
    next.replace("all=false", "all=true"), next.replace("per_page=50", "per_page=100"),
    next.replace("/notifications?", "/user?"), next.replace("page=2", "page=2&token=secret"),
    `${next}, ${next}`, "broken header", next.replace("https:", "http:")]) {
    assert.throws(() => nextPage(header, firstPage()), { code: "invalid_pagination" });
  }
});

test("auth, permission, malformed JSON, malformed HTTP and upstream failures are sanitized", async () => {
  for (const [output, code] of [
    [http({ message: "secret credential" }, {}, 401), "authentication"],
    [http({ message: "secret credential" }, {}, 403), "permission"],
    [http({ message: "secret credential" }, {}, 404), "permission"],
    [http({ message: "secret credential" }, {}, 500), "github_http"],
    [http({ bad: true }), "invalid_response"],
    ["HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\nnot json secret", "invalid_response"],
    ["secret", "invalid_response"],
  ]) {
    const client = new GitHubClient({ run: async () => output });
    await assert.rejects(client.page(firstPage()), error => error.code === code && !error.message.includes("secret"));
  }
  assert.throws(() => parseResponse("HTTP/2 200\nbroken\n\n[]"), { code: "invalid_response" });
});

test("rate limits respect Retry-After, exhausted quota reset and exponential backoff", async () => {
  let now = 1_000_000;
  let calls = 0;
  const client = new GitHubClient({ now: () => now, run: async () => {
    calls++;
    return http({ message: "secondary rate limit" }, { "retry-after": "600", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3000" }, 403);
  } });
  await assert.rejects(client.page(firstPage()), { code: "rate_limited" });
  assert.equal(client.blockedUntil, 3_001_000);
  now = 2_000_000;
  await assert.rejects(client.page(firstPage()), { code: "rate_limited" });
  assert.equal(calls, 1);
  now = 3_001_000;
  await assert.rejects(client.page(firstPage()), { code: "rate_limited" });
  assert.equal(calls, 2);
  assert.equal(client.blockedUntil, 3_601_000);
});

test("successful responses exhausting quota also pause later page requests", async () => {
  const client = new GitHubClient({ now: () => 0, run: async () => http([thread()], {
    "x-ratelimit-remaining": "0", "x-ratelimit-reset": "900", link: next,
  }) });
  const page = await client.page(firstPage());
  assert.equal(page.nextRefreshAt, 901_000);
  await assert.rejects(client.page(page.next), { code: "rate_limited" });
});

test("requests are serialized and a closed panel cannot launch queued work", async () => {
  const controller = new AbortController();
  let release;
  let calls = 0;
  const client = new GitHubClient({ run: async () => { calls++; await new Promise(resolve => { release = resolve; }); return http([]); } });
  const first = client.page(firstPage());
  await new Promise(resolve => setImmediate(resolve));
  const second = client.page(firstPage(), controller.signal);
  controller.abort();
  release();
  await first;
  await assert.rejects(second, { code: "closed" });
  assert.equal(calls, 1);
});

test("subprocess failures sanitize stderr and use bounded, noninteractive execution", async t => {
  const original = childProcess.execFile;
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  for (const [error, stdout, stderr, code] of [
    [{ code: "ENOENT" }, "", "sensitive content", "gh_missing"],
    [{ killed: true }, "", "sensitive content", "gh_timeout"],
    [{ code: 1 }, "", "gh auth login sensitive content", "authentication"],
    [{ code: 1 }, "", "network failure sensitive content", "gh_failed"],
  ]) {
    childProcess.execFile = (command, args, options, callback) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["api"]);
      assert.equal(options.shell, undefined);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.env.GH_PROMPT_DISABLED, "1");
      assert.equal(options.env.GH_DEBUG, undefined);
      callback(error, stdout, stderr);
    };
    syncBuiltinESMExports();
    await assert.rejects(runGh(["api"]), failure =>
      failure.code === code && !failure.message.includes("sensitive"));
  }
  childProcess.execFile = (_command, _args, _options, callback) => callback({ code: 1 }, http({}, {}, 403), "sensitive");
  syncBuiltinESMExports();
  assert.equal(parseResponse(await runGh(["api"])).status, 403);
});

test("Retry-After HTTP dates on service failures delay retries", async () => {
  const client = new GitHubClient({ now: () => 0, run: async () =>
    http({}, { "retry-after": new Date(600_000).toUTCString() }, 503) });
  await assert.rejects(client.page(firstPage()), { code: "github_http" });
  assert.equal(client.blockedUntil, 600_000);
});

test("aborted requests never repopulate cache even if a transport resolves after cancellation", async () => {
  const controller = new AbortController();
  const client = new GitHubClient({ run: async () => { controller.abort(); return http([thread()]); } });
  await assert.rejects(client.page(firstPage(), controller.signal), { code: "closed" });
  assert.equal(client.cache.size, 0);
});

test("the API client rejects direct All requests before invoking gh", () => {
  const client = new GitHubClient({ run: async () => assert.fail("Must not invoke gh for All") });
  assert.throws(() => client.page("/notifications?all=true&per_page=50&page=1"), { code: "invalid_pagination" });
});
