import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

const readName = "Mark 2 shown, loaded notifications as read in example/widgets";
const doneName = "Mark 2 shown, loaded notifications as done in example/widgets";
const moreName = "More actions for example/widgets";

for (const width of [320, 960]) {
  for (const collapsed of [false, true]) {
    test(`repository dropdown works at ${width}px with ${collapsed ? "collapsed" : "expanded"} rows`, async ({ page, canvas }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(canvas.url);
      await page.getByRole("searchbox").fill("Needle");
      await expect(page.locator(".row")).toHaveCount(3);
      const read = page.getByRole("button", { name: readName, exact: true });
      const more = page.getByRole("button", { name: moreName, exact: true });
      const group = page.locator(".repo-group").filter({ has: more });
      if (collapsed) await group.locator(".repo-toggle").click();
      await read.focus();
      await page.keyboard.press("Tab");
      await expect(more).toBeFocused();
      await more.press("Enter");
      const done = page.getByRole("button", { name: doneName, exact: true });
      await expect(done).toBeFocused();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await expect(done).toHaveText("Mark 2 as done");
      await expect(read).toHaveText("Mark 2 as read");
      expect(canvas.writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const bounds = await done.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.batchAction,
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })).toBe("done");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`batch-menu-${width}-${collapsed}.png`), fullPage: true });
      await done.press("Escape");
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(more).toBeFocused();
      await more.press("Enter");
      await page.getByRole("heading", { name: "Unread Notifications", exact: true }).click();
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await more.click();
      await done.click();
      await expect(group).toHaveCount(0);
      expect(canvas.doneWrites).toEqual(["1", "2"]);
      expect(canvas.writes).toEqual(["1", "2"]);
      expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
      expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
    });
  }
}

test("a Done batch stops after the in-flight request and retries the original remaining selection", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  canvas.setRequestHook(async args => {
    if (args.includes("DELETE")) {
      entered();
      await held;
    }
  });
  try {
    await page.getByRole("button", { name: moreName, exact: true }).click();
    await page.getByRole("button", { name: doneName, exact: true }).click();
    await started;
    await expect(page.locator("#batch-title")).toContainText("Marking as done");
    await expect(page.getByRole("button", { name: moreName, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Stop remaining", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Stop remaining", exact: true }).click();
    await expect(page.locator("#batch-title")).toContainText("Stopping");
    canvas.setRequestHook(undefined);
    release();
    const retry = page.getByRole("button", { name: "Retry remaining (1)", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator("#batch-title")).toContainText("remain to mark as done");
    expect(canvas.doneWrites).toEqual(["1"]);
    await expect(page.locator(".repo-read")).toHaveText("Mark 1 as read");
    canvas.rows.push(thread("3"));
    await retry.click();
    await expect(page.locator(".row")).toHaveCount(0);
    expect(canvas.doneWrites).toEqual(["1", "2"]);
    expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
  } finally {
    release();
  }
});

test("failed Done batches keep their action after backoff and do not widen retries to new arrivals", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  canvas.setRequestHook(args => args.includes("DELETE") ? http({}, {}, 500) : undefined);
  await page.getByRole("button", { name: moreName, exact: true }).click();
  await page.getByRole("button", { name: doneName, exact: true }).click();
  await expect(page.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
  await expect(page.locator("#batch-title")).toContainText("remain to mark as done");
  await expect(page.locator(".row")).toHaveCount(2);
  expect(canvas.writes).toEqual([]);
  const retry = page.getByRole("button", { name: "Retry remaining (2)", exact: true });
  await expect(retry).toBeDisabled();
  canvas.setRequestHook(undefined);
  canvas.rows.push(thread("3"));
  await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
  await expect(page.locator(".row")).toHaveCount(3, { timeout: 10_000 });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator(".row")).toHaveCount(1);
  expect(canvas.doneWrites).toEqual(["1", "2"]);
  await expect(page.locator(".repo-read")).toHaveText("Mark 1 as read");
});
