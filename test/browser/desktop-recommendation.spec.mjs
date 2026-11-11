import AxeBuilder from "@axe-core/playwright";
import { test, expect, openSettings } from "./fixtures.mjs";

test("optional macOS recommendation is accessible, dismissible across reloads, and never enables delivery", async ({ page, canvas }) => {
  canvas.desktop.findNotifier = async () => null;
  canvas.rows.splice(1);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(canvas.url);
  const banner = page.getByRole("region", { name: "Optional macOS notification helper" });
  await expect(banner).toBeVisible();
  await expect(page.locator("#settings-panel")).not.toBeVisible();
  await expect(banner).toContainText("brew install terminal-notifier");
  await expect(banner.getByRole("link", { name: "Installation details" }))
    .toHaveAttribute("href", "https://formulae.brew.sh/formula/terminal-notifier");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  await banner.getByRole("button", { name: "Don't show again" }).focus();
  await page.keyboard.press("Enter");
  await expect(banner).toBeHidden();
  await expect(page.locator("#search")).toBeFocused();
  await page.reload();
  await expect(page.locator("#theme")).toHaveValue("system");
  await expect(banner).toBeHidden();
  expect((await canvas.preferences.read()).terminalNotifierHintDismissed).toBe(true);
  expect((await canvas.preferences.read()).desktopNotifications).toBe(false);
  await openSettings(page);
  await expect(page.locator("#desktop-backend")).toContainText("brew install terminal-notifier");
  expect(canvas.deliveries).toEqual([]);
  expect(canvas.writes).toEqual([]);
});

test("checking again detects an installed helper without installing, saving, or delivering anything", async ({ page, canvas }) => {
  canvas.desktop.findNotifier = async () => null;
  await page.goto(canvas.url);
  const banner = page.locator("#desktop-recommendation");
  await expect(banner).toBeVisible();
  await page.waitForLoadState("networkidle");
  canvas.desktop.findNotifier = async () => "/synthetic/bin/terminal-notifier";
  await banner.getByRole("button", { name: "Check again" }).click();
  await expect(banner).toBeHidden();
  await openSettings(page);
  await expect(page.locator("#desktop-backend")).toContainText("Uses terminal-notifier");
  expect((await canvas.preferences.read()).terminalNotifierHintDismissed).toBe(false);
  expect((await canvas.preferences.read()).desktopNotifications).toBe(false);
  expect(canvas.deliveries).toEqual([]);
  expect(canvas.writes).toEqual([]);
});
