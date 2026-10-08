import { test as base, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startPreview } from "../../scripts/dev-fixture.mjs";

const test = base.extend({
  scenario: ["populated", { option: true }],
  preview: async ({ page, context, scenario }, use) => {
    const logs = [];
    const preview = await startPreview({ scenario, log: message => logs.push(message) });
    const origin = new URL(preview.url).origin;
    const external = [];
    try {
      await context.route("**/*", async route => {
        const url = route.request().url();
        if (url === preview.launcher || new URL(url).origin === origin) return route.continue();
        external.push(url);
        await route.abort("blockedbyclient");
      });
      page.on("pageerror", error => logs.push(error.message));
      await use(preview);
      await expect(page.locator("#development-build")).toContainText(`synthetic preview (${scenario})`);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(result.violations).toEqual([]);
      expect(external).toEqual([]);
      expect(logs).toEqual([]);
      expect(preview.deliveries).toEqual([]);
    } finally {
      try {
        await context.unrouteAll({ behavior: "wait" });
        await page.close();
      } finally {
        await preview.close();
      }
    }
  },
});

test("the private preview launcher opens an accessible synthetic inbox with working local controls", async ({ page, preview }) => {
  await page.goto(preview.launcher);
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(page.getByRole("tab", { name: /^Mentioned \([1-9]\d*\)$/ })).toBeVisible();
  await page.getByRole("button", { name: "Mark as read: Needle widget 2", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(49);
  expect(preview.writes).toEqual(["2"]);
  await page.getByRole("button", { name: "Mark as done: Needle tool", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(48);
  expect(preview.writes).toEqual(["2", "3"]);
  expect(preview.doneWrites).toEqual(["3"]);
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await page.keyboard.press("Escape");
});

test.describe("empty preview", () => {
  test.use({ scenario: "empty" });

  test("shows a successful caught-up state instead of an unavailable inbox", async ({ page, preview }) => {
    await page.goto(preview.launcher);
    await expect(page.locator("#empty-title")).toContainText("All caught up");
    await expect(page.locator(".row")).toHaveCount(0);
    await expect(page.locator("#notice")).toBeHidden();
    await expect(page.getByRole("tab", { name: "All (0)", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more (up to 50)", exact: true })).toBeHidden();
    expect(preview.writes).toEqual([]);
  });
});

test.describe("long-title preview", () => {
  test.use({ scenario: "long-titles" });

  test("keeps long and unbroken text inside narrow light and dark panels", async ({ page, preview }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(preview.launcher);
    await expect(page.locator(".row")).toHaveCount(50);
    await expect(page.getByRole("link", { name: preview.rows[0].subject.title, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: preview.rows[1].subject.title, exact: true })).toBeVisible();
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-notification-theme", colorScheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    }
    expect(preview.writes).toEqual([]);
  });
});

test.describe("rate-limited preview", () => {
  test.use({ scenario: "rate-limited" });

  test("shows real rate-limit handling and prevents forced requests during backoff", async ({ page, preview }) => {
    await page.goto(preview.launcher);
    await expect(page.locator("#notice")).toContainText("GitHub rate limit reached");
    await expect(page.locator("#empty-title")).toHaveText("Your inbox is unavailable");
    await expect(page.locator(".row")).toHaveCount(0);
    const reads = () => preview.requests.filter(path => path.startsWith("/notifications?")).length;
    expect(reads()).toBe(1);
    const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
    await expect(refresh).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#retry-status")).toHaveText(/^GitHub requests paused\. Retry after .+\.$/);
    await refresh.focus();
    await refresh.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(reads()).toBe(1);
    expect(preview.writes).toEqual([]);
  });
});

test.describe("stale preview", () => {
  test.use({ scenario: "stale" });

  test("keeps loaded rows searchable after a failed forced refresh", async ({ page, preview }) => {
    await page.goto(preview.launcher);
    await expect(page.locator(".row")).toHaveCount(50);
    const initial = await page.locator(".row .title").allTextContents();
    await page.getByRole("button", { name: "Force refresh", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("Showing previously loaded notifications.");
    await expect(page.locator("#notice")).toContainText("HTTP 503");
    await expect(page.locator(".row")).toHaveCount(50);
    expect(await page.locator(".row .title").allTextContents()).toEqual(initial);
    await page.getByRole("searchbox").fill("Needle");
    await expect(page.locator(".row")).toHaveCount(3);
    expect(preview.requests.filter(path => path.startsWith("/notifications?"))).toHaveLength(2);
    expect(preview.writes).toEqual([]);
  });
});
