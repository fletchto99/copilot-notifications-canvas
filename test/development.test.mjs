import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { apiTarget, DEFAULT_API_BASE_URL, normalizeThreads } from "../src/shared/model.mjs";
import { firstPage, GitHubClient, nextPage, runGh } from "../src/provider/github.mjs";
import { Preferences } from "../src/provider/settings.mjs";
import { loadDevelopmentAPI } from "../src/provider/development.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { startServer } from "../src/provider/server.mjs";
import { http, next, thread } from "./fixtures.mjs";

const baseUrl = "https://git.example.com/api/v3";
const target = apiTarget(baseUrl);
const nextLink = next.replace(DEFAULT_API_BASE_URL, baseUrl);

async function preferencesFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "notification-development-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new Preferences({ directory });
}

test("API bases are HTTPS, canonical, credential-free and safe for gh arguments", () => {
  assert.equal(apiTarget().custom, false);
  assert.equal(apiTarget("https://api.github.com/").hostname, "github.com");
  assert.equal(apiTarget("https://GIT.example.com:443/api/v3/").baseUrl, baseUrl);
  assert.equal(apiTarget("https://git.example.com:8443/rest").hostname, "git.example.com");
  assert.equal(apiTarget("https://git.example.com:8443/rest").baseUrl, "https://git.example.com:8443/rest");
  assert.equal(apiTarget("https://127.0.0.1:8443/api/v3").hostname, "127.0.0.1");
  assert.equal(apiTarget("https://git.example.com").prefix, "");
  assert.equal(Object.isFrozen(target), true);
  for (const value of ["https://[::1]/api/v3", "https://[2001:db8::1]:8443/api/v3"]) {
    assert.throws(() => apiTarget(value), error => error.code === "invalid_api" && /IPv6/.test(error.message));
  }
  for (const value of [null, {}, 7, "", "git.example.com", "http://git.example.com/api/v3", "file:///tmp/api",
    "https://user:secret@git.example.com/api/v3", `${baseUrl}?token=secret`, `${baseUrl}#secret`,
    "https://git.example.com/api/../v3", "https://git.example.com/api/%2e/v3",
    "https://git.example.com\\@evil.test/api", " https://git.example.com", `${baseUrl}\n`,
    "https://git.example.com/{repo}", "https://git.example.com/api//v3", "https://git.example.com/api/!", "https://[invalid",
    `https://git.example.com/${"a".repeat(2048)}`]) {
    assert.throws(() => apiTarget(value), error => error.code === "invalid_api" && !error.message.includes("secret"));
  }
});

test("maximum-length malformed API paths are rejected without blocking", async () => {
  const prefix = `${baseUrl}/`;
  const invalidURL = `${prefix}${"a".repeat(2048 - prefix.length - 1)}!`;
  assert.equal(invalidURL.length, 2048);
  const script = `
import assert from "node:assert/strict";
const { apiTarget } = await import(process.argv[1]);
const invalidURL = process.argv[2];
const validURL = invalidURL.slice(0, -1) + "a";
assert.equal(apiTarget(validURL).baseUrl, validURL);
assert.throws(() => apiTarget(invalidURL), { code: "invalid_api" });
`;
  await promisify(childProcess.execFile)(process.execPath, [
    "--input-type=module", "-e", script, new URL("../src/shared/model.mjs", import.meta.url).href, invalidURL,
  ], { timeout: 5000 });
});

test("custom notification reads, conditional pagination and both writes stay on the selected API", async () => {
  for (const apiBaseUrl of [baseUrl, "https://git.example.com:8443/api/v3"]) {
    let now = 0;
    const calls = [];
    const client = new GitHubClient({ apiBaseUrl, now: () => now, sleep: async delay => { now += delay; },
      run: async args => {
        calls.push(args);
        if (args.includes("PATCH")) return http(null, {}, 205);
        if (args.includes("DELETE")) return http(null, {}, 204);
        if (args.at(-1).includes("page=2")) return http([]);
        if (args.includes('If-None-Match: "lab"')) return http(null, {}, 304);
        return http([thread("1", { subject: { type: "Issue", title: "Synthetic", url: `${apiBaseUrl}/repos/example/widgets/issues/42` } })],
          { link: next.replace(DEFAULT_API_BASE_URL, apiBaseUrl), etag: '"lab"' });
      },
    });
    const page = await client.page(firstPage());
    assert.equal(page.items[0].url, `${new URL(apiBaseUrl).origin}/example/widgets/issues/42`);
    assert.equal(page.items[0].number, "42");
    await client.page(firstPage(), undefined, { force: true });
    await client.page(page.next);
    await client.markRead("1");
    await client.markDone("2");
    assert.deepEqual(calls.map(args => args[args.indexOf("--method") + 1]), ["GET", "GET", "GET", "PATCH", "DELETE"]);
    for (const args of calls) {
      assert.equal(args[2], "git.example.com");
      assert.ok(args.at(-1).startsWith(apiBaseUrl + "/notifications"));
      assert.equal(args.includes("auth"), false);
      assert.equal(args.some(arg => /Authorization|secret/.test(arg)), false);
    }
    assert.equal(calls.at(-2).at(-1), `${apiBaseUrl}/notifications/threads/1`);
    assert.equal(calls.at(-1).at(-1), `${apiBaseUrl}/notifications/threads/2`);
    assert.equal(client.cache.values().next().value.items.length, 0);
  }
});

test("custom pagination rejects other hosts, prefixes, credentials and altered unread scope", () => {
  assert.equal(nextPage(nextLink, firstPage(), target), nextPage(next, firstPage()));
  assert.equal(nextPage(nextLink.replace(baseUrl, "/api/v3"), firstPage(), target), nextPage(next, firstPage()));
  const portTarget = apiTarget("https://git.example.com:8443/api/v3");
  assert.equal(nextPage(next.replace(DEFAULT_API_BASE_URL, portTarget.baseUrl), firstPage(), portTarget), nextPage(next, firstPage()));
  assert.throws(() => nextPage(nextLink, firstPage(), portTarget), { code: "invalid_pagination" });
  for (const link of [next, nextLink.replace("git.example.com", "evil.test"), nextLink.replace("git.example.com", "git.example.com:8443"),
    nextLink.replace("/api/v3", "/api/v4"), nextLink.replace("https:", "http:"),
    nextLink.replace("https://", "https://user:secret@"), nextLink.replace("all=false", "all=true"),
    nextLink.replace("page=2", "page=3"), nextLink.replace("page=2", "page=2&token=secret")]) {
    assert.throws(() => nextPage(link, firstPage(), target), { code: "invalid_pagination" });
  }
});

test("custom links reject foreign subjects and keep fallback, release and Actions links on the chosen host", () => {
  for (const [type, subjectUrl, expected] of [
    ["Issue", `${baseUrl}/repos/example/widgets/issues/42`, "/example/widgets/issues/42"],
    ["PullRequest", `${baseUrl}/repos/example/widgets/pulls/42`, "/example/widgets/pull/42"],
    ["Issue", "https://api.github.com/repos/example/widgets/issues/42", "/notifications"],
    ["Issue", `${baseUrl}/repos/other/widgets/issues/42`, "/notifications"],
    ["Issue", `${baseUrl}/repos/example/widgets/issues/42?token=secret`, "/notifications"],
    ["Release", null, "/example/widgets/releases"],
    ["CheckSuite", null, "/example/widgets/actions"],
  ]) {
    const [item] = normalizeThreads([thread("1", { subject: { title: "Synthetic", type, url: subjectUrl } })], target);
    assert.equal(item.url, `https://git.example.com${expected}`);
  }
});

test("custom authentication errors name neither production login nor private response details", async t => {
  for (const status of [401, 403, 404]) {
    const client = new GitHubClient({ apiBaseUrl: baseUrl, run: async () => http({ message: "secret" }, {}, status) });
    await assert.rejects(client.page(firstPage()), error => {
      assert.doesNotMatch(error.message, /github\.com|secret|git\.example/);
      return error.code === (status === 401 ? "authentication" : "permission");
    });
  }
  t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) =>
    callback({ code: 1 }, "", "gh auth login secret"));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(runGh(["api", "--hostname", "git.example.com"]), error =>
    error.code === "authentication" && /selected API host/.test(error.message) && !/github\.com|secret/.test(error.message));
});

test("development API saves preserve preferences and unknown data without changing the active target", async t => {
  const preferences = await preferencesFor(t);
  await writeFile(preferences.path, '{"autoOpen":false,"desktopNotifications":true,"futureSetting":{"keep":true}}');
  const service = await loadDevelopmentAPI(preferences);
  assert.equal(service.target.baseUrl, DEFAULT_API_BASE_URL);
  await service.update({ baseUrl: baseUrl + "/" });
  assert.deepEqual(await service.snapshot(), { baseUrl: DEFAULT_API_BASE_URL, savedBaseUrl: baseUrl, requiresReload: true });
  await preferences.update({ darkMode: true });
  const { revision, updatedAt, ...saved } = JSON.parse(await readFile(preferences.path, "utf8"));
  assert.equal(revision, 2);
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.deepEqual(saved, {
    autoOpen: false, desktopNotifications: true, futureSetting: { keep: true }, developmentApiBaseUrl: baseUrl, darkMode: true,
  });
  assert.equal(Object.hasOwn(await preferences.read(), "developmentApiBaseUrl"), false);
  const reloaded = await loadDevelopmentAPI(preferences);
  assert.equal(reloaded.target.baseUrl, baseUrl);
  assert.equal((await reloaded.snapshot()).requiresReload, false);
  await reloaded.update({ baseUrl: DEFAULT_API_BASE_URL });
  assert.equal((await loadDevelopmentAPI(preferences)).target.custom, false);
});

test("invalid development settings fail explicitly and cannot be set through ordinary preferences", async t => {
  const preferences = await preferencesFor(t);
  for (const input of [null, [], {}, { baseUrl: null }, { baseUrl, token: "secret" },
    { baseUrl: "http://git.example.com" }, { baseUrl: "https://[::1]/api/v3" }]) {
    await assert.rejects(preferences.updateDevelopmentAPI(input), { code: "invalid_api" });
  }
  await assert.rejects(preferences.update({ developmentApiBaseUrl: baseUrl }), { code: "invalid_settings" });
  await writeFile(preferences.path, '{"developmentApiBaseUrl":"not a URL","autoOpen":true}');
  await assert.rejects(loadDevelopmentAPI(preferences), { code: "settings_read" });
  assert.equal((await preferences.read()).autoOpen, true, "ordinary packaged preferences ignore development-only data");
  await writeFile(preferences.path, '{"developmentApiBaseUrl":"https://[::1]/api/v3"}');
  await assert.rejects(loadDevelopmentAPI(preferences), error => error.code === "settings_read" && /DNS hostname or IPv4/.test(error.message));
});

test("protected development settings save without switching the running inbox or making API requests", async t => {
  const preferences = await preferencesFor(t);
  await preferences.updateDevelopmentAPI({ baseUrl });
  const developmentAPI = await loadDevelopmentAPI(preferences);
  const client = new GitHubClient({ apiBaseUrl: baseUrl, run: () => assert.fail("Saving must not query an API") });
  const inbox = new Inbox(client);
  const server = await startServer(inbox, { preferences, developmentAPI, development: { version: "0.0.0", branch: "test" } });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const send = (path, input, overrides = {}) => fetch(new URL(path, url), {
    method: input === undefined ? "GET" : "POST", headers: { ...headers, ...overrides },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const settings = await (await send("/api/settings")).json();
  assert.equal(settings.developmentApi.baseUrl, baseUrl);
  assert.equal(settings.desktopStatus.supported, false);
  assert.match(settings.desktopStatus.message, /custom development APIs/);
  const state = await (await send("/api/state")).json();
  assert.equal(state.inboxUrl, "https://git.example.com/notifications");
  assert.equal(state.developmentApiBaseUrl, baseUrl);
  assert.doesNotMatch(JSON.stringify(inbox.summary()), /git\.example/);
  for (const overrides of [{ Authorization: "" }, { Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await send("/api/development", { baseUrl: DEFAULT_API_BASE_URL }, overrides)).status, 403);
  }
  assert.equal((await send("/api/development")).status, 405);
  assert.equal((await send("/api/development", { baseUrl: "http://git.example.com" })).status, 400);
  const response = await send("/api/development", { baseUrl: DEFAULT_API_BASE_URL });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).developmentApi.requiresReload, true);
  assert.equal(client.target.baseUrl, baseUrl);
  assert.equal((await (await send("/api/state")).json()).developmentApiBaseUrl, baseUrl);
});

test("servers without development capability cannot save an API even when preferences contain one", async t => {
  const preferences = await preferencesFor(t);
  await preferences.updateDevelopmentAPI({ baseUrl });
  const server = await startServer(new Inbox(new GitHubClient()), { preferences });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const response = await fetch(new URL("/api/development", url), { method: "POST", headers, body: JSON.stringify({ baseUrl }) });
  assert.equal(response.status, 404);
  const settings = await (await fetch(new URL("/api/settings", url), { headers })).json();
  assert.equal(Object.hasOwn(settings, "developmentApi"), false);
});

test("asset recovery keeps its inbox link on the selected API host", async t => {
  const preferences = await preferencesFor(t);
  await preferences.updateDevelopmentAPI({ baseUrl });
  const developmentAPI = await loadDevelopmentAPI(preferences);
  const server = await startServer(new Inbox(new GitHubClient({ apiBaseUrl: baseUrl })), {
    preferences, developmentAPI, development: { version: "0.0.0", branch: "test" },
    read: async () => { throw new Error("Synthetic missing asset"); },
  });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  assert.match(html, /href="https:\/\/git\.example\.com\/notifications"/);
  assert.doesNotMatch(html, /href="https:\/\/github\.com\/notifications"/);
});
