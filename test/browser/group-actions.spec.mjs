import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

const readName = "Mark 2 as read in example/widgets; 2 shown, loaded notifications";
const doneName = "Mark 2 as done in example/widgets; 2 shown, loaded notifications";

for (const repository of ["example/ui", "example/notifications-and-workflow-tools", `example/${"long-".repeat(30)}repository`]) {
  test(`repository header wraps by content width for ${repository}`, async ({ page, canvas }, testInfo) => {
    canvas.rows.splice(2);
    for (const row of canvas.rows) row.repository.full_name = repository;
    await page.goto(canvas.url);
    const header = page.locator(".repo-header");
    const toggle = header.locator(".repo-toggle");
    await expect(header.locator(".repo-name")).toHaveText(repository);
    const intrinsicWidth = await toggle.evaluate(node => {
      const { flex, maxWidth } = node.style;
      node.style.flex = "0 0 max-content";
      node.style.maxWidth = "none";
      const width = node.getBoundingClientRect().width;
      node.style.flex = flex;
      node.style.maxWidth = maxWidth;
      return width;
    });
    for (const width of [960, 600, 481, 480, 400, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await header.evaluate(node => {
        const header = node.getBoundingClientRect();
        const toggle = node.querySelector(".repo-toggle").getBoundingClientRect();
        const actions = node.querySelector(".repo-actions").getBoundingClientRect();
        const style = getComputedStyle(node);
        const paddingLeft = parseFloat(style.paddingLeft);
        const paddingRight = parseFloat(style.paddingRight);
        return {
          available: header.width - paddingLeft - paddingRight, gap: parseFloat(style.columnGap),
          actionsWidth: actions.width, actionsRight: actions.right, headerRight: header.right - paddingRight,
          actionsLeft: actions.left, headerLeft: header.left + paddingLeft,
          wrapped: actions.top >= toggle.bottom, toggleWidth: toggle.width,
        };
      });
      expect(layout.wrapped).toBe(intrinsicWidth + layout.actionsWidth + layout.gap > layout.available + 0.5);
      expect(layout.actionsRight).toBeCloseTo(layout.headerRight);
      expect(layout.toggleWidth).toBeLessThanOrEqual(layout.available + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(header.locator(".repo-count")).toHaveText("2 total \u00b7 2 unread");
      if (repository === "example/ui" && width >= 400) expect(layout.wrapped).toBe(false);
      if (width === 480 || width === 320) {
        await page.screenshot({ path: testInfo.outputPath(`header-wrap-${width}.png`), fullPage: true });
      }
    }
    await toggle.click();
    const done = header.locator(".repo-done");
    await expect(done).toBeVisible();
    const bounds = await done.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(canvas.writes).toEqual([]);
  });
}

test("repository Done honors attention and search filters without changing the selected tab", async ({ page, canvas }) => {
  for (const row of canvas.rows) row.reason = "subscribed";
  canvas.rows[0].reason = "mention";
  canvas.rows[1].reason = "mention";
  canvas.rows[2].reason = "mention";
  canvas.rows[3].reason = "mention";
  canvas.rows[50].reason = "mention";
  await page.goto(canvas.url);
  await page.getByRole("searchbox").fill("Needle");
  const mentioned = page.getByRole("tab", { name: /^Mentioned \(\d+\)$/ });
  await mentioned.click();
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator("#count")).toHaveText("50 total \u00b7 50 unread \u00b7 3 matching");
  await page.getByRole("button", { name: doneName, exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(mentioned).toHaveAttribute("aria-selected", "true");
  await expect(mentioned).toHaveText("Mentioned (2)");
  expect(canvas.doneWrites).toEqual(["1", "2"]);
  expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
  expect(canvas.rows.find(row => row.id === "4").unread).toBe(true);
  expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
});

for (const width of [320, 960]) {
  for (const collapsed of [false, true]) {
    test(`direct repository actions work at ${width}px with ${collapsed ? "collapsed" : "expanded"} rows`, async ({ page, canvas }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(canvas.url);
      await page.getByRole("searchbox").fill("Needle");
      await expect(page.locator(".row")).toHaveCount(3);
      const read = page.getByRole("button", { name: readName, exact: true });
      const done = page.getByRole("button", { name: doneName, exact: true });
      const group = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/widgets"]') });
      if (collapsed) await group.locator(".repo-toggle").click();
      await read.focus();
      await page.keyboard.press("Tab");
      await expect(done).toBeFocused();
      await expect(done).toHaveAccessibleDescription("Mark 2 as done");
      await expect(read).toHaveAccessibleDescription("Mark 2 as read");
      expect(canvas.writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const controlBounds = await group.locator(".repo-actions").boundingBox();
      await expect(group.locator(".repo-menu, .repo-more")).toHaveCount(0);
      const readBounds = await read.boundingBox();
      const bounds = await done.boundingBox();
      expect(bounds.height).toBe(32);
      expect(bounds.width).toBe(32);
      expect(bounds.y).toBeCloseTo(readBounds.y);
      expect(bounds.x - readBounds.x - readBounds.width).toBeCloseTo(4);
      expect(bounds.x + bounds.width).toBeCloseTo(controlBounds.x + controlBounds.width);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.batchAction,
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })).toBe("done");
      const heading = page.getByRole("heading", { name: "GitHub Notifications", exact: true });
      for (const [button, action] of [[read, "read"], [done, "done"]]) {
        await expect(button).toHaveText("");
        await expect(button.locator("svg")).toBeVisible();
        const tooltip = page.locator(`#${await button.getAttribute("aria-describedby")}`);
        await heading.hover();
        await group.locator(".repo-toggle").focus();
        await expect(tooltip).toBeHidden();
        await button.hover();
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toHaveText(`Mark 2 as ${action}`);
        const tooltipBounds = await tooltip.boundingBox();
        expect(tooltipBounds.x).toBeGreaterThanOrEqual(0);
        expect(tooltipBounds.x + tooltipBounds.width).toBeLessThanOrEqual(width);
        await tooltip.hover();
        await expect(tooltip).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(tooltip).toBeHidden();
        await heading.hover();
        await button.focus();
        await expect(tooltip).toBeVisible();
        await button.press("Escape");
        await expect(tooltip).toBeHidden();
        await expect(button).toBeFocused();
      }
      expect(canvas.writes).toEqual([]);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`group-actions-${width}-${collapsed}.png`), fullPage: true });
      await done.press("Escape");
      await expect(done).toBeFocused();
      await expect(done).toBeVisible();
      await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).click();
      await expect(done).toBeVisible();
      await done.click();
      await expect(group).toHaveCount(0);
      expect(canvas.doneWrites).toEqual(["1", "2"]);
      expect(canvas.writes).toEqual(["1", "2"]);
      expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
      expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
    });
  }
}

test("a Done batch has no Stop control and completes only its original selection", async ({ page, canvas }) => {
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
    await page.getByRole("button", { name: doneName, exact: true }).click();
    await started;
    await expect(page.locator(".group-progress")).toHaveText("Marking 0/2 as done...");
    await expect(page.locator(".repo-done")).toBeDisabled();
    await expect(page.locator(".repo-done")).toBeFocused();
    await expect(page.getByRole("button", { name: "Stop remaining", exact: true })).toHaveCount(0);
    await expect(page.locator("#batch-progress")).toBeHidden();
    canvas.rows.push(thread("3"));
    canvas.setRequestHook(undefined);
    release();
    await expect(page.locator(".row")).toHaveCount(0);
    await expect(page.locator("#batch-progress")).toBeHidden();
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
  await expect(page.locator(".repo-read")).toHaveAccessibleDescription("Mark 1 as read");
  await expect(page.locator(".repo-done")).toBeVisible();
  await expect(page.locator('[data-focus-key="read:3"]')).toBeVisible();
  await expect(page.locator('[data-focus-key="done:3"]')).toBeVisible();
});

test("row and group actions lock only overlapping selections and expose independent batch controls", async ({ page, canvas }) => {
  canvas.rows.splice(5);
  canvas.rows[3].repository.full_name = "example/tools";
  canvas.rows[4].repository.full_name = "example/solo";
  await page.goto(canvas.url);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  canvas.setRequestHook(async args => {
    if (args.includes("PATCH") && args.at(-1).endsWith("/threads/1")) await held;
  });
  try {
    const rowRead = page.locator('[data-focus-key="read:1"]');
    await rowRead.click();
    await expect(rowRead).toBeDisabled();
    await expect(page.locator('[data-focus-key="done:1"]')).toBeDisabled();
    await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
    await expect(page.locator('[data-focus-key="bulk:example/widgets"]')).toBeDisabled();
    await page.locator('[data-focus-key="bulk-done:example/tools"]').click();
    const tools = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/tools"]') });
    await expect(tools.locator(".group-progress")).toHaveText("Queued 0/2 as done...");
    await expect(tools.locator(".repo-done")).toHaveAttribute("data-write-state", "queued");
    await expect(tools.locator(".repo-done")).toBeFocused();
    await expect(page.locator("#batch-progress")).toBeHidden();
    await expect(page.locator('[data-focus-key="done:3"]')).toBeDisabled();
    await expect(page.locator('[data-focus-key="done:4"]')).toBeDisabled();
    await page.locator('[data-focus-key="bulk-done:example/solo"]').click();
    const solo = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/solo"]') });
    await expect(solo.locator(".repo-done")).toBeFocused();
    await expect(page.getByRole("button", { name: "Stop remaining", exact: true })).toHaveCount(0);
    await expect(tools.locator(".group-progress")).toHaveText("Queued 0/2 as done...");
    await expect(solo.locator(".group-progress")).toHaveText("Queued 0/1 as done...");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    release();
    await expect(page.locator('[data-focus-key="read:1"]')).toHaveCount(0);
    await expect(page.locator('[data-focus-key="done:5"]')).toHaveCount(0);
    await expect(solo).toBeHidden();
    await expect(page.locator('[data-focus-key="done:3"]')).toHaveCount(0);
    await expect(page.locator('[data-focus-key="done:4"]')).toHaveCount(0);
    await expect(tools).toBeHidden();
    await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
    expect(canvas.writes).toEqual(["1", "3", "5", "4"]);
  } finally {
    release();
  }
});

test("completing one batch keeps keyboard focus usable in another running batch", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  canvas.rows[1].repository.full_name = "example/tools";
  await page.goto(canvas.url);
  let releaseFirst;
  let releaseSecond;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  canvas.setRequestHook(args => args.includes("PATCH") ? args.at(-1).endsWith("/threads/1") ? first : second : undefined);
  try {
    await page.locator('[data-focus-key="bulk:example/widgets"]').click();
    await page.locator('[data-focus-key="bulk:example/tools"]').click();
    const widgets = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/widgets"]') });
    const tools = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/tools"]') });
    await tools.locator(".repo-read").focus();
    await expect(widgets.locator(".group-progress")).toHaveText("Marking 0/1 as read...");
    await expect(tools.locator(".group-progress")).toHaveText("Queued 0/1 as read...");
    releaseFirst();
    await expect(widgets.locator(".group-progress")).toBeHidden();
    await expect(page.getByRole("searchbox")).toBeEnabled();
    await expect(tools.locator(".repo-read")).toBeFocused();
    await expect(tools.locator(".group-progress")).toHaveText("Marking 0/1 as read...");
    releaseSecond();
    await expect(tools.locator(".group-progress")).toBeHidden();
    await expect(tools.locator(".repo-toggle")).toBeFocused();
    expect(canvas.writes).toEqual(["1", "2"]);
  } finally {
    releaseFirst();
    releaseSecond();
  }
});

for (const groupBy of ["repo", "date", "none"]) {
  test(`search and attention stay usable during a captured ${groupBy} batch`, async ({ page, canvas }, testInfo) => {
    canvas.rows.splice(3);
    canvas.rows[0].reason = "mention";
    canvas.rows[1].reason = "mention";
    canvas.rows[2].reason = "assign";
    await canvas.preferences.update({ groupBy });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(canvas.url);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    canvas.setRequestHook(args => args.includes("DELETE") && args.at(-1).endsWith("/threads/1") ? held : undefined);
    try {
      await page.getByRole("tab", { name: "Mentioned (2)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(2);
      await page.locator(".repo-done").click();
      await expect(page.locator(".repo-done")).toBeFocused();
      await expect(page.locator(".repo-done")).toBeDisabled();
      await expect(page.locator(".group-progress")).toHaveText("Marking 0/2 as done...");
      await expect(page.locator("#batch-progress")).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("inline-progress.png"), fullPage: true });
      await page.getByRole("tab", { name: "Assigned (1)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator('[data-focus-key="done:3"]')).toBeEnabled();
      await page.getByRole("searchbox").fill("Needle tool");
      await expect(page.locator(".row")).toHaveCount(1);
      await page.locator("#force-refresh").click();
      await page.getByRole("searchbox").fill("No matches");
      await expect(page.locator(".row")).toHaveCount(0);
      await page.getByRole("searchbox").fill("Needle tool");
      await expect(page.locator(".row")).toHaveCount(1);
      release();
      await expect.poll(() => canvas.doneWrites).toEqual(["1", "2"]);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.getByRole("searchbox")).toBeFocused();
      await expect(page.getByRole("tab", { name: "Assigned (1)", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(canvas.rows[2].unread).toBe(true);
    } finally {
      release();
    }
  });
}

test("failure controls stay with their group and remain accessible when the group is hidden", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  await page.goto(canvas.url);
  canvas.setRequestHook(args => args.includes("DELETE") ? http({}, {}, 500) : undefined);
  await page.locator('[data-focus-key="bulk-done:example/widgets"]').click();
  const result = page.locator("#batch-progress");
  const widgets = page.locator(".repo-group").filter({ has: page.locator('[data-focus-key="repo:example/widgets"]') });
  await expect(widgets.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
  await expect(widgets.locator("#batch-retry")).toBeVisible();
  await expect(page.locator('[data-focus-key="bulk-done:example/widgets"]')).toBeFocused();
  await page.getByRole("searchbox").fill("Needle tool");
  await expect(page.locator("#additional-batches #batch-progress")).toBeVisible();
  await expect(result).toContainText("example/widgets");
  await page.getByRole("searchbox").fill("Needle widget 2");
  await expect(widgets.locator("#batch-retry")).toBeVisible();
  canvas.setRequestHook(undefined);
  await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
  await expect(widgets.locator("#batch-retry")).toBeEnabled({ timeout: 10_000 });
  await widgets.locator("#batch-retry").click();
  await expect(result).toBeHidden();
  expect(canvas.doneWrites).toEqual(["2"]);
  expect(canvas.rows[0].unread).toBe(true);
});
