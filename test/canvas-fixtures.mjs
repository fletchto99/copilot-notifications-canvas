import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { DesktopNotifications } from "../src/desktop.mjs";
import { Preferences } from "../src/settings.mjs";
import { startServer } from "../src/server.mjs";
import { Updates, CURRENT_VERSION } from "../src/updates.mjs";
import { http, next, thread } from "./fixtures.mjs";

export async function createCanvasFixture({
  assetFailure = false, desktopEnabled = false, packaged = false, development, log: report = () => {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "notification-fixture-"));
  const directory = join(root, "home", "extensions", "github-notifications", "artifacts");
  const writes = [];
  const doneWrites = [];
  const deliveries = [];
  const requests = [];
  const errors = [];
  const warnings = [];
  let assetsUnavailable = assetFailure;
  let requestHook;
  let offset = 0;
  const rows = Array.from({ length: 53 }, (_, index) => {
    const id = String(index + 1);
    const titles = {
      1: "<img src=x onerror=alert(1)> Needle widget 1",
      2: "Needle widget 2",
      3: "Needle tool",
      51: "Needle older widget",
    };
    return thread(id, {
      updated_at: new Date(Date.UTC(2026, 0, 10, 12, 0, 53 - index)).toISOString(),
      repository: { full_name: index === 2 ? "example/tools" : "example/widgets" },
      subject: { title: titles[id] ?? `Synthetic notification ${id}`, type: "Issue", url: null },
    });
  });
  const run = async args => {
    const endpoint = args.at(-1);
    requests.push(endpoint);
    const intercepted = await requestHook?.(args);
    if (intercepted !== undefined) return intercepted;
    if (endpoint === "/repos/fletchto99/copilot-notifications-canvas/releases/latest" && args.includes("GET")) {
      return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
    }
    if (args.includes("PATCH") || args.includes("DELETE")) {
      const match = /^\/notifications\/threads\/(\d+)$/.exec(endpoint);
      const row = rows.find(item => item.id === match?.[1]);
      assert.ok(row?.unread, `Unexpected or repeated synthetic write: ${endpoint}`);
      row.unread = false;
      writes.push(row.id);
      if (args.includes("DELETE")) doneWrites.push(row.id);
      return `HTTP/2 ${args.includes("DELETE") ? 204 : 205} Synthetic\r\n\r\n`;
    }
    const url = new URL(endpoint, "https://api.github.com");
    assert.ok(args.includes("GET") && url.origin === "https://api.github.com" && url.pathname === "/notifications",
      `Unexpected request: ${endpoint}`);
    const offset = (Number(url.searchParams.get("page")) - 1) * 50;
    const unread = rows.filter(row => row.unread);
    return http(unread.slice(offset, offset + 50), offset + 50 < unread.length ? { link: next } : {});
  };
  const client = new GitHubClient({ run, now: () => Date.now() + offset });
  const preferences = new Preferences({ directory });
  const log = (message, options) => {
    (options.level === "warning" ? warnings : errors).push(message);
    report(message, options);
  };
  const desktop = new DesktopNotifications({
    preferences, client, now: () => Date.now() + offset, platform: "darwin",
    notify: async message => { deliveries.push(message); },
    log,
  });
  const updates = new Updates({ run: async args => {
    assert.equal(args.at(-1), "/repos/fletchto99/copilot-notifications-canvas/releases/latest");
    return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
  }, log });
  const inbox = new Inbox(client);
  let server;
  let registration;
  let closing;
  function close() {
    return closing ??= (async () => {
      inbox.close();
      try {
        await server?.close();
        await registration;
      } finally {
        try {
          await desktop.close();
        } finally {
          updates.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    })();
  }
  try {
    if (desktopEnabled) await preferences.update({ desktopNotifications: true });
    server = packaged
      ? await (await import("./browser/package-fixtures.mjs")).startPackagedCanvas(root, run, log)
      : await startServer(inbox, {
        preferences, desktop, updates, development, log,
        read: (path, options) => {
          if (assetsUnavailable && path.pathname.endsWith("/app.mjs")) {
            throw Object.assign(new Error("Synthetic asset failure"), { code: "ENOENT" });
          }
          return readFile(path, options);
        },
      });
    registration = server.ready?.then(ready => {
      if (ready) desktop.add("synthetic-fixture");
    });
    return {
      root, url: server.url, rows, writes, doneWrites, requests, preferences, deliveries, desktop, errors, warnings, close,
      setRequestHook: hook => { requestHook = hook; },
      advance: ms => { offset += ms; return Date.now() + offset; },
      recoverAssets: () => { assetsUnavailable = false; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
