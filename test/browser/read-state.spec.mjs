import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`read-state polish (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    for (const groupBy of ["repo", "none", "date"]) {
      test(`${groupBy} hides zero-unread bulk actions without moving Done and keeps read titles accessible`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        canvas.rows[1].unread = false;
        await canvas.preferences.update({ groupBy });
        await page.setViewportSize({ width: 480, height: 900 });
        await page.goto(canvas.url);
        const read = page.locator(".repo-read");
        const done = page.locator(".repo-done");
        await expect(page.locator(".repo-count")).toHaveText("2 loaded \u00b7 1 unread");
        await expect(read).toBeVisible();
        await expect(read).toHaveAccessibleDescription("Mark 1 as read");
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await expect(page.locator("html")).toHaveAttribute("data-notification-theme", colorScheme);
          const colors = await page.evaluate(() => {
            const context = document.createElement("canvas").getContext("2d");
            const rgb = selector => {
              context.fillStyle = getComputedStyle(document.querySelector(selector)).color;
              context.fillRect(0, 0, 1, 1);
              return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            return { read: rgb(".row.read .title"), unread: rgb(".row.unread .title"), metadata: rgb(".metadata") };
          });
          expect(colors.read).not.toEqual(colors.metadata);
          expect(colors.read).not.toEqual(colors.unread);
          for (let channel = 0; channel < 3; channel++) {
            expect(Math.abs(colors.read[channel] - (colors.unread[channel] + colors.metadata[channel]) / 2))
              .toBeLessThanOrEqual(1);
          }
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        }
        await expect(done).toHaveAccessibleDescription("Mark 2 as done");
        const before = await done.boundingBox();
        const previousRead = await read.boundingBox();
        await page.locator('[data-focus-key="read:1"]').click();
        await expect(page.locator(".repo-count")).toHaveText("2 loaded \u00b7 0 unread");
        await expect(read).toBeHidden();
        await expect(page.getByRole("button", { name: /^Mark 0 as read/ })).toHaveCount(0);
        await expect(done).toBeVisible();
        await expect(done).toBeEnabled();
        const after = await done.boundingBox();
        expect(after.x).toBeCloseTo(before.x, 1);
        expect(after.y).toBeCloseTo(before.y, 1);
        await expect(done).toHaveCSS("border-top-left-radius", "7px");
        await expect(done).toHaveCSS("border-left-width", "1px");
        await page.mouse.click(previousRead.x + previousRead.width / 2, previousRead.y + previousRead.height / 2);
        await expect(page.locator(`#${await read.getAttribute("aria-describedby")}`)).toBeHidden();
        await expect(page.locator(".row")).toHaveCount(2);
        await done.focus();
        await expect(done).toBeFocused();
        expect(canvas.writes).toEqual(["1"]);
        expect(canvas.doneWrites).toEqual([]);
      });
    }

    test("an all-read group still shows progress while an explicit Done batch is running", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      for (const row of canvas.rows) row.unread = false;
      let release;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(async args => {
        if (args.includes("DELETE")) await held;
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".repo-read")).toBeHidden();
        await page.locator(".repo-done").click();
        await expect(page.locator(".repo-done")).toHaveAttribute("aria-busy", "true");
        await expect(page.locator(".repo-done")).toBeVisible();
        await expect(page.locator(".repo-done")).toHaveAccessibleDescription("Marking 0/2 as done...");
        await expect(page.locator(".repo-done")).toHaveText("");
        await expect(page.locator(".repo-done svg")).toHaveCount(1);
        await expect(page.locator(".repo-done svg")).toBeHidden();
        await expect(page.locator(".repo-read")).toBeHidden();
        release();
        await expect(page.locator(".row")).toHaveCount(0);
        expect(canvas.doneWrites.toSorted()).toEqual(["1", "2"]);
      } finally {
        release();
      }
    });
  });
}
