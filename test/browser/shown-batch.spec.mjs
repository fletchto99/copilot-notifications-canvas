import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http } from "../fixtures.mjs";

const shownGroup = '.repo-group:has([data-focus-key="shown"])';

function prepareRows(canvas) {
  for (const row of canvas.rows) row.reason = "subscribed";
  canvas.rows[0].reason = "mention";
  canvas.rows[0].updated_at = "2026-01-12T12:00:00Z";
  canvas.rows[1].reason = "team_mention";
  canvas.rows[1].repository.full_name = "example/tools";
  canvas.rows[1].updated_at = "2026-01-11T12:00:00Z";
  canvas.rows[2].reason = "mention";
  canvas.rows[3].reason = "mention";
  canvas.rows[50].reason = "mention";
}

async function openFiltered(page, canvas, groupBy) {
  prepareRows(canvas);
  await canvas.preferences.update({ groupBy });
  await page.goto(canvas.url);
  await page.getByRole("searchbox").fill("Needle");
  await page.getByRole("tab", { name: /^Mentioned \(\d+\)$/ }).click();
  await expect(page.locator(".row")).toHaveCount(3);
}

test.describe("All notifications group", () => {
  const groupBy = "none";
  for (const action of ["read", "done"]) {
    test(`${groupBy} view batches ${action} only for loaded matches across repositories and dates`, async ({ page, canvas }) => {
      await openFiltered(page, canvas, groupBy);
      const root = page.locator(shownGroup);
      await expect(root).toBeVisible();
      await expect(root.locator(".repo-name")).toHaveText("All notifications");
      await expect(root.locator(".repo-count")).toHaveText("3 unread");
      await expect(root.locator(".repo-header .repo-read")).toHaveText("Mark 3 as read");
      await expect(page.locator(".status-line .repo-actions")).toHaveCount(0);
      await expect(page.locator("#collapse")).toBeVisible();
      await root.locator(".repo-toggle").click();
      await expect(root.locator(".row:visible")).toHaveCount(0);
      await expect(root.locator(".repo-read")).toBeVisible();
      expect(canvas.writes).toEqual([]);
      if (action === "done") {
        await page.getByRole("button", { name: "More actions for shown notifications", exact: true }).focus();
        await page.keyboard.press("Enter");
      }
      const button = page.getByRole("button", { name: `Mark 3 shown, loaded notifications as ${action}`, exact: true });
      await button.focus();
      await button.press("Enter");
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(root).toHaveCount(0);
      await expect(page.locator("#collapse")).toBeHidden();
      await expect(page.getByRole("searchbox")).toBeFocused();
      await expect(page.getByRole("tab", { name: "Mentioned (1)", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(canvas.writes).toEqual(["1", "2", "3"]);
      expect(canvas.doneWrites).toEqual(action === "done" ? ["1", "2", "3"] : []);
      expect(canvas.rows.find(row => row.id === "4").unread).toBe(true);
      expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
      expect(canvas.requests.some(path => path.startsWith("/notifications?") && !path.includes("page=1"))).toBe(false);
    });
  }

  for (const width of [320, 480, 960]) {
    test(`${groupBy} group-header controls fit at ${width}px and keep their dropdown accessible`, async ({ page, canvas }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await openFiltered(page, canvas, groupBy);
      const root = page.locator(shownGroup);
      const more = root.getByRole("button", { name: "More actions for shown notifications", exact: true });
      await expect(root.locator(".repo-read")).toHaveCSS("color", await more.evaluate(node => getComputedStyle(node).color));
      await expect(page.locator("#count")).toHaveText("50 unread \u00b7 3 matching");
      await expect(page.locator("#collapse")).toBeVisible();
      await expect(root.locator(".repo-name")).toHaveText("All notifications");
      await expect(root.locator(".repo-header > .repo-actions")).toHaveCount(1);
      await expect(page.locator(".status-line .repo-actions")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`shown-${groupBy}-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Collapse all", exact: true }).click();
      await expect(root.locator(".repo-toggle")).toHaveAttribute("aria-expanded", "false");
      await expect(root.locator(".row:visible")).toHaveCount(0);
      await root.locator(".repo-read").focus();
      await page.keyboard.press("Tab");
      await expect(more).toBeFocused();
      await more.press("Enter");
      const done = page.getByRole("button", { name: "Mark 3 shown, loaded notifications as done", exact: true });
      await expect(done).toBeFocused();
      const controls = await root.locator(".repo-actions").boundingBox();
      const menu = await root.locator(".repo-menu").boundingBox();
      expect(menu.width).toBeCloseTo(controls.width);
      expect(menu.x).toBeCloseTo(controls.x);
      const bounds = await done.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.batchScope,
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })).toBe("shown");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await done.press("Escape");
      await expect(root.locator(".repo-menu")).toBeHidden();
      await expect(more).toBeFocused();
      await more.click();
      await page.getByRole("searchbox").click();
      await expect(root.locator(".repo-menu")).toBeHidden();
      await page.getByRole("button", { name: "Expand all", exact: true }).click();
      await expect(root.locator(".repo-toggle")).toHaveAttribute("aria-expanded", "true");
      await expect(root.locator(".row:visible")).toHaveCount(3);
      await page.getByRole("searchbox").fill("No matching notification");
      await expect(root).toHaveCount(0);
      await expect(page.locator("#collapse")).toBeHidden();
      expect(canvas.writes).toEqual([]);
    });
  }
});

test("the single group keeps collapse state through filtering, refresh and grouping changes", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  await canvas.preferences.update({ groupBy: "none" });
  await page.goto(canvas.url);
  const group = page.locator(shownGroup);
  const disclosure = group.locator(".repo-toggle");
  await expect(disclosure).toHaveAccessibleName(/All notifications 3 unread/);
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(disclosure).toBeFocused();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("searchbox").fill("Needle widget");
  await expect(group.locator(".repo-count")).toHaveText("2 unread");
  await expect(group.locator(".repo-read")).toHaveText("Mark 2 as read");
  await expect(group.locator(".row:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Force refresh", exact: true }).click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await page.getByLabel("Settings", { exact: true }).click();
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  for (const value of ["repo", "date"]) {
    await grouping.selectOption(value);
    await expect(page.locator(".row:visible")).toHaveCount(2);
  }
  await grouping.selectOption("none");
  await page.keyboard.press("Escape");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(group.locator(".row:visible")).toHaveCount(2);
  expect(canvas.writes).toEqual([]);
});

test("shown batches stop and retry their original scope after switching to repository grouping", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  canvas.rows[1].repository.full_name = "example/tools";
  await canvas.preferences.update({ groupBy: "none" });
  await page.goto(canvas.url);
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  canvas.setRequestHook(async args => {
    if (args.includes("DELETE")) { entered(); await held; }
  });
  try {
    await page.getByRole("button", { name: "More actions for shown notifications", exact: true }).click();
    await page.getByRole("button", { name: "Mark 3 shown, loaded notifications as done", exact: true }).click();
    await started;
    await expect(page.locator("#batch-title")).toContainText("Shown notifications: Marking as done");
    await expect(page.getByRole("searchbox")).toBeDisabled();
    await expect(page.locator(shownGroup).locator(".repo-more")).toBeDisabled();
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("repo");
    await page.keyboard.press("Escape");
    await expect(page.locator(shownGroup)).toHaveCount(0);
    await page.getByRole("button", { name: "Stop remaining", exact: true }).click();
    canvas.setRequestHook(undefined);
    release();
    const retry = page.getByRole("button", { name: "Continue remaining (2)", exact: true });
    await expect(retry).toBeVisible();
    expect(canvas.doneWrites).toEqual(["1"]);
    await retry.click();
    await expect(page.locator(".row")).toHaveCount(0);
    expect(canvas.doneWrites).toEqual(["1", "2", "3"]);
  } finally {
    release();
  }
});

test("failed shown batches retry only their unchanged selection after backoff", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  canvas.rows[1].repository.full_name = "example/tools";
  await canvas.preferences.update({ groupBy: "none" });
  await page.goto(canvas.url);
  canvas.setRequestHook(args => args.includes("DELETE") ? http({}, {}, 500) : undefined);
  await page.getByRole("button", { name: "More actions for shown notifications", exact: true }).click();
  await page.getByRole("button", { name: "Mark 2 shown, loaded notifications as done", exact: true }).click();
  await expect(page.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
  const retry = page.getByRole("button", { name: "Retry remaining (2)", exact: true });
  await expect(retry).toBeDisabled();
  expect(canvas.writes).toEqual([]);
  canvas.rows.push({ ...canvas.rows[0], id: "3", subject: { title: "New arrival", type: "Issue", url: null } });
  canvas.setRequestHook(undefined);
  await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
  await expect(page.locator(shownGroup).locator(".repo-read")).toHaveText("Mark 3 as read", { timeout: 10_000 });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(shownGroup).locator(".repo-read")).toHaveText("Mark 1 as read");
  expect(canvas.doneWrites).toEqual(["1", "2"]);
});

test.describe("packaged list-wide controls", () => {
  test.use({ packaged: true });
  test("installed bundle supports Done in the collapsed All notifications header", async ({ page, canvas }) => {
    canvas.rows.splice(2);
    canvas.rows[1].repository.full_name = "example/tools";
    await page.goto(canvas.url);
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("none");
    await page.keyboard.press("Escape");
    await expect(page.locator(shownGroup).locator(".repo-name")).toHaveText("All notifications");
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    await expect(page.locator(".row:visible")).toHaveCount(0);
    const more = page.getByRole("button", { name: "More actions for shown notifications", exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await page.getByRole("button", { name: "Mark 2 shown, loaded notifications as done", exact: true }).click();
    await expect(page.locator(".row")).toHaveCount(0);
    await expect(page.locator(shownGroup)).toHaveCount(0);
    expect(canvas.doneWrites).toEqual(["1", "2"]);
  });
});
