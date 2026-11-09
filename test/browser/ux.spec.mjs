import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, inboxNext as next } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(packaged ? "packaged UX recovery" : "source UX recovery", () => {
    test.use({ packaged });

    for (const scope of ["row", "repo", "date", "none"]) {
      test(`completing the final notifications via ${scope} shows the caught-up view without refreshing`, async ({ page, canvas }) => {
        canvas.rows.splice(scope === "row" ? 1 : 2);
        canvas.rows[0].unread = false;
        await canvas.preferences.update({ groupBy: scope === "row" ? "repo" : scope });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(canvas.rows.length);
        const reads = () => canvas.requests.filter(path => path.startsWith("/notifications?"));
        expect(reads()).toHaveLength(1);
        const done = page.locator(scope === "row" ? ".mark-done" : ".repo-done");
        await done.focus();
        await done.press("Enter");
        await expect(page.locator(".row")).toHaveCount(0);
        await expect(page.locator("#empty-title")).toHaveText("All caught up \u{1F389}");
        await expect(page.locator("#empty-description")).toHaveText(scope === "none"
          ? "New notifications will appear here in GitHub inbox order."
          : `New notifications will appear here, grouped by ${scope === "date" ? "date" : "repository"}.`);
        for (const id of ["empty-refresh", "empty-symbol", "count", "more", "collapse"]) {
          await expect(page.locator(`#${id}`)).toBeHidden();
        }
        await expect(page.getByRole("searchbox")).toBeFocused();
        expect(reads()).toHaveLength(1);
        expect(canvas.doneWrites.toSorted()).toEqual(canvas.rows.map(row => row.id).toSorted());
        expect(canvas.deliveries).toEqual([]);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(results.violations).toEqual([]);
      });
    }

    test("cleared loaded rows offer refresh while unread items remain on later pages", async ({ page, canvas }) => {
      await canvas.preferences.update({ groupBy: "none" });
      let first = true;
      canvas.setRequestHook(args => {
        if (first && args.includes("GET") && args.at(-1).startsWith("/notifications?")) {
          first = false;
          return http(canvas.rows.slice(0, 2), { link: next });
        }
      });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await page.locator(".repo-done").click();
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(page.locator("#empty-title")).toHaveText("Loaded notifications cleared");
      await expect(page.locator("#more")).toBeDisabled();
      expect(canvas.rows.filter(row => row.unread)).toHaveLength(51);
      const refresh = page.getByRole("button", { name: "Refresh notifications", exact: true });
      await expect(refresh).toBeVisible();
      await refresh.focus();
      await refresh.press("Enter");
      await expect(page.locator(".row")).toHaveCount(50);
      await expect(page.locator("#empty")).toBeHidden();
      await expect(page.getByRole("searchbox")).toBeFocused();
      await expect(page.locator("#more")).toBeEnabled();
      expect(canvas.writes.toSorted()).toEqual(["1", "2"]);
    });

    test("failed filters retry on the polling cadence while a foreground refresh is paused", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      let fetches = 0;
      canvas.setRequestHook(args => {
        if (args.includes("GET") && args.at(-1).startsWith("/notifications?") && ++fetches === 1) {
          return http(canvas.rows, { "x-ratelimit-remaining": "0" });
        }
      });
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#group-by")).toBeEnabled();
      await expect(page.locator("#retry-status")).toBeVisible();
      await page.evaluate(() => {
        for (const hidden of [true, false]) {
          Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      let attempts = 0;
      let fail = true;
      await page.route("**/api/filters", async route => {
        attempts++;
        if (fail && attempts <= 4) {
          canvas.expectConsoleError("/api/filters", "Failed to load resource: the server responded with a status of 409 (Conflict)");
          await route.fulfill({
            status: 409, contentType: "application/json",
            body: JSON.stringify({ error: { message: "Synthetic filter failure" } }),
          });
        } else {
          await route.continue();
        }
      });
      const search = page.getByRole("searchbox");
      await search.fill("Needle widget 2");
      await page.clock.runFor(250);
      await expect(page.locator("#notice")).toContainText("Synthetic filter failure");
      await page.clock.runFor(4999);
      expect(attempts).toBe(1);
      expect(fetches).toBe(1);
      await expect(search).toHaveValue("Needle widget 2");
      await expect(page.locator(".row")).toHaveCount(2);
      await page.clock.runFor(1);
      await expect.poll(() => attempts).toBe(2);
      await expect(page.locator("#groups")).toHaveAttribute("aria-busy", "false");
      fail = false;
      await page.clock.runFor(5000);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#notice")).toBeHidden();
      expect(attempts).toBe(3);
      expect(fetches).toBe(1);
      if (!packaged) {
        // Only the source fixture injects the provider clock; packaged providers use real time.
        await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
        await page.clock.runFor(5000);
        await expect(page.locator("#retry-status")).toBeHidden();
        await expect(page.locator("#force-refresh")).toHaveAttribute("aria-disabled", "false");
        expect(fetches).toBe(2);
      }
      expect(attempts).toBe(3);
      await expect(search).toHaveValue("Needle widget 2");
      await expect(page.locator(".row")).toHaveCount(1);
      expect(canvas.writes).toEqual([]);
    });
  });
}

test("Settings follows keyboard focus and shows friendly grouping labels with unchanged values", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto(canvas.url);
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(page.locator("#group-by option")).toHaveText(["All notifications", "Repository", "Date"]);
  await page.locator("#group-by").selectOption("none");
  await expect(page.locator(".repo-name")).toHaveText(["All notifications"]);
  expect((await canvas.preferences.read()).groupBy).toBe("none");
  await page.locator("#check-updates").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#settings")).not.toHaveAttribute("open");
  await expect(page.locator("#settings-tooltip")).toBeHidden();
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  expect(await search.evaluate(node => {
    const box = node.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
  })).toBe(true);
  await page.getByLabel("Settings", { exact: true }).click();
  await page.locator("#force-refresh").focus();
  await expect(page.locator("#settings")).not.toHaveAttribute("open");
  await expect(page.locator("#force-refresh")).toBeFocused();
  expect(canvas.writes).toEqual([]);
});

test("refresh failures expose retry timing and ignore clicks during backoff without hiding cached rows", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  canvas.expectConsoleError("/api/refresh", "Failed to load resource: the server responded with a status of 502 (Bad Gateway)");
  canvas.setRequestHook(args => args.includes("GET") && args.at(-1).startsWith("/notifications?")
    ? http({}, {}, 500) : undefined);
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  await refresh.click();
  await expect(page.locator("#notice")).toContainText("HTTP 500");
  await expect(page.locator("#retry-status")).toHaveText(/^GitHub requests paused\. Retry after .+\.$/);
  await expect(refresh).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".row")).toHaveCount(2);
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await expect(page.locator("#refresh-tooltip-text")).toHaveText(/^GitHub requests paused\. Retry after .+\. Last updated /);
  const requests = canvas.requests.length;
  await refresh.press("Enter");
  expect(canvas.requests).toHaveLength(requests);
  canvas.setRequestHook(undefined);
  await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
  await expect(refresh).toHaveAttribute("aria-disabled", "false", { timeout: 10_000 });
  await expect(page.locator("#retry-status")).toBeHidden();
  await expect(page.locator("#notice")).toBeHidden();
  expect(canvas.writes).toEqual([]);
});

test("empty filter guidance does not suggest an unavailable Load more action", async ({ page, canvas }) => {
  await canvas.preferences.update({ hideEmptyTabs: false });
  canvas.rows.splice(1);
  canvas.rows[0].reason = "review_requested";
  await page.goto(canvas.url);
  await page.getByRole("tab", { name: "Mentioned (0)", exact: true }).click();
  await expect(page.locator("#empty-description")).toHaveText("Try another attention filter or search.");
  await expect(page.locator("#more")).toBeHidden();
  await page.getByRole("tab", { name: "All (1)", exact: true }).click();
  await page.getByRole("searchbox").fill("no matches");
  await expect(page.locator("#empty-description")).toHaveText("Try another title, number or repository.");
  expect(canvas.writes).toEqual([]);
});

test("row actions stay inline across the old breakpoint without clipping tooltips", async ({ page, canvas }, testInfo) => {
  canvas.rows.splice(2);
  canvas.rows[0].subject.title = "Improve keyboard navigation";
  canvas.rows[1].subject.title = "Clarify installation instructions";
  await canvas.preferences.update({ groupBy: "none" });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  for (const width of [320, 480, 481]) {
    await page.setViewportSize({ width, height: 700 });
    const rows = await page.locator(".row").evaluateAll(nodes => nodes.map(node => ({
      row: node.getBoundingClientRect().toJSON(),
      content: node.querySelector(".row-content").getBoundingClientRect().toJSON(),
      read: node.querySelector('[data-focus-key^="read:"]').getBoundingClientRect().toJSON(),
      done: node.querySelector('[data-focus-key^="done:"]').getBoundingClientRect().toJSON(),
    })));
    for (const { row, content, read, done } of rows) {
      expect(content.right).toBeLessThanOrEqual(read.left);
      expect(done.left - read.right).toBeCloseTo(4);
      expect(done.top).toBeCloseTo(read.top);
      for (const action of [read, done]) {
        expect(action.width).toBe(32);
        expect(action.height).toBe(32);
        expect(action.top).toBeLessThan(content.bottom);
        expect(action.bottom).toBeGreaterThan(content.top);
        expect(action.top).toBeGreaterThanOrEqual(row.top);
        expect(action.bottom).toBeLessThanOrEqual(row.bottom);
        expect(action.right).toBeLessThanOrEqual(row.right);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const read = page.locator('[data-focus-key="read:1"]');
    await read.focus();
    await expect(read).toHaveAccessibleDescription("Mark as read");
    await page.screenshot({ path: testInfo.outputPath(`inline-actions-${width}.png`), fullPage: true });
    await read.press("Escape");
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-focus-key="done:1"]')).toHaveAccessibleDescription("Mark as done");
  }
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  expect(canvas.writes).toEqual([]);
});
