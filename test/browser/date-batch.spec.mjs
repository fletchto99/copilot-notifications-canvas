import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

const timeZone = "America/Los_Angeles";
const date = "2026-01-12";
const label = "January 12, 2026";
const actionName = action => `Mark 2 as ${action} on ${label}; 2 shown, loaded notifications`;

function prepareRows(canvas) {
  for (const row of canvas.rows) row.reason = "subscribed";
  Object.assign(canvas.rows[0], { reason: "mention", updated_at: "2026-01-13T07:59:00Z" });
  Object.assign(canvas.rows[1], { reason: "mention", updated_at: "2026-01-12T08:00:00Z" });
  canvas.rows[1].repository.full_name = "example/other";
  Object.assign(canvas.rows[2], { reason: "mention", updated_at: "2026-01-13T08:00:00Z" });
  canvas.rows[3].updated_at = "2026-01-12T12:00:00Z";
  Object.assign(canvas.rows[4], { reason: "mention", updated_at: "2026-01-12T13:00:00Z" });
  Object.assign(canvas.rows[50], { reason: "mention", updated_at: "2026-01-12T14:00:00Z" });
}

async function filterInbox(page) {
  await page.getByRole("searchbox").fill("Needle");
  await page.getByRole("tab", { name: /^Mentioned \(\d+\)$/ }).click();
  await expect(page.locator(".row")).toHaveCount(3);
}

test.describe("date-scoped actions", () => {
  test.use({ timezoneId: timeZone });

  for (const action of ["read", "done"]) {
    test(`${action} targets only the selected browser-local date and loaded filter matches`, async ({ page, canvas }) => {
      prepareRows(canvas);
      await canvas.preferences.update({ groupBy: "date" });
      await page.goto(canvas.url);
      await filterInbox(page);
      await expect(page.locator('[data-batch-scope="shown"]')).toHaveCount(0);
      await expect(page.locator(".repo-name")).toHaveText(["January 13, 2026", label]);
      await expect(page.getByRole("button", { name: "Collapse all", exact: true })).toBeVisible();
      const group = page.locator(".repo-group").filter({ has: page.getByRole("button", { name: actionName("done"), exact: true }) });
      await expect(group.locator(".repo-read")).toHaveAccessibleDescription("Mark 2 as read");
      await expect(group.locator(".row")).toHaveCount(2);
      await group.locator(".repo-toggle").click();
      await expect(group.locator(".row:visible")).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
      const button = page.getByRole("button", { name: actionName(action), exact: true });
      const request = page.waitForRequest(request => request.url().endsWith("/api/batch/start"));
      await button.focus();
      await button.press("Enter");
      expect((await request).postDataJSON()).toMatchObject({ scope: "date", date, timeZone, action });
      await expect(page.locator(".row")).toHaveCount(action === "read" ? 3 : 1);
      if (action === "read") {
        await expect(group.locator(".repo-read")).toBeDisabled();
        await expect(group.locator(".repo-read")).toHaveAccessibleDescription("Mark 0 as read");
      } else await expect(page.locator(".repo-name")).toHaveText("January 13, 2026");
      expect(canvas.writes.toSorted()).toEqual(["1", "2"]);
      expect(canvas.doneWrites.toSorted()).toEqual(action === "done" ? ["1", "2"] : []);
      for (const id of ["3", "4", "5", "51"]) expect(canvas.rows.find(row => row.id === id).unread).toBe(true);
      expect(canvas.requests.some(endpoint => endpoint.includes("page=2"))).toBe(false);
      await expect(page.getByRole("tab", { name: `Mentioned (${action === "read" ? 4 : 2})`, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-batch-scope="shown"]')).toHaveCount(0);
      await expect(page.locator("#batch-progress")).toBeHidden();
    });
  }

  for (const width of [320, 960]) {
    test(`date-header controls remain accessible and compact at ${width}px`, async ({ page, canvas }, testInfo) => {
      prepareRows(canvas);
      await page.setViewportSize({ width, height: 900 });
      await canvas.preferences.update({ groupBy: "date" });
      await page.goto(canvas.url);
      await filterInbox(page);
      await expect(page.locator(".status-line .repo-read")).toHaveCount(0);
      await expect(page.locator("#collapse")).toBeVisible();
      const group = page.locator(".repo-group").filter({ has: page.getByRole("button", { name: actionName("done"), exact: true }) });
      const read = page.getByRole("button", { name: actionName("read"), exact: true });
      await read.focus();
      await page.keyboard.press("Tab");
      const done = page.getByRole("button", { name: actionName("done"), exact: true });
      await expect(done).toBeFocused();
      const controlBounds = await group.locator(".repo-actions").boundingBox();
      expect(controlBounds.x).toBeGreaterThanOrEqual(0);
      expect(controlBounds.x + controlBounds.width).toBeLessThanOrEqual(width);
      await expect(group.locator(".repo-menu")).toHaveCount(0);
      const buttonBounds = await done.boundingBox();
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.batchDate,
        { x: buttonBounds.x + buttonBounds.width / 2, y: buttonBounds.y + buttonBounds.height / 2 })).toBe(date);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`date-actions-${width}.png`), fullPage: true });
      await done.press("Escape");
      await expect(done).toBeFocused();
      await expect(done).toBeVisible();
      await page.getByRole("searchbox").fill("No matching notification");
      await expect(page.locator(".repo-group")).toHaveCount(0);
      await expect(page.locator('[data-batch-scope="shown"]')).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
    });
  }

  test("date actions finish their original day after grouping changes without a Stop control", async ({ page, canvas }) => {
    prepareRows(canvas);
    canvas.rows.splice(3);
    await canvas.preferences.update({ groupBy: "date" });
    await page.goto(canvas.url);
    let release;
    let entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    canvas.setRequestHook(async args => {
      if (args.includes("DELETE")) { entered(); await held; }
    });
    try {
      await page.getByRole("button", { name: actionName("done"), exact: true }).click();
      await started;
      await expect(page.locator(".group-progress:not([hidden])")).toHaveText("Marking 0/2 as done...");
      await expect(page.locator(`[data-focus-key="bulk-done:date:${date}"]`)).toHaveAccessibleDescription("Marking 0/2 as done...");
      await expect(page.locator('[data-focus-key="bulk:date:2026-01-13"]')).toHaveAccessibleDescription("Mark 1 as read");
      await expect(page.locator('[data-focus-key="bulk:date:2026-01-13"]')).toHaveAttribute("aria-busy", "false");
      await page.getByLabel("Settings", { exact: true }).click();
      await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("none");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-focus-key="bulk:shown"]')).toBeDisabled();
      await expect(page.locator('[data-focus-key="bulk:shown"]')).toHaveAccessibleDescription("Mark 3 as read");
      await expect(page.getByRole("button", { name: "Stop remaining", exact: true })).toHaveCount(0);
      canvas.setRequestHook(undefined);
      release();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#batch-progress")).toBeHidden();
      expect(canvas.doneWrites.toSorted()).toEqual(["1", "2"]);
      expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
      await expect(page.locator('[data-focus-key="bulk:shown"]')).toHaveAccessibleDescription("Mark 1 as read");
    } finally {
      release();
    }
  });

  test("date failures retain their day and never add newly arrived matches to retries", async ({ page, canvas }) => {
    prepareRows(canvas);
    canvas.rows.splice(3);
    await canvas.preferences.update({ groupBy: "date" });
    await page.goto(canvas.url);
    canvas.setRequestHook(args => args.includes("DELETE") ? http({}, {}, 500) : undefined);
    await page.getByRole("button", { name: actionName("done"), exact: true }).click();
    await expect(page.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
    const retry = page.getByRole("button", { name: "Retry remaining (2)", exact: true });
    await expect(retry).toBeDisabled();
    canvas.rows.push(thread("4", { updated_at: "2026-01-12T14:00:00Z", reason: "mention" }));
    canvas.setRequestHook(undefined);
    await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
    await expect(page.locator(`[data-focus-key="bulk:date:${date}"]`)).toHaveAccessibleDescription("Mark 3 as read", { timeout: 10_000 });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.locator(".row")).toHaveCount(2);
    expect(canvas.doneWrites.toSorted()).toEqual(["1", "2"]);
    expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
    expect(canvas.rows.find(row => row.id === "4").unread).toBe(true);
  });
});

test.describe("packaged date-specific controls", () => {
  test.use({ packaged: true, timezoneId: timeZone });

  test("the installed bundle keeps date-header Done limited to that browser-local day", async ({ page, canvas }) => {
    prepareRows(canvas);
    canvas.rows.splice(3);
    await page.goto(canvas.url);
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("date");
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-batch-scope="shown"]')).toHaveCount(0);
    await page.getByRole("button", { name: actionName("done"), exact: true }).click();
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("January 13, 2026");
    expect(canvas.doneWrites.toSorted()).toEqual(["1", "2"]);
  });
});
