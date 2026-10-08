import test from "node:test";
import assert from "node:assert/strict";
import { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";
import { http, thread } from "./fixtures.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const calls = [];
  const logs = [];
  const inbox = new Inbox(new GitHubClient({ run: async args => {
    calls.push(args);
    return http([thread()]);
  } }));
  t.after(() => inbox.close());
  return { inbox, calls, logs, log: (message, options) => logs.push({ message, options }) };
}

test("missing assets open a protected recovery page and recover on the same URL", async t => {
  const f = fixture(t);
  let unavailable = true;
  let reads = 0;
  const server = await startServer(f.inbox, { log: f.log, read: (path, options) => {
    reads++;
    if (unavailable && path.pathname.endsWith("/app.mjs")) {
      throw Object.assign(new Error("Synthetic private path"), { code: "ENOENT" });
    }
    return readFile(path, options);
  } });
  t.after(() => server.close());
  const { origin, hash } = new URL(server.url);
  const headers = { Authorization: `Bearer ${hash.slice(1)}`, Origin: origin };
  const html = await fetch(server.url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Retrying in the background/);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(await (await fetch(`${origin}/startup.mjs`)).text(), /location\.reload/);
  assert.equal((await fetch(`${origin}/startup.mjs`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/api/ready`)).status, 403);
  for (const override of [{ Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await fetch(`${origin}/api/ready`, { headers: { ...headers, ...override } })).status, 403);
  }
  assert.equal((await fetch(`${origin}/api/ready`, { method: "POST", headers })).status, 405);
  assert.deepEqual(await (await fetch(`${origin}/api/ready`, { headers })).json(), { ready: false });
  for (const path of ["/app.mjs", "/styles.css", "/api/state", "/api/settings", "/api/refresh", "/api/read", "/api/done"]) {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error.code, "server_initializing");
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, [{
    message: "Could not load the notifications canvas assets (ENOENT). Retrying in the background.",
    options: { level: "warning" },
  }]);
  unavailable = false;
  for (let count = 0; count < 100; count++) {
    if ((await (await fetch(`${origin}/api/ready`, { headers })).json()).ready) break;
    await wait(20);
  }
  assert.deepEqual(await (await fetch(`${origin}/api/ready`, { headers })).json(), { ready: true });
  assert.equal(await server.ready, true);
  assert.match(await (await fetch(server.url)).text(), /id="settings"/);
  assert.equal((await fetch(`${origin}/app.mjs`)).status, 200);
  assert.equal(reads, 8, "Recovery must publish one complete asset snapshot");
  assert.deepEqual(f.calls, [], "Recovery must not fetch GitHub data or mark anything read");
  await server.close();
  await assert.rejects(fetch(server.url));
});

test("asset retries back off to 30 seconds, log once and stop on close", async t => {
  const f = fixture(t);
  const timers = new Map();
  const delays = [];
  const schedule = t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { unref() {} };
    timers.set(timer, callback);
    delays.push(delay);
    return timer;
  });
  const cancel = t.mock.method(globalThis, "clearTimeout", timer => timers.delete(timer));
  const server = await startServer(f.inbox, { log: f.log, read: () => {
    throw new Error("Synthetic private detail");
  } });
  t.after(() => server.close());
  for (let count = 0; count < 7; count++) {
    assert.equal(timers.size, 1);
    const [timer, callback] = timers.entries().next().value;
    timers.delete(timer);
    callback();
    await settle();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /Synthetic private detail/);
  await server.close();
  assert.equal(await server.ready, false);
  assert.equal(timers.size, 0);
  schedule.mock.restore();
  cancel.mock.restore();
});

test("closing during an asset retry aborts in-flight reads and never schedules another retry", async t => {
  const f = fixture(t);
  let retry;
  let scheduled = 0;
  const schedule = t.mock.method(globalThis, "setTimeout", callback => {
    retry = callback;
    scheduled++;
    return { unref() {} };
  });
  let fail = true;
  const signals = [];
  const server = await startServer(f.inbox, { log: f.log, read: (_path, { signal }) => {
    if (fail) throw new Error("Initial failure");
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  t.after(() => server.close());
  fail = false;
  retry();
  await settle();
  assert.equal(signals.length, 4);
  await server.close();
  await settle();
  assert.equal(await server.ready, false);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(scheduled, 1);
  assert.equal(f.logs.length, 1);
  schedule.mock.restore();
});

test("closing during the initial asset read cancels opening", async t => {
  const f = fixture(t);
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const opening = startServer(f.inbox, { log: f.log, read: (_path, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  const rejected = assert.rejects(opening, { code: "closed" });
  await reading;
  f.inbox.close();
  await rejected;
  assert.deepEqual(f.logs, []);
});

test("an already-closed inbox cannot start asset loading", async t => {
  const f = fixture(t);
  f.inbox.close();
  await assert.rejects(startServer(f.inbox, { read: () => assert.fail("Closed inbox must not read assets") }),
    { code: "closed" });
});

test("a transient listen error retries the same loopback server and removes attempt listeners", async t => {
  const f = fixture(t);
  const listen = Server.prototype.listen;
  let attempts = 0;
  let listener;
  t.mock.method(Server.prototype, "listen", function (...args) {
    listener = this;
    assert.deepEqual(args, [0, "127.0.0.1"]);
    if (++attempts === 1) {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("Private address"), { code: "EADDRINUSE" })));
      return this;
    }
    return listen.apply(this, args);
  });
  const server = await startServer(f.inbox, { log: f.log });
  t.after(() => server.close());
  assert.equal(attempts, 2);
  assert.equal(listener.listenerCount("error"), 1);
  assert.equal(listener.listeners("error").some(handler => handler.name === "failed"), false);
  assert.equal(listener.listeners("listening").some(handler => handler.name === "listening"), false);
  assert.equal((await fetch(server.url)).status, 200);
  assert.deepEqual(f.logs, [{
    message: "Could not bind the notifications loopback server (EADDRINUSE). Retrying.",
    options: { level: "warning" },
  }]);
});

test("post-start errors are handled repeatedly without exposing details or interrupting panels", async t => {
  const first = fixture(t);
  const second = fixture(t);
  const listen = Server.prototype.listen;
  const listeners = [];
  t.mock.method(Server.prototype, "listen", function (...args) {
    listeners.push(this);
    return listen.apply(this, args);
  });
  const one = await startServer(first.inbox, { log: first.log });
  t.after(() => one.close());
  const two = await startServer(second.inbox, { log: second.log });
  t.after(() => two.close());
  for (const code of ["ENOBUFS", "Synthetic private code", undefined]) {
    assert.doesNotThrow(() => listeners[0].emit("error",
      Object.assign(new Error("Synthetic private address"), { code })));
    assert.equal((await fetch(one.url)).status, 200);
    assert.equal((await fetch(two.url)).status, 200);
    assert.equal(listeners[0].listenerCount("error"), 1);
  }
  assert.deepEqual(first.logs, [
    { message: "Notifications loopback server error (ENOBUFS).", options: { level: "error" } },
    { message: "Notifications loopback server error.", options: { level: "error" } },
    { message: "Notifications loopback server error.", options: { level: "error" } },
  ]);
  assert.deepEqual(second.logs, []);
});

test("persistent listen failures are bounded, sanitized and can be retried by another open", async t => {
  for (const code of ["EACCES", "Synthetic private code"]) {
    await t.test(code, async subtest => {
      const f = fixture(subtest);
      let attempts = 0;
      const mock = subtest.mock.method(Server.prototype, "listen", () => {
        attempts++;
        throw Object.assign(new Error("Synthetic private path"), { code });
      });
      const suffix = code === "EACCES" ? " (EACCES)" : "";
      await assert.rejects(startServer(f.inbox, { log: f.log }), {
        code: "server_start",
        message: `Could not start the local notifications server${suffix} after 3 attempts. Reload extensions to try again.`,
      });
      assert.equal(attempts, 3);
      assert.equal(f.logs.length, 2);
      assert.equal(f.logs[1].options.level, "error");
      assert.doesNotMatch(JSON.stringify(f.logs), /Synthetic private/);
      mock.mock.restore();
      const server = await startServer(f.inbox);
      subtest.after(() => server.close());
      assert.equal((await fetch(server.url)).status, 200);
    });
  }
});

test("closing during listen backoff cancels remaining attempts", async t => {
  const f = fixture(t);
  let attempts = 0;
  let retrying;
  const ready = new Promise(resolve => { retrying = resolve; });
  t.mock.method(Server.prototype, "listen", function () {
    attempts++;
    queueMicrotask(() => this.emit("error", new Error("Synthetic bind failure")));
    return this;
  });
  const opening = startServer(f.inbox, { log: () => retrying() });
  const rejected = assert.rejects(opening, { code: "closed" });
  await ready;
  f.inbox.close();
  await rejected;
  assert.equal(attempts, 1);
});

test("closing while listen completes releases the listener instead of opening a closed canvas", async t => {
  const f = fixture(t);
  const listen = Server.prototype.listen;
  let listener;
  t.mock.method(Server.prototype, "listen", function (...args) {
    listener = this;
    this.prependOnceListener("listening", () => f.inbox.close());
    return listen.apply(this, args);
  });
  await assert.rejects(startServer(f.inbox), { code: "closed" });
  assert.equal(listener.listening, false);
});
