import { test as base, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../../src/github.mjs";
import { Inbox } from "../../src/inbox.mjs";
import { DesktopNotifications } from "../../src/desktop.mjs";
import { Preferences } from "../../src/settings.mjs";
import { startServer } from "../../src/server.mjs";
import { Updates, CURRENT_VERSION } from "../../src/updates.mjs";
import { http, next, thread } from "../fixtures.mjs";
import { startPackagedCanvas } from "./package-fixtures.mjs";

export { expect };

export const test = base.extend({
  assetFailure: [false, { option: true }],
  desktopEnabled: [false, { option: true }],
  packaged: [false, { option: true }],
  development: [undefined, { option: true }],
  canvas: async ({ page, context, assetFailure, desktopEnabled, packaged, development }, use) => {
    const root = await mkdtemp(join(tmpdir(), "notification-browser-"));
    const directory = join(root, "home", "extensions", "github-notifications", "artifacts");
    const writes = [];
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
      if (endpoint.endsWith("/releases/latest")) {
        return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
      }
      if (args.includes("PATCH")) {
        const match = /^\/notifications\/threads\/(\d+)$/.exec(endpoint);
        const row = rows.find(item => item.id === match?.[1]);
        assertUnread(row, endpoint);
        row.unread = false;
        writes.push(row.id);
        return "HTTP/2 205 Reset Content\r\n\r\n";
      }
      const url = new URL(endpoint, "https://api.github.com");
      if (!args.includes("GET") || url.pathname !== "/notifications") throw new Error(`Unexpected request: ${endpoint}`);
      const offset = (Number(url.searchParams.get("page")) - 1) * 50;
      const unread = rows.filter(row => row.unread);
      return http(unread.slice(offset, offset + 50), offset + 50 < unread.length ? { link: next } : {});
    };
    const client = new GitHubClient({ run, now: () => Date.now() + offset });
    const preferences = new Preferences({ directory });
    if (desktopEnabled) await preferences.update({ desktopNotifications: true });
    const desktop = new DesktopNotifications({
      preferences, client, now: () => Date.now() + offset, platform: "darwin",
      notify: async message => { deliveries.push(message); },
      log: message => errors.push(message),
    });
    const updates = new Updates({ run: async args => {
      expect(args.at(-1)).toBe("/repos/fletchto99/copilot-notifications-canvas/releases/latest");
      return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
    } });
    let server;
    let registration;
    const log = (message, options) => (options.level === "warning" ? warnings : errors).push(message);
    try {
      server = packaged ? await startPackagedCanvas(root, run, log) : await startServer(new Inbox(client), {
        preferences, desktop, updates, development,
        log,
        read: (path, options) => {
          if (assetsUnavailable && path.pathname.endsWith("/app.mjs")) {
            throw Object.assign(new Error("Synthetic asset failure"), { code: "ENOENT" });
          }
          return readFile(path, options);
        },
      });
      registration = server.ready?.then(ready => {
        if (ready) desktop.add("browser-test");
      });
      const origin = new URL(server.url).origin;
      await context.route("**/*", async route => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        errors.push(`Unexpected external browser request: ${url}`);
        await route.abort("blockedbyclient");
      });
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use({ url: server.url, rows, writes, requests, preferences, deliveries,
        desktop,
        setRequestHook: hook => { requestHook = hook; },
        advance: ms => { offset += ms; return Date.now() + offset; },
        recoverAssets: () => { assetsUnavailable = false; } });
      expect(errors, "Browser execution, CSP, and external-network errors").toEqual([]);
      expect(warnings).toEqual(assetFailure
        ? ["Could not load the notifications canvas assets (ENOENT). Retrying in the background."] : []);
    } finally {
      await context.unrouteAll({ behavior: "wait" });
      await page.close();
      await server?.close();
      await registration;
      await desktop.close();
      updates.close();
      await rm(root, { recursive: true, force: true });
    }
  },
});

function assertUnread(row, endpoint) {
  if (!row?.unread) throw new Error(`Unexpected or repeated synthetic write: ${endpoint}`);
}
