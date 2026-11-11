import { test as base, expect } from "@playwright/test";
import { createCanvasFixture } from "../canvas-fixtures.mjs";

export { expect };

export async function openSettings(page) {
  const settings = page.locator("#settings-toggle");
  await settings.click();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#theme")).toBeEnabled();
}

export const test = base.extend({
  assetFailure: [false, { option: true }],
  desktopEnabled: [false, { option: true }],
  packaged: [false, { option: true }],
  development: [undefined, { option: true }],
  developmentApiBaseUrl: [undefined, { option: true }],
  copilotEnabled: [false, { option: true }],
  canvas: async ({ page, context, assetFailure, desktopEnabled, packaged, development, developmentApiBaseUrl, copilotEnabled }, use) => {
    const canvas = await createCanvasFixture({ assetFailure, desktopEnabled, packaged, development, developmentApiBaseUrl, copilotEnabled });
    const { errors, warnings } = canvas;
    const consoleErrors = [];
    const expectedConsoleErrors = [];
    const expectedProviderErrors = [];
    try {
      const origin = new URL(canvas.url).origin;
      await context.route("**/*", async route => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        errors.push(`Unexpected external browser request: ${url}`);
        await route.abort("blockedbyclient");
      });
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url });
      });
      await use({
        ...canvas,
        expectConsoleError: (path, text) => expectedConsoleErrors.push({ text, url: new URL(path, origin).href }),
        expectProviderError: message => expectedProviderErrors.push(message),
      });
      expect(errors, "Exact expected provider errors; no browser, CSP or external-network errors").toEqual(expectedProviderErrors);
      expect(consoleErrors, "Exact expected browser console errors").toEqual(expectedConsoleErrors);
      expect(warnings).toEqual(assetFailure
        ? ["Could not load the notifications canvas assets (ENOENT). Retrying in the background."] : []);
    } finally {
      try {
        await context.unrouteAll({ behavior: "wait" });
        await page.close();
      } finally {
        await canvas.close();
      }
    }
  },
});
