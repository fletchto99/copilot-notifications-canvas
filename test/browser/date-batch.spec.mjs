import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

const timeZone = "America/Los_Angeles";
const date = "2026-01-12";
const label = "January 12, 2026";
const moreName = `More actions for ${label}`;
const actionName = action => `Mark 2 shown, loaded notifications as ${action} on ${label}`;

function prepareRows(canvas) {
  for (const row of canvas.rows) row.reason = "subscribed";
  Object.assign(canvas.rows[0], { reason: "mention", updated_at: "2026-01-13T07:59:00Z" });
  Object.assign(canvas.rows[1], { reason: "team_mention", updated_at: "2026-01-12T08:00:00Z" });
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
      await expect(page.locator("#shown-actions")).toBeHidden();
      await expect(page.locator(".repo-name")).toHaveText(["January 13, 2026", label]);
      await expect(page.getByRole("button", { name: "Collapse all", exact: true })).toBeVisible();
      const group = page.locator(".repo-group").filter({ has: page.getByRole("button", { name: moreName, exact: true }) });
      await expect(group.locator(".repo-read")).toHaveText("Mark 2 as read");
      await expect(group.locator(".row")).toHaveCount(2);
      await group.locator(".repo-toggle").click();
      await expect(group.locator(".row:visible")).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
      if (action === "done") {
        await group.locator(".repo-more").focus();
        await page.keyboard.press("Enter");
      }
      const button = page.getByRole("button", { name: actionName(action), exact: true });
      const request = page.waitForRequest(request => request.url().endsWith("/api/batch/start"));
      await button.focus();
      await button.press("Enter");
      expect((await request).postDataJSON()).toMatchObject({ scope: "date", date, timeZone, action });
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator(".repo-name")).toHaveText("January 13, 2026");
      expect(canvas.writes).toEqual(["1", "2"]);
      expect(canvas.doneWrites).toEqual(action === "done" ? ["1", "2"] : []);
      for (const id of ["3", "4", "5", "51"]) expect(canvas.rows.find(row => row.id === id).unread).toBe(true);
      expect(canvas.requests.some(endpoint => endpoint.includes("page=2"))).toBe(false);
      await expect(page.getByRole("tab", { name: "Mentioned (2)", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#shown-actions")).toBeHidden();
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
      const group = page.locator(".repo-group").filter({ has: page.getByRole("button", { name: moreName, exact: true }) });
      const read = page.getByRole("button", { name: actionName("read"), exact: true });
      const more = page.getByRole("button", { name: moreName, exact: true });
      await read.focus();
      await page.keyboard.press("Tab");
      await expect(more).toBeFocused();
      await more.press("Enter");
      const done = page.getByRole("button", { name: actionName("done"), exact: true });
      await expect(done).toBeFocused();
      const controlBounds = await group.locator(".repo-actions").boundingBox();
      const menuBounds = await group.locator(".repo-menu").boundingBox();
      expect(menuBounds.width).toBeCloseTo(controlBounds.width);
      expect(menuBounds.x).toBeGreaterThanOrEqual(0);
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width);
      const buttonBounds = await done.boundingBox();
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.batchDate,
        { x: buttonBounds.x + buttonBounds.width / 2, y: buttonBounds.y + buttonBounds.height / 2 })).toBe(date);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`date-actions-${width}.png`), fullPage: true });
      await done.press("Escape");
      await expect(more).toBeFocused();
      await expect(group.locator(".repo-menu")).toBeHidden();
      await page.getByRole("searchbox").fill("No matching notification");
      await expect(page.locator(".repo-group")).toHaveCount(0);
      await expect(page.locator("#shown-actions")).toBeHidden();
      expect(canvas.writes).toEqual([]);
    });
  }

  test("date cancellation and retry stay on the original day after grouping changes", async ({ page, canvas }) => {
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
      await page.getByRole("button", { name: moreName, exact: true }).click();
      await page.getByRole("button", { name: actionName("done"), exact: true }).click();
      await started;
      await expect(page.locator("#batch-title")).toContainText(`${label}: Marking as done`);
      await expect(page.locator(`[data-focus-key="bulk:date:${date}"]`)).toHaveText("Marking 0/2...");
      await expect(page.locator('[data-focus-key="bulk:date:2026-01-13"]')).toHaveText("Mark 1 as read");
      await expect(page.locator('[data-focus-key="bulk:date:2026-01-13"]')).toHaveAttribute("aria-busy", "false");
      await page.getByLabel("Settings", { exact: true }).click();
      await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("none");
      await page.keyboard.press("Escape");
      await expect(page.locator("#shown-actions .repo-read")).toBeDisabled();
      await expect(page.locator("#shown-actions .repo-read")).toHaveText("Mark 3 as read");
      await page.getByRole("button", { name: "Stop remaining", exact: true }).click();
      canvas.setRequestHook(undefined);
      release();
      const retry = page.getByRole("button", { name: "Retry remaining (1)", exact: true });
      await expect(retry).toBeVisible();
      expect(canvas.doneWrites).toEqual(["1"]);
      await expect(page.locator("#batch-title")).toContainText(`${label}: Some notifications remain to mark as done`);
      await retry.click();
      await expect(page.locator(".row")).toHaveCount(1);
      expect(canvas.doneWrites).toEqual(["1", "2"]);
      expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
      await expect(page.locator("#shown-actions .repo-read")).toHaveText("Mark 1 as read");
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
    await page.getByRole("button", { name: moreName, exact: true }).click();
    await page.getByRole("button", { name: actionName("done"), exact: true }).click();
    await expect(page.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
    const retry = page.getByRole("button", { name: "Retry remaining (2)", exact: true });
    await expect(retry).toBeDisabled();
    canvas.rows.push(thread("4", { updated_at: "2026-01-12T14:00:00Z", reason: "mention" }));
    canvas.setRequestHook(undefined);
    await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
    await expect(page.locator(`[data-focus-key="bulk:date:${date}"]`)).toHaveText("Mark 3 as read", { timeout: 10_000 });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.locator(".row")).toHaveCount(2);
    expect(canvas.doneWrites).toEqual(["1", "2"]);
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
    await expect(page.locator("#shown-actions")).toBeHidden();
    await page.getByRole("button", { name: moreName, exact: true }).click();
    await page.getByRole("button", { name: actionName("done"), exact: true }).click();
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator(".repo-name")).toHaveText("January 13, 2026");
    expect(canvas.doneWrites).toEqual(["1", "2"]);
  });
});
