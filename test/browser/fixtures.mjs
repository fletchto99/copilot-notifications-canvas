import { test as base, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../../.github/extensions/github-notifications/github.mjs";
import { Inbox } from "../../.github/extensions/github-notifications/inbox.mjs";
import { Preferences } from "../../.github/extensions/github-notifications/settings.mjs";
import { startServer } from "../../.github/extensions/github-notifications/server.mjs";
import { Updates, CURRENT_VERSION } from "../../.github/extensions/github-notifications/updates.mjs";
import { http, next, thread } from "../fixtures.mjs";

export { expect };

export const test = base.extend({
  canvas: async ({ page, context }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notification-browser-"));
    const writes = [];
    const requests = [];
    const errors = [];
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
    const client = new GitHubClient({ run: async args => {
      const endpoint = args.at(-1);
      requests.push(endpoint);
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
    } });
    const preferences = new Preferences({ directory });
    const updates = new Updates({ run: async args => {
      expect(args.at(-1)).toBe("/repos/fletchto99/copilot-notifications-canvas/releases/latest");
      return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
    } });
    let server;
    try {
      server = await startServer(new Inbox(client), { preferences, updates, log: message => errors.push(message) });
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
      await use({ url: server.url, rows, writes, requests, preferences });
      expect(errors, "Browser execution, CSP, and external-network errors").toEqual([]);
    } finally {
      await context.unrouteAll({ behavior: "wait" });
      await page.close();
      updates.close();
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

function assertUnread(row, endpoint) {
  if (!row?.unread) throw new Error(`Unexpected or repeated synthetic write: ${endpoint}`);
}
