import { test as base, expect } from "@playwright/test";
import { createCanvasFixture } from "../canvas-fixtures.mjs";

export { expect };

export const test = base.extend({
  assetFailure: [false, { option: true }],
  desktopEnabled: [false, { option: true }],
  packaged: [false, { option: true }],
  development: [undefined, { option: true }],
  canvas: async ({ page, context, assetFailure, desktopEnabled, packaged, development }, use) => {
    const canvas = await createCanvasFixture({ assetFailure, desktopEnabled, packaged, development });
    const { errors, warnings } = canvas;
    const consoleErrors = [];
    const expectedConsoleErrors = [];
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
      });
      expect(errors, "Browser execution, CSP, and external-network errors").toEqual([]);
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
