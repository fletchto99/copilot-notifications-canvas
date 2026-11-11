import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

const baseUrl = "https://git.example.com/api/v3";

test.describe("development API selection", () => {
  test.use({ developmentApiBaseUrl: "https://api.github.com" });

  test("Development text is vertically centered like neighboring Settings controls", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.goto(canvas.url);
    await page.locator("#settings-toggle").click();
    await expect(page.locator("#development-toggle")).toBeVisible();
    for (const [width, fontSize, lineHeight] of [[480, 14, 20], [320, 16, 24]]) {
      await page.setViewportSize({ width, height: 900 });
      const style = await page.addStyleTag({ content: `
        :root { --text-body-medium: ${fontSize}px; --leading-body-medium: ${lineHeight}px; }
      ` });
      for (const open of [false, true]) {
        await page.locator("#development-settings").evaluate((node, open) => { node.open = open; }, open);
        const offsets = await page.evaluate(() => ["development-toggle", "check-updates"].map(id => {
          const node = document.getElementById(id);
          const box = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          const text = range.getBoundingClientRect();
          return text.y + text.height / 2 - (box.y + box.height / 2);
        }));
        expect(Math.abs(offsets[0] - offsets[1])).toBeLessThanOrEqual(0.5);
      }
      await style.evaluate(node => node.remove());
    }
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
  });

  test("Development starts collapsed and preserves draft API input across toggles and polls", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    const saved = await canvas.preferences.read();
    let settingsReads = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/settings") settingsReads++;
    });
    await page.goto(canvas.url);
    await page.locator("#settings-toggle").click();
    await expect(page.locator("#theme")).toBeEnabled();
    const development = page.locator("#development-settings");
    const toggle = page.locator("#development-toggle");
    const api = page.getByLabel("Development API", { exact: true });
    await expect(toggle).toHaveText("Development");
    await expect(development).not.toHaveAttribute("open");
    await expect(api).toBeHidden();
    await toggle.focus();
    await toggle.press("Tab");
    await expect(page.locator("#check-updates")).toBeFocused();
    await toggle.focus();
    await toggle.press("Enter");
    await expect(api).toBeVisible();
    await toggle.press("Tab");
    await expect(api).toBeFocused();
    await api.selectOption("custom");
    const url = page.getByLabel("REST API base URL");
    await url.fill(baseUrl);
    await toggle.focus();
    await toggle.press("Space");
    await expect(url).toBeHidden();
    const beforePoll = settingsReads;
    await expect.poll(() => settingsReads, { timeout: 10_000 }).toBeGreaterThan(beforePoll);
    await expect(development).not.toHaveAttribute("open");
    await expect(toggle).toBeFocused();
    await toggle.press("Enter");
    await expect(api).toHaveValue("custom");
    await expect(url).toHaveValue(baseUrl);
    expect(await canvas.preferences.read()).toEqual(saved);
    expect(await canvas.preferences.readDevelopmentAPI()).toBe("https://api.github.com");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.reload();
    await page.locator("#settings-toggle").click();
    await expect(toggle).toBeVisible();
    await expect(development).not.toHaveAttribute("open");
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
  });

  test("development Settings uses available height before scrolling", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 480, height: 2000 });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(1);
    await page.locator("#settings-toggle").click();
    await expect(page.locator("#development-settings")).toBeVisible();
    await expect(page.locator("#theme")).toBeEnabled();
    await page.locator("#development-toggle").click();
    await expect(page.getByLabel("Development API", { exact: true })).toBeVisible();
    const panel = page.locator("#settings-panel");
    const overflow = () => panel.evaluate(node => node.scrollHeight > node.clientHeight);
    await expect.poll(overflow).toBe(false);
    const naturalHeight = (await panel.boundingBox()).height;
    const toggle = await page.locator("#settings-toggle").boundingBox();
    const height = Math.ceil(toggle.y + toggle.height + naturalHeight + 24);
    await page.setViewportSize({ width: 480, height });
    await expect.poll(overflow).toBe(false);
    const expanded = await panel.boundingBox();
    expect(expanded.height).toBeGreaterThan(height * 0.6);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(height - 8);
    await page.setViewportSize({ width: 480, height: 320 });
    await expect.poll(overflow).toBe(true);
    await expect(panel).toHaveCSS("overflow-y", "auto");
    const updates = page.locator("#check-updates");
    await updates.focus();
    await expect(updates).toBeFocused();
    const control = await updates.boundingBox();
    expect(control.y).toBeGreaterThanOrEqual(8);
    expect(control.y + control.height).toBeLessThanOrEqual(312);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
  });

  for (const [name, platform, userAgentData, shortcut] of [
    ["Windows", "Win32", undefined, "Ctrl+K"],
    ["Linux", "Linux x86_64", undefined, "Ctrl+K"],
    ["macOS", "MacIntel", undefined, "\u2318+K"],
    ["Windows client hints", "MacIntel", { platform: "Windows" }, "Ctrl+K"],
    ["macOS client hints", "Win32", { platform: "macOS" }, "\u2318+K"],
  ]) {
    test(`shows the renderer's command-palette shortcut on ${name}`, async ({ page, canvas }) => {
      await page.addInitScript(({ platform, userAgentData }) => {
        Object.defineProperty(navigator, "platform", { value: platform });
        Object.defineProperty(navigator, "userAgentData", { value: userAgentData });
      }, { platform, userAgentData });
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(canvas.url);
      await page.getByLabel("Settings", { exact: true }).click();
      await page.locator("#development-toggle").click();
      await expect(page.locator("#development-api-help")).toHaveText(
        `Source builds only. Reload extension after saving with ${shortcut} -> refresh canvas.`,
      );
      await expect(page.getByLabel("Development API", { exact: true })).toHaveAccessibleDescription(
        new RegExp(shortcut.replace("+", "\\+")),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });
  }

  test("saves a custom API accessibly without switching the current panel", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(1);
    await page.getByLabel("Settings", { exact: true }).click();
    await page.locator("#development-toggle").click();
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

for (const customBaseUrl of [baseUrl, "https://git.example.com:8443/api/v3"]) {
  test.describe(`custom API panels (${new URL(customBaseUrl).port || "default port"})`, () => {
    test.use({ developmentApiBaseUrl: customBaseUrl, desktopEnabled: true });
    const inboxUrl = `${new URL(customBaseUrl).origin}/notifications`;

    test("loads and paginates only the custom API with host-specific links and no desktop alerts", async ({ page, canvas }) => {
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      await expect(page.locator("#development-api-notice")).toContainText("may share production data");
      await expect(page.getByRole("link", { name: "Open GitHub inbox", exact: true })).toHaveAttribute("href", inboxUrl);
      await expect(page.locator(".row a").first()).toHaveAttribute("href", inboxUrl);
      await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(53);
      expect(canvas.requests.every(endpoint => endpoint.startsWith(customBaseUrl + "/notifications"))).toBe(true);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByRole("switch", { name: "Desktop notifications", exact: true })).toBeDisabled();
      await expect(page.locator("#desktop-status")).toContainText("disabled for custom development APIs");
      expect(canvas.deliveries).toEqual([]);
      expect((await canvas.preferences.read()).desktopNotifications).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
    });

    test("initial links and warnings use settings while the first notification refresh is pending", async ({ page, canvas }) => {
      let finishSettings;
      let finishRefresh;
      const settingsReady = new Promise(resolve => { finishSettings = resolve; });
      const refreshReady = new Promise(resolve => { finishRefresh = resolve; });
      await page.route("**/api/settings", async route => {
        await settingsReady;
        await route.continue();
      });
      canvas.setRequestHook(async () => { await refreshReady; });
      try {
        await page.goto(canvas.url);
        const link = page.getByRole("link", { name: "Open GitHub inbox", exact: true });
        await expect(link).toHaveAttribute("aria-disabled", "true");
        await expect(link).not.toHaveAttribute("href", /.+/);
        await expect(page.locator("#development-api-notice")).toBeHidden();
        finishSettings();
        await expect(link).toHaveAttribute("href", inboxUrl);
        await expect(link).toHaveAttribute("aria-disabled", "false");
        await expect(page.locator("#development-api-notice")).toContainText(customBaseUrl);
        await expect(page.locator(".row")).toHaveCount(0);
        finishRefresh();
        await expect(page.locator(".row")).toHaveCount(50);
        expect(canvas.writes).toEqual([]);
      } finally {
        finishSettings();
        finishRefresh();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  });
}

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
