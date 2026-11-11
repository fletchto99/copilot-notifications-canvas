import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`read-state filtering (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("Settings starts with Group By and no longer offers a competing notification view", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      const settings = page.getByLabel("Settings", { exact: true });
      const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
      for (const width of [320, 960]) {
        await page.setViewportSize({ width, height: 640 });
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await page.getByRole("searchbox").focus();
          await page.keyboard.press("Shift+Tab");
          await expect(settings).toBeFocused();
          await Promise.all([
            page.evaluate(() => new Promise(resolve => {
              document.getElementById("settings").addEventListener("toggle", () => resolve(), { once: true });
            })),
            page.keyboard.press("Enter"),
          ]);
          await expect(grouping).toBeEnabled();
          await expect(page.locator("#show-notifications, #inbox-mode")).toHaveCount(0);
          await page.keyboard.press("Tab");
          await expect(grouping).toBeFocused();
          await grouping.press("Tab");
          await expect(page.getByRole("switch", { name: "Copilot integration", exact: true })).toBeFocused();
          await page.mouse.move(0, 0);
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          await page.keyboard.press("Escape");
          await expect(settings).toBeFocused();
        }
      }
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("legacy unread preferences initialize shared filters without limiting the fetched inbox", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[1].unread = false;
      canvas.rows[2].unread = false;
      canvas.rows[2].done = true;
      await canvas.preferences.update({ matchGitHubInbox: false });
      const saved = await canvas.preferences.read();
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#filter-readState")).toHaveValue("unread");
      await expect(page.locator("#filters-toggle")).toHaveText("Filters (1)");
      await expect(page.locator("#count")).toHaveText("2 loaded · 1 unread · 1 matching");
      await page.locator("#filters-toggle").click();
      const readState = page.getByLabel("Read state", { exact: true });
      await readState.selectOption("read");
      await expect(page.locator('[data-focus-key="thread:2"]')).toBeVisible();
      await expect(page.locator(".row")).toHaveCount(1);
      await readState.selectOption("all");
      await expect(page.locator(".row")).toHaveCount(2);
      await page.keyboard.press("Escape");
      await page.locator("#force-refresh").click();
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(readState).toHaveValue("all");
      await expect(page.locator('[data-focus-key="thread:3"]')).toHaveCount(0);
      const settings = await canvas.preferences.read();
      expect(settings.matchGitHubInbox).toBe(false);
      expect(settings.filterDefaults.readState).toBe("all");
      expect(settings.revision).toBeGreaterThan(saved.revision);
      const queries = canvas.requests.filter(path => path.startsWith("/notifications?"))
        .map(path => new URL(path, "https://api.github.com").searchParams);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every(query => query.get("all") === "true" && query.get("is_done") === "false")).toBe(true);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("Read and Done keep their GitHub semantics while read-state filters only change visibility", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[1].unread = false;
      canvas.rows[2].unread = false;
      canvas.rows[2].done = true;
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await page.locator("#filters-toggle").click();
      await page.getByLabel("Read state", { exact: true }).selectOption("unread");
      await expect(page.locator(".row")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await page.locator('[data-focus-key="read:1"]').click();
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(page.locator("#empty-title")).toHaveText("No matches in loaded notifications");
      await expect(page.locator("#count")).toHaveText("2 loaded · 0 unread · 0 matching");
      await page.locator("#filters-toggle").click();
      await page.getByLabel("Read state", { exact: true }).selectOption("read");
      await expect(page.locator(".row")).toHaveCount(2);
      await page.keyboard.press("Escape");
      await expect(page.locator(".mark-read:disabled")).toHaveCount(2);
      await page.locator('[data-focus-key="done:2"]').click();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator('[data-focus-key="thread:1"]')).toBeVisible();
      await expect(page.locator('[data-focus-key="thread:3"]')).toHaveCount(0);
      expect(canvas.writes).toEqual(["1", "2"]);
      expect(canvas.doneWrites).toEqual(["2"]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("read-state changes preserve loaded pages and reveal older unread matches only after Load more", async ({ page, canvas }) => {
      for (const [index, row] of canvas.rows.entries()) row.unread = index === 0 || index >= 50;
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      const notificationRequests = () => canvas.requests.filter(path => path.startsWith("/notifications?"));
      const before = notificationRequests().length;
      await page.locator("#filters-toggle").click();
      await page.getByLabel("Read state", { exact: true }).selectOption("unread");
      await expect(page.locator(".row")).toHaveCount(1);
      expect(notificationRequests().length).toBe(before);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(4);
      await expect(page.locator("#count")).toHaveText("53 loaded · 4 unread · 4 matching");
      await page.locator("#filters-toggle").click();
      await page.getByLabel("Read state", { exact: true }).selectOption("all");
      await expect(page.locator(".row")).toHaveCount(53);
      expect(notificationRequests().length).toBe(before + 1);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });
  });
}
