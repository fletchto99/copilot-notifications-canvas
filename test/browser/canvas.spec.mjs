import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

const searchName = "Search loaded notification titles and repositories";

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

test("Settings supports keyboard dismissal and persists theme and auto-open across reloads", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  const settings = page.getByLabel("Settings", { exact: true });
  await settings.focus();
  await settings.press("Enter");
  const dark = page.getByRole("switch", { name: "Dark mode", exact: true });
  await expect(dark).toBeEnabled();
  await dark.focus();
  await dark.press("Space");
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await expect(dark).toBeFocused();
  const autoOpen = page.getByRole("switch", { name: "Auto-open", exact: true });
  await autoOpen.click();
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).not.toHaveAttribute("open", "");
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await settings.click();
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Desktop notifications", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("combobox", { name: "Sound", exact: true })).toHaveValue("default");
  expect(await canvas.preferences.read()).toEqual({
    autoOpen: true, darkMode: true, desktopNotifications: false, desktopSound: "default",
  });
  expect(canvas.deliveries).toEqual([]);
});

for (const width of [320, 480, 960]) {
  for (const theme of ["light", "dark"]) {
    test(`${theme} mode at ${width}px has no horizontal overflow and passes accessibility checks`, async ({ page, canvas }, testInfo) => {
      canvas.rows.splice(4);
      canvas.rows[0].subject.title = `A long notification title ${"without-spaces-".repeat(15)}`;
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
      await expect(page.getByRole("switch", { name: "Dark mode", exact: true })).toBeEnabled();
      const bounds = await page.locator("#settings-panel").boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), fullPage: true });
    });
  }
}
