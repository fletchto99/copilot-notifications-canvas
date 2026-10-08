import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`Copilot triage (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("consents to only shown rows, renders safe recommendations and preserves manual actions", async ({ page, canvas }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      await page.getByRole("searchbox").fill("Needle");
      await expect(page.locator(".row")).toHaveCount(3);
      const button = page.getByRole("button", { name: "Triage shown notifications with Copilot", exact: true });
      await button.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("region", { name: "Copilot triage", exact: true });
      await expect(panel).toBeFocused();
      await expect(panel).toContainText("3 shown, loaded notifications");
      await expect(panel).toContainText("separate Copilot session");
      expect(canvas.writes).toEqual([]);
      await page.getByRole("button", { name: "Allow and triage shown notifications", exact: true }).click();
      await expect(page.locator("#triage-status")).toContainText("Copilot triaged 3 notifications", { timeout: 10_000 });
      await expect(page.locator(".triage-recommendation")).toHaveCount(3);
      await expect(page.locator(".triage-recommendation").first()).toContainText("<img src=x onerror=alert(1)>");
      await expect(page.locator(".triage-recommendation img")).toHaveCount(0);
      await expect(page.locator(".row")).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      await page.getByRole("searchbox").fill("Needle widget");
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#triage-status")).toContainText("Shown notifications changed");
      await expect(page.locator(".triage-recommendation")).toHaveCount(0);
      await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(button).toBeFocused();
      expect(canvas.writes).toEqual([]);
    });

    test("remembers the warning across reloads, starts directly and can reset from Settings", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      const starts = [];
      page.on("request", request => {
        if (request.url().endsWith("/api/triage/start")) starts.push(request.postDataJSON());
      });
      const copilot = page.getByRole("button", { name: "Triage shown notifications with Copilot", exact: true });
      const panel = page.getByRole("region", { name: "Copilot triage", exact: true });
      await copilot.click();
      await expect(page.locator("#triage-disclosure")).toBeVisible();
      await expect(page.locator("#triage-disclosure")).toContainText("remembered across sessions");
      await page.getByRole("button", { name: "Allow and triage shown notifications", exact: true }).click();
      await expect(page.locator("#triage-status")).toContainText("Copilot triaged 1");
      expect((await canvas.preferences.read()).triageConsentVersion).toBe(1);
      await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.reload();
      await expect(page.locator(".row")).toHaveCount(1);
      await copilot.click();
      await expect(page.locator("#triage-status")).toContainText("Copilot triaged 1");
      await expect(page.locator("#triage-disclosure")).toBeHidden();
      await expect(page.locator("#triage-start")).toBeHidden();
      expect(starts).toHaveLength(2);
      expect(starts[0].consent).toBe(true);
      expect(starts[1]).not.toHaveProperty("consent");
      await copilot.click();
      await expect.poll(() => starts.length).toBe(3);
      await expect(page.locator("#triage-status")).toContainText("Copilot triaged 1");
      await expect(page.locator("#triage-disclosure")).toBeHidden();
      await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.locator("#settings-toggle").click();
      await page.locator("#triage-privacy summary").click();
      await expect(page.locator("#triage-privacy-text")).toContainText("Content is sent to Copilot");
      await page.getByRole("button", { name: "Show warning next time", exact: true }).click();
      await expect(page.locator("#triage-consent-status")).toContainText("before the next run");
      expect((await canvas.preferences.read()).triageConsentVersion).toBe(0);
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await page.keyboard.press("Escape");
      await copilot.click();
      await expect(page.locator("#triage-disclosure")).toBeVisible();
      expect(starts).toHaveLength(3);
      expect(canvas.writes).toEqual([]);
    });
  });
}

test("a running session can be cancelled while retaining the inbox", async ({ page, canvas }) => {
  canvas.setTriageHook(({ signal }) => new Promise((resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByRole("button", { name: "Triage shown notifications with Copilot", exact: true }).click();
  await page.getByRole("button", { name: "Allow and triage shown notifications", exact: true }).click();
  await expect(page.locator("#triage-status")).toContainText("Copilot is triaging 50");
  await page.getByRole("button", { name: "Cancel triage", exact: true }).click();
  await expect(page.locator("#triage-status")).toContainText("was cancelled");
  await expect(page.locator(".row")).toHaveCount(50);
  expect(canvas.writes).toEqual([]);
});
