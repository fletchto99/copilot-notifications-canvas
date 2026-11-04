import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

const baseUrl = "https://git.example.com/api/v3";

test.describe("development API selection", () => {
  test.use({ developmentApiBaseUrl: "https://api.github.com" });

  test("saves a custom API accessibly without switching the current panel", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(1);
    await page.getByLabel("Settings", { exact: true }).click();
    await page.getByLabel("Development API", { exact: true }).selectOption("custom");
    await page.getByLabel("REST API base URL").fill(baseUrl);
    await page.getByRole("button", { name: "Save API", exact: true }).click();
    await expect(page.locator("#development-api-reload")).toBeVisible();
    await expect(page.locator("#development-api-active")).toHaveText("Active API: https://api.github.com");
    await expect(page.getByRole("link", { name: "Open GitHub inbox", exact: true })).toHaveAttribute("href", "https://github.com/notifications");
    expect(await canvas.preferences.readDevelopmentAPI()).toBe(baseUrl);
    expect(canvas.requests.every(endpoint => new URL(endpoint, "https://api.github.com").origin === "https://api.github.com")).toBe(true);
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const gaps = await page.locator("#development-settings").evaluate(node => {
      const active = node.querySelector("#development-api-active").getBoundingClientRect();
      const help = node.querySelector("#development-api-help").getBoundingClientRect();
      const auth = node.querySelector("#development-api-auth").getBoundingClientRect();
      return { beforeHelp: help.top - active.bottom, beforeAuth: auth.top - help.bottom };
    });
    expect(gaps.beforeHelp).toBeCloseTo(8, 2);
    expect(gaps.beforeAuth).toBeCloseTo(gaps.beforeHelp, 2);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Settings", { exact: true })).toBeFocused();
  });
});

test.describe("custom API panels", () => {
  test.use({ developmentApiBaseUrl: baseUrl, desktopEnabled: true });

  test("loads and paginates only the custom API with host-specific links and no desktop alerts", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(50);
    await expect(page.locator("#development-api-notice")).toContainText("may share production data");
    await expect(page.getByRole("link", { name: "Open GitHub inbox", exact: true })).toHaveAttribute("href", "https://git.example.com/notifications");
    await expect(page.locator(".row a").first()).toHaveAttribute("href", "https://git.example.com/notifications");
    await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
    await expect(page.locator(".row")).toHaveCount(53);
    expect(canvas.requests.every(endpoint => endpoint.startsWith(baseUrl + "/notifications"))).toBe(true);
    await page.getByLabel("Settings", { exact: true }).click();
    await expect(page.getByRole("switch", { name: "Desktop notifications", exact: true })).toBeDisabled();
    await expect(page.locator("#desktop-status")).toContainText("disabled for custom development APIs");
    expect(canvas.deliveries).toEqual([]);
    expect((await canvas.preferences.read()).desktopNotifications).toBe(true);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("packaged API boundary", () => {
  test.use({ packaged: true, developmentApiBaseUrl: baseUrl });

  test("ignores saved development APIs and rejects the source-only settings endpoint", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(50);
    await page.getByLabel("Settings", { exact: true }).click();
    await expect(page.locator("#development-settings")).toBeHidden();
    await expect(page.locator("#development-api-notice")).toBeHidden();
    expect(canvas.requests.every(endpoint => new URL(endpoint, "https://api.github.com").origin === "https://api.github.com")).toBe(true);
    const url = new URL(canvas.url);
    const response = await page.request.post(new URL("/api/development", url).href, {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin },
      data: { baseUrl },
    });
    expect(response.status()).toBe(404);
    expect(await canvas.preferences.readDevelopmentAPI()).toBe(baseUrl);
    expect(canvas.writes).toEqual([]);
  });
});
