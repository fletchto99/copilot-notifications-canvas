/* global document */
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvasFixture } from "../test/canvas-fixtures.mjs";
import {
  readmeContext, readmePreferences, readmeRepositories, readmeRows, readmeSubjectLabels, readmeTime,
} from "../test/readme-fixture.mjs";

export const readmeImage = fileURLToPath(new URL("../docs/images/github-notifications.png", import.meta.url));
export const screenshotUsage = `Usage: npm run screenshot:readme -- [--output=<image.png>]
       npm run screenshot:readme -- --help

Defaults to docs/images/github-notifications.png. Uses only synthetic data.
Requires locked development dependencies and Playwright Chromium.
Pixel reproducibility requires the same browser, OS and installed fonts.
See docs/development.md#readme-screenshot.
`;

export function parseScreenshotArgs(args) {
  if (args.length === 0) return { output: readmeImage };
  if (args.length === 1 && args[0] === "--help") return { help: true };
  let output;
  if (args.length === 1 && args[0].startsWith("--output=")) output = args[0].slice("--output=".length);
  else if (args.length === 2 && args[0] === "--output") output = args[1];
  if (!output || extname(output).toLowerCase() !== ".png") throw new Error(screenshotUsage);
  return { output: resolve(output) };
}

export async function renderReadmeScreenshot(browser, expect, { create = createCanvasFixture } = {}) {
  const canvas = await create({ development: false, now: () => readmeTime, copilotEnabled: true });
  let context;
  try {
    const rows = readmeRows();
    canvas.rows.splice(0, canvas.rows.length, ...rows);
    await canvas.preferences.update(readmePreferences);
    context = await browser.newContext(readmeContext);
    const failures = [];
    const origin = new URL(canvas.url).origin;
    await context.route("**/*", async route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      failures.push("External browser request blocked.");
      await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", () => failures.push("Renderer error."));
    page.on("console", message => {
      if (message.type() === "error") failures.push("Browser console error.");
    });
    await page.clock.setFixedTime(new Date(readmeTime));
    await page.goto(canvas.url);
    await expect(page.locator(".row .title")).toHaveText(rows.map(row => row.subject.title));
    await expect(page.locator(".row.unread")).toHaveCount(7);
    await expect(page.locator(".repo-name")).toHaveText(readmeRepositories);
    await expect.poll(() => page.locator(".subject-icon").evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("aria-label").split(".")[0])),
    { timeout: 15_000 }).toEqual(readmeSubjectLabels);
    await expect(page.locator(".subject-loading")).toHaveCount(0);
    await expect(page.locator("#attention-mine")).toHaveText("Mine (4)");
    await expect(page.locator(".notification-mine:visible")).toHaveCount(4);
    await expect(page.locator('.row-link[aria-disabled="true"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "PR merged: #237" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "PR in merge queue: #248" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Continue with Copilot: #86" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Investigate CI failures with Copilot:/ })).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
    await expect(page.locator("#settings-toggle")).toHaveAttribute("aria-expanded", "false");
    for (const id of ["settings-panel", "notice", "settings-error", "update-banner", "development-build", "empty", "more"]) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(readmeContext.viewport.width);
    const image = await page.screenshot({ type: "png", fullPage: true, animations: "disabled", caret: "hide", scale: "device" });
    expect([...failures, ...canvas.errors, ...canvas.warnings], "No renderer, provider or external-network failures").toEqual([]);
    expect(canvas.writes, "Screenshot capture never changes read/done state").toEqual([]);
    expect(canvas.deliveries, "Screenshot capture never sends alerts").toEqual([]);
    return image;
  } finally {
    try {
      await context?.close();
    } finally {
      await canvas.close();
    }
  }
}

export async function generateReadmeScreenshot({
  output = readmeImage, load = () => import("@playwright/test"), render = renderReadmeScreenshot, write = writeFile,
} = {}) {
  const { chromium, expect } = await load();
  const browser = await chromium.launch({ headless: true });
  let image;
  let version;
  try {
    version = browser.version();
    image = await render(browser, expect);
  } finally {
    await browser.close();
  }
  // Do not replace the checked-in image until capture, assertions and cleanup succeed.
  await write(output, image);
  return { output, version };
}

export async function runScreenshot(args, {
  generate = generateReadmeScreenshot, out = text => process.stdout.write(text), error = text => process.stderr.write(text),
} = {}) {
  let options;
  try {
    options = parseScreenshotArgs(args);
  } catch {
    error(screenshotUsage);
    return 1;
  }
  if (options.help) {
    out(screenshotUsage);
    return 0;
  }
  try {
    const result = await generate(options);
    out(`Saved synthetic README screenshot: ${result.output}\nChromium ${result.version}; ${process.platform}/${process.arch}. Settings closed.\n`);
    return 0;
  } catch (failure) {
    error(`README screenshot failed (${failure.code ?? failure.name}). No successful capture was saved.\nCheck dependencies (npm ci --ignore-scripts --engine-strict), Chromium (npx playwright install chromium), and output permissions.\nFor renderer failures, run npm run test:browser -- readme-screenshot --project=chromium.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runScreenshot(process.argv.slice(2));
}
