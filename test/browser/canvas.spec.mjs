import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { CURRENT_VERSION } from "../../src/updates.mjs";

const searchName = "Search loaded notification titles, issue or PR numbers, and repositories";

test.describe("development footer", () => {
  const branch = `feature/<footer>&${"long-branch-name-".repeat(20)}`;
  test.use({ development: { version: CURRENT_VERSION, branch } });

  test("shows the version and literal branch without overflowing a narrow panel", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(canvas.url);
    const label = page.locator("footer #development-build");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(`dev (v${CURRENT_VERSION}) ${branch}`);
    await expect(label.locator("*")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole("button", { name: "Force refresh", exact: true }).click();
    await expect(label).toHaveText(`dev (v${CURRENT_VERSION}) ${branch}`);
    expect(canvas.writes).toEqual([]);
  });
});

test.describe("startup recovery", () => {
  test.use({ assetFailure: true, desktopEnabled: true });

  test("opens an accessible recovery page and loads the inbox automatically on the same URL", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.getByRole("status")).toContainText("Retrying in the background");
    expect(canvas.requests).toEqual([]);
    expect(canvas.writes).toEqual([]);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    canvas.recoverAssets();
    await expect(page.locator(".row")).toHaveCount(50, { timeout: 10_000 });
    await expect(page).toHaveURL(canvas.url);
    await expect(page.getByRole("searchbox", { name: searchName })).toBeEnabled();
    expect(canvas.writes).toEqual([]);
  });
});

test("real assets load under CSP, render titles as text, and support search and pagination", async ({ page, canvas }) => {
  const response = await page.goto(canvas.url);
  expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)> Needle widget 1", exact: true })).toBeVisible();
  await expect(page.locator(".row img")).toHaveCount(0);
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  await expect(page.locator(".row")).toHaveCount(3);
  await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Load more (up to 50)", exact: true })).toBeHidden();
  await page.getByRole("searchbox", { name: searchName }).fill("");
  await expect(page.locator(".row")).toHaveCount(53);
  expect(canvas.writes).toEqual([]);
});

test("issue and PR numbers render in metadata and search selects the notification thread, not its issue number", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/7";
  canvas.rows[1].subject.type = "PullRequest";
  canvas.rows[1].subject.url = "https://api.github.com/repos/example/widgets/pulls/8";
  await page.goto(canvas.url);
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)> Needle widget 1", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needle widget 2", exact: true })).toHaveAttribute("href", "https://github.com/example/widgets/pull/8");
  await expect(page.locator(".metadata").getByText("Issue #7", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata").getByText("Pull Request #8", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata").getByText("Issue", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needle tool", exact: true })).toBeVisible();
  await expect(page.locator(".row img")).toHaveCount(0);
  await page.getByRole("searchbox", { name: searchName }).fill("#7");
  await expect(page.locator(".row")).toHaveCount(1);
  await page.getByRole("button", { name: "Mark as read: #7 <img src=x onerror=alert(1)> Needle widget 1", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(0);
  expect(canvas.writes).toEqual(["1"]);
});

test("keyboard row actions mark exactly one notification and move focus to the next row", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  const button = page.getByRole("button", { name: "Mark as read: Needle widget 2", exact: true });
  await button.focus();
  await button.press("Enter");
  await expect(page.locator(".row")).toHaveCount(49);
  await expect(button).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark as read: Synthetic notification 4", exact: true })).toBeFocused();
  expect(canvas.writes).toEqual(["2"]);
});

for (const groupBy of ["repo", "date"]) {
  test(`keyboard row reads retain focus beside a collapsed ${groupBy} group`, async ({ page, canvas }) => {
    canvas.rows.splice(2);
    canvas.rows[0].repository.full_name = "example/alpha";
    canvas.rows[0].updated_at = "2026-01-11T12:00:00Z";
    canvas.rows[1].repository.full_name = "example/zulu";
    await canvas.preferences.update({ groupBy });
    await page.goto(canvas.url);
    await page.locator(".repo-toggle").nth(1).click();
    const button = page.locator('[data-thread-id="1"]');
    await button.focus();
    await button.press("Enter");
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.getByRole("searchbox", { name: searchName })).toBeFocused();
    await expect(page.locator(".repo-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".row")).toBeHidden();
    expect(canvas.writes).toEqual(["1"]);
  });
}

test("repository actions affect only shown loaded matches, not another repository or unloaded rows", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  const group = page.getByRole("button", { name: "Mark 2 shown, loaded notifications as read in example/widgets", exact: true });
  await expect(group).toBeVisible();
  await group.click();
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator("#batch-progress")).toBeHidden();
  expect(canvas.writes).toEqual(["1", "2"]);
  expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
  expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
  await expect(page.getByRole("searchbox", { name: searchName })).toBeEnabled();
});

test("refresh preserves keyboard focus and collapsed repository state", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  const disclosure = page.getByRole("button", { name: /example\/widgets 49 \/ 49 unread/ });
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  await refresh.focus();
  const requestCount = canvas.requests.length;
  canvas.rows[0].subject.title = "Changed during refresh";
  await refresh.press("Enter");
  await expect.poll(() => canvas.requests.length).toBeGreaterThan(requestCount);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(refresh).toBeFocused();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.press("Enter");
  await expect(page.getByRole("link", { name: "Changed during refresh", exact: true })).toBeVisible();
});

test("the toolbar refresh icon shows the current update age on hover and keyboard focus", async ({ page, canvas }, testInfo) => {
  canvas.rows.splice(1);
  await page.setViewportSize({ width: 320, height: 800 });
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  const tooltip = page.locator("#refresh-tooltip");
  const tooltipText = page.locator("#refresh-tooltip-text");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".toolbar > #refresh-control + #settings")).toHaveCount(1);
  await expect(refresh).not.toHaveAttribute("title");
  await expect(tooltip).toBeHidden();
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh).toHaveText("");
  await expect(page.locator("#updated, footer button")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  canvas.advance(23_000);
  await page.clock.setFixedTime(new Date(initial.lastFetchedAt + 23_000));
  await refresh.hover();
  expect(await tooltip.isVisible()).toBe(true);
  await expect(tooltip).toHaveText("Last updated 23 seconds ago");
  await expect(tooltipText).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
  const bounds = await tooltip.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("refresh-tooltip-light.png") });
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(tooltipText).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("refresh-tooltip-dark.png") });
  await page.getByRole("heading", { name: "Unread Notifications", exact: true }).hover();
  await expect(tooltip).toBeHidden();
  canvas.advance(1000);
  await page.clock.setFixedTime(new Date(initial.lastFetchedAt + 24_000));
  await refresh.focus();
  expect(await tooltip.isVisible()).toBe(true);
  await expect(tooltip).toHaveText("Last updated 24 seconds ago");
  await expect(refresh).toHaveAccessibleDescription("Last updated 24 seconds ago");
  await refresh.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(refresh).toBeFocused();
  await page.getByRole("searchbox").focus();
  await refresh.focus();
  expect(await tooltip.isVisible()).toBe(true);
  const requestCount = canvas.requests.length;
  canvas.rows[0].subject.title = "Updated from the toolbar";
  await refresh.press("Enter");
  await expect(page.getByRole("link", { name: "Updated from the toolbar", exact: true })).toBeVisible();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(tooltip).toHaveText("Last updated 0 seconds ago");
  await expect(refresh).toBeFocused();
  await expect(refresh.locator("svg")).toHaveCount(1);
  expect(canvas.requests.length).toBe(requestCount + 1);
  expect(canvas.writes).toEqual([]);
});

test("the refresh icon exposes pending state, preserves queued clicks, and respects reduced motion", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = canvas.requests.length;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  canvas.setRequestHook(args => args.at(-1).startsWith("/notifications") ? held : undefined);
  try {
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#refresh-tooltip-text")).toHaveText(/^Refreshing\. Last updated /);
    await expect(refresh).toBeEnabled();
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "refresh-spin");
    await refresh.click();
    await expect(page.locator("#refresh-tooltip-text")).toHaveText(/^Refresh queued\. Last updated /);
    canvas.setRequestHook(undefined);
    release();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh.locator("svg")).toHaveCount(1);
    expect(canvas.requests.length).toBe(before + 2);
    expect(canvas.writes).toEqual([]);
  } finally {
    release();
  }
});

test("all toolbar icons use matching instant tooltips with keyboard and Escape support", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  const heading = page.getByRole("heading", { name: "Unread Notifications", exact: true });
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", dark ? "dark" : "light");
    for (const [id, tooltipId, label] of [
      ["open-inbox", "inbox-tooltip", "Open GitHub inbox"],
      ["force-refresh", "refresh-tooltip", null],
      ["settings-toggle", "settings-tooltip", "Settings"],
    ]) {
      const control = page.locator(`#${id}`);
      const tooltip = page.locator(`#${tooltipId}`);
      await expect(control).not.toHaveAttribute("title");
      await heading.hover();
      await page.getByRole("searchbox").focus();
      await expect(tooltip).toBeHidden();
      await control.hover();
      expect(await tooltip.isVisible()).toBe(true);
      if (label) await expect(tooltip).toHaveText(label);
      await expect(control).toHaveAccessibleDescription(await tooltip.textContent());
      const text = tooltip.locator(".tooltip-content");
      await expect(text).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
      await expect(text).toHaveCSS("font-weight", "400");
      const bounds = await tooltip.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
      await heading.hover();
      await control.focus();
      expect(await tooltip.isVisible()).toBe(true);
      await control.press("Escape");
      await expect(tooltip).toBeHidden();
      await expect(control).toBeFocused();
    }
  }
  const settings = page.locator("#settings-toggle");
  await settings.press("Enter");
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#settings-tooltip")).toBeHidden();
  await page.getByRole("combobox", { name: "Theme", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(settings).toBeFocused();
  await expect(page.locator("#settings-tooltip")).toBeHidden();
  expect(canvas.writes).toEqual([]);
});

test("opening Settings hides its active tooltip despite hover or keyboard focus", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  const settings = page.locator("#settings-toggle");
  const tooltip = page.locator("#settings-tooltip");
  const panel = page.locator("#settings-panel");
  for (const trigger of ["pointer", "keyboard"]) {
    await page.getByRole("heading", { name: "Unread Notifications", exact: true }).hover();
    await page.getByRole("searchbox").focus();
    if (trigger === "pointer") await settings.hover();
    else await settings.focus();
    await expect(tooltip).toBeVisible();
    if (trigger === "pointer") await settings.click();
    else await settings.press("Enter");
    await expect(panel).toBeVisible();
    await expect(tooltip).toBeHidden();
    await settings.hover();
    await settings.focus();
    await expect(tooltip).toBeHidden();
    await settings.click();
    await expect(panel).toBeHidden();
    await expect(tooltip).toBeVisible();
  }
  expect(canvas.writes).toEqual([]);
});

test("activating Open inbox and losing canvas focus dismiss tooltips despite retained element focus", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  const inbox = page.getByRole("link", { name: "Open GitHub inbox", exact: true });
  const inboxTooltip = page.locator("#inbox-tooltip");
  await page.evaluate(() => {
    // Exercise activation without navigating the test browser to the real GitHub inbox.
    document.getElementById("open-inbox").addEventListener("click", event => event.preventDefault());
  });
  for (const trigger of ["pointer", "keyboard"]) {
    await page.getByRole("heading", { name: "Unread Notifications", exact: true }).hover();
    await page.getByRole("searchbox").focus();
    if (trigger === "pointer") await inbox.hover();
    else await inbox.focus();
    await expect(inboxTooltip).toBeVisible();
    if (trigger === "pointer") await inbox.click();
    else await inbox.press("Enter");
    await expect(inboxTooltip).toBeHidden();
    if (trigger === "keyboard") await expect(inbox).toBeFocused();
    await expect(inbox).toHaveAttribute("href", "https://github.com/notifications");
    await expect(inbox).toHaveAttribute("target", "_blank");
  }
  for (const [control, tooltip] of [
    ["#open-inbox", "#inbox-tooltip"],
    ["#force-refresh", "#refresh-tooltip"],
    ["#settings-toggle", "#settings-tooltip"],
  ]) {
    await page.getByRole("searchbox").focus();
    await page.locator(control).focus();
    await expect(page.locator(tooltip)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator(tooltip)).toBeHidden();
    await expect(page.locator(control)).toBeFocused();
  }
  expect(canvas.writes).toEqual([]);
});

test("a stationary tooltip updates at 15-second ticks without fetching notifications", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  const tooltip = page.locator("#refresh-tooltip-text");
  await page.getByRole("button", { name: "Force refresh", exact: true }).hover();
  await expect(tooltip).toHaveText("Last updated 0 seconds ago");
  for (let tick = 0; tick < 3; tick++) {
    const previous = await tooltip.textContent();
    await page.clock.runFor(14_999);
    await expect(tooltip).toHaveText(previous);
    await page.clock.runFor(1);
    const age = await page.evaluate(fetchedAt => Math.floor(Math.max(0, Date.now() - fetchedAt) / 1000), initial.lastFetchedAt);
    await expect(tooltip).toHaveText(`Last updated ${age} seconds ago`);
    expect(canvas.requests.filter(path => path.startsWith("/notifications")).length).toBe(1);
  }
  expect(canvas.writes).toEqual([]);
});

test("foreground checks use a 60-second interval, pause while hidden, and refresh immediately on return", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  await expect(page.locator(".row")).toHaveCount(1);
  expect(initial.nextRefreshAt - initial.lastFetchedAt).toBe(60_000);
  await expect(page.locator("#refresh-tooltip-text")).toHaveText(/Last updated \d+ seconds? ago/);
  const notificationRequests = () => canvas.requests.filter(path => path.startsWith("/notifications")).length;
  expect(notificationRequests()).toBe(1);

  await page.evaluate(() => { document.documentElement.style.display = "none"; });
  await expect(page.locator("html")).toBeHidden();
  await page.clock.setFixedTime(new Date(canvas.advance(1000)));
  await page.waitForTimeout(5500);
  expect(notificationRequests()).toBe(1);

  canvas.rows[0].subject.title = "Updated when visible again";
  const resumedRequest = page.waitForRequest(request => request.url().endsWith("/api/refresh"));
  await page.evaluate(() => { document.documentElement.style.display = ""; });
  expect((await resumedRequest).postDataJSON()).toEqual({ force: true });
  await expect(page.getByRole("link", { name: "Updated when visible again", exact: true })).toBeVisible();
  expect(notificationRequests()).toBe(2);

  canvas.rows[0].subject.title = "Updated on the next foreground check";
  await page.clock.setFixedTime(new Date(canvas.advance(61_000)));
  await expect(page.getByRole("link", { name: "Updated on the next foreground check", exact: true })).toBeVisible({ timeout: 10_000 });
  expect(notificationRequests()).toBe(3);
  expect(canvas.writes).toEqual([]);
});

test.describe("synchronized desktop alerts", () => {
  test.use({ desktopEnabled: true });

  test("foreground polling updates the inbox and alerts together, then hidden alerts retain the background cadence", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(50);
    await canvas.desktop.sync();
    expect(canvas.deliveries).toEqual([]);
    const notificationRequests = () => canvas.requests.filter(path => path.startsWith("/notifications")).length;
    expect(notificationRequests()).toBe(1);

    const time = canvas.advance(61_000);
    canvas.rows[0].updated_at = new Date(time).toISOString();
    canvas.rows[0].subject.title = "Synchronized foreground notification";
    await page.clock.setFixedTime(new Date(time));
    await expect(page.getByRole("link", { name: "Synchronized foreground notification", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => canvas.deliveries.map(alert => alert.body)).toEqual(["Synchronized foreground notification"]);
    expect(notificationRequests()).toBe(2);

    await page.evaluate(() => { document.documentElement.style.display = "none"; });
    await expect(page.locator("html")).toBeHidden();
    canvas.rows[0].updated_at = new Date(canvas.advance(30_000)).toISOString();
    canvas.rows[0].subject.title = "Background notification";
    await canvas.desktop.check();
    expect(canvas.deliveries).toHaveLength(1);
    expect(notificationRequests()).toBe(2);
    canvas.advance(31_000);
    await canvas.desktop.check();
    expect(canvas.deliveries.map(alert => alert.body)).toEqual([
      "Synchronized foreground notification", "Background notification",
    ]);
    expect(notificationRequests()).toBe(3);
    expect(canvas.writes).toEqual([]);
  });
});

test("Settings supports keyboard dismissal and persists theme and auto-open across reloads", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  const settings = page.getByLabel("Settings", { exact: true });
  await settings.focus();
  await Promise.all([
    page.evaluate(() => new Promise(resolve => {
      document.getElementById("settings").addEventListener("toggle", () => resolve(), { once: true });
    })),
    settings.press("Enter"),
  ]);
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toBeEnabled();
  await expect(theme).toHaveValue("system");
  await theme.focus();
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(theme).toBeFocused();
  const autoOpen = page.getByRole("switch", { name: "Auto-open", exact: true });
  await autoOpen.click();
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).not.toHaveAttribute("open", "");
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await settings.click();
  await expect(theme).toHaveValue("dark");
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Desktop notifications", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("combobox", { name: "Sound", exact: true })).toHaveValue("default");
  expect(await canvas.preferences.read()).toEqual({
    autoOpen: true, darkMode: true, desktopNotifications: false, desktopSound: "default", groupBy: "repo",
  });
  await theme.selectOption("system");
  await expect.poll(async () => (await canvas.preferences.read()).darkMode).toBeNull();
  await page.reload();
  await settings.click();
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  expect(canvas.deliveries).toEqual([]);
});

test("ungrouped notifications stay globally newest first through pagination, search and reload", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByLabel("Settings", { exact: true }).click();
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  await expect(grouping).toHaveValue("repo");
  await grouping.selectOption("none");
  await expect(page.locator(".repo-group")).toHaveCount(0);
  await expect(page.locator("#collapse")).toBeHidden();
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.slice(0, 50).map(row => row.subject.title));
  await expect(page.locator(".row .repository").nth(2)).toHaveText("example/tools");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.map(row => row.subject.title));
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.filter(row => row.subject.title.includes("Needle")).map(row => row.subject.title));
  await page.reload();
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(grouping).toHaveValue("none");
  await expect(page.locator(".repo-group")).toHaveCount(0);
  expect(canvas.writes).toEqual([]);
});

test("date groups span repositories and keep row-action focus in newest-first order", async ({ page, canvas }) => {
  canvas.rows.splice(4);
  canvas.rows[0].updated_at = "2026-01-09T23:59:00Z";
  canvas.rows[1].updated_at = "2026-01-10T00:01:00Z";
  canvas.rows[2].updated_at = "2026-01-10T00:02:00Z";
  canvas.rows[3].updated_at = "2026-01-09T00:00:00Z";
  await page.goto(canvas.url);
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("date");
  await expect(page.locator(".repo-name")).toHaveText(["January 10, 2026", "January 9, 2026"]);
  await expect(page.locator(".row .title")).toHaveText([2, 1, 0, 3].map(index => canvas.rows[index].subject.title));
  await expect(page.locator(".repo-read")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const read = page.getByRole("button", { name: "Mark as read: Needle tool", exact: true });
  await read.focus();
  await read.press("Enter");
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Mark as read: Needle widget 2", exact: true })).toBeFocused();
  expect(canvas.writes).toEqual(["3"]);
  const collapse = page.getByRole("button", { name: "Collapse all", exact: true });
  await collapse.click();
  await expect(page.locator(".row:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.locator(".row:visible")).toHaveCount(3);
});

for (const width of [320, 480, 960]) {
  for (const theme of ["light", "dark"]) {
    test(`${theme} mode at ${width}px has no horizontal overflow and passes accessibility checks`, async ({ page, canvas }, testInfo) => {
      canvas.rows.splice(4);
      canvas.rows[0].subject.title = `A long notification title ${"without-spaces-".repeat(15)}`;
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/42";
      await canvas.preferences.update({ darkMode: theme === "dark" });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(4);
      await expect(page.locator("html")).toHaveAttribute("data-notification-theme", theme);
      const inboxLink = page.locator(".toolbar").getByRole("link", { name: "Open GitHub inbox", exact: true });
      await expect(inboxLink).toBeVisible();
      await expect(inboxLink).toHaveAttribute("href", "https://github.com/notifications");
      await expect(page.locator("footer a")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toBeEnabled();
      const bounds = await page.locator("#settings-panel").boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), fullPage: true });
    });
  }
}
