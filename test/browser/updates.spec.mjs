import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { CURRENT_VERSION } from "../../src/updates.mjs";

async function prepareUpdate(page, canvas) {
  canvas.rows.splice(2);
  const updates = {
    status: "available", currentVersion: CURRENT_VERSION, latestVersion: "99.0.0",
    prompt: "Synthetic update prompt. Do not install anything.",
    releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v99.0.0",
    error: null,
  };
  await page.route(/\/api\/(?:state|refresh|updates)$/, async route => {
    const response = await route.fetch();
    const state = await response.json();
    if (route.request().url().endsWith("/api/updates")) Object.assign(state, updates);
    else Object.assign(state.updates, updates);
    await route.fulfill({ response, json: state });
  });
  await page.addInitScript(() => {
    window.copiedUpdatePrompts = [];
    window.denyUpdateClipboard = false;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async text => {
        if (window.denyUpdateClipboard) throw new DOMException("Synthetic clipboard denial.", "NotAllowedError");
        window.copiedUpdatePrompts.push(text);
      } },
    });
  });
  return updates;
}

for (const packaged of [false, true]) {
  test.describe(`update notice (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const width of [320, 480, 960]) {
      for (const theme of ["light", "dark"]) {
        test(`details stay anchored and accessible at ${width}px in ${theme} mode`, async ({ page, canvas }) => {
          await prepareUpdate(page, canvas);
          await canvas.preferences.update({ darkMode: theme === "dark" });
          await page.setViewportSize({ width, height: 900 });
          await page.goto(canvas.url);
          const banner = page.getByRole("region", { name: "Canvas update" });
          const toggle = page.getByRole("button", { name: "Update details", exact: true });
          const details = page.locator("#update-prompt-details");
          await expect(banner).toBeVisible();
          await expect(details).toBeHidden();
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(page.locator("#update-current-version")).toHaveText(`Currently v${CURRENT_VERSION}`);
          await toggle.focus();
          const before = await toggle.boundingBox();
          await toggle.press("Enter");
          await expect(details).toBeVisible();
          await expect(toggle).toBeFocused();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          const after = await toggle.boundingBox();
          expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
          await expect(page.getByRole("link", { name: "Read the update instructions" })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          const expanded = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(expanded.violations).toEqual([]);
          await toggle.press("Space");
          await expect(details).toBeHidden();
          await expect(toggle).toBeFocused();
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          const closed = await toggle.boundingBox();
          expect({ x: closed.x, y: closed.y }).toEqual({ x: before.x, y: before.y });
          const collapsed = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(collapsed.violations).toEqual([]);
          if (width === 960) expect((await banner.boundingBox()).height).toBeLessThanOrEqual(110);
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        });
      }
    }

    test("copy feedback stays inline and restores the button label without losing instructions", async ({ page, canvas }) => {
      const updates = await prepareUpdate(page, canvas);
      const preferences = await canvas.preferences.read();
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.goto(canvas.url);
      const banner = page.locator("#update-banner");
      const copy = page.getByRole("button", { name: "Copy update prompt", exact: true });
      await expect(banner).toBeVisible();
      const before = await banner.boundingBox();
      await copy.click();
      await expect(page.locator("#copy-update")).toHaveText("Copied");
      await expect(page.locator("#copy-status")).toHaveText("Paste into Copilot to review and run.");
      expect((await banner.boundingBox()).height).toBe(before.height);
      expect(await page.evaluate(() => window.copiedUpdatePrompts)).toEqual([updates.prompt]);
      await page.clock.runFor(3999);
      await expect(page.locator("#copy-update")).toHaveText("Copied");
      await page.clock.runFor(1);
      await expect(copy).toBeVisible();
      await expect(page.locator("#copy-status")).toHaveText("Paste into Copilot to review and run.");
      await expect(page.locator("#update-prompt-details")).toBeHidden();
      expect(await canvas.preferences.read()).toEqual(preferences);
      expect(canvas.writes).toEqual([]);
    });

    test("clipboard denial expands the prompt, selects it, and allows a successful retry", async ({ page, canvas }) => {
      const updates = await prepareUpdate(page, canvas);
      await page.goto(canvas.url);
      await expect(page.locator("#update-banner")).toBeVisible();
      await page.evaluate(() => { window.denyUpdateClipboard = true; });
      await page.getByRole("button", { name: "Copy update prompt", exact: true }).click();
      const prompt = page.getByRole("textbox", { name: "Update prompt", exact: true });
      const toggle = page.getByRole("button", { name: "Update details", exact: true });
      await expect(prompt).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#copy-status")).toContainText("Clipboard unavailable.");
      expect(await prompt.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([0, updates.prompt.length]);
      expect(await page.evaluate(() => window.copiedUpdatePrompts)).toEqual([]);
      await toggle.click();
      await expect(prompt).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await page.evaluate(() => { window.denyUpdateClipboard = false; });
      await page.getByRole("button", { name: "Copy update prompt", exact: true }).click();
      await expect(page.locator("#copy-update")).toHaveText("Copied");
      await expect(page.locator("#copy-status")).not.toContainText("Clipboard unavailable.");
      expect(await page.evaluate(() => window.copiedUpdatePrompts)).toEqual([updates.prompt]);
      expect(canvas.writes).toEqual([]);
    });

    for (const newerFails of [false, true]) {
      test(`an older clipboard result cannot overwrite a newer ${newerFails ? "failure" : "success"} or steal focus`, async ({ page, canvas }) => {
        await prepareUpdate(page, canvas);
        await page.goto(canvas.url);
        await expect(page.locator("#update-banner")).toBeVisible();
        await page.evaluate(() => {
          window.updateCopyAttempts = [];
          navigator.clipboard.writeText = () => new Promise((resolve, reject) => {
            window.updateCopyAttempts.push(fails => fails
              ? reject(new DOMException("Synthetic clipboard denial.", "NotAllowedError")) : resolve());
          });
        });
        const copy = page.locator("#copy-update");
        const details = page.locator("#update-prompt-details");
        const search = page.getByRole("searchbox");
        await copy.click();
        await copy.click();
        expect(await page.evaluate(() => window.updateCopyAttempts.length)).toBe(2);
        await page.evaluate(fails => window.updateCopyAttempts[1](fails), newerFails);
        const expectedStatus = newerFails
          ? "Clipboard unavailable. Copy the selected prompt and paste it into Copilot."
          : "Paste into Copilot to review and run.";
        await expect(page.locator("#copy-status")).toHaveText(expectedStatus);
        await search.focus();
        await page.evaluate(fails => window.updateCopyAttempts[0](!fails), newerFails);
        await expect(page.locator("#copy-status")).toHaveText(expectedStatus);
        await expect(copy).toHaveText(newerFails ? "Copy update prompt" : "Copied");
        await expect(search).toBeFocused();
        if (newerFails) await expect(details).toBeVisible();
        else await expect(details).toBeHidden();
        expect(canvas.writes).toEqual([]);
      });
    }

    test("a failed release check keeps its last-known update warning visible until recovery", async ({ page, canvas }) => {
      const updates = await prepareUpdate(page, canvas);
      updates.error = "Synthetic release check failure.";
      await page.goto(canvas.url);
      await expect(page.locator("#update-stale")).toHaveText("Last known release; the latest check failed.");
      await expect(page.locator("#update-stale")).toBeVisible();
      await expect(page.locator("#update-title")).toHaveText("Update available \u00b7 v99.0.0");
      await expect(page.getByRole("button", { name: "Copy update prompt", exact: true })).toBeEnabled();
      updates.error = null;
      await page.getByRole("button", { name: "Force refresh", exact: true }).click();
      await expect(page.locator("#update-stale")).toBeHidden();
      await expect(page.locator("#update-banner")).toBeVisible();
      expect(canvas.writes).toEqual([]);
    });
  });
}
