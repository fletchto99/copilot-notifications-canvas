import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`pending search actions (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    for (const groupBy of packaged ? ["repo"] : ["repo", "none", "date"]) {
      for (const action of ["read", "done"]) {
        test(`${groupBy} ${action} waits for the search selection before accepting writes`, async ({ page, canvas }) => {
          canvas.rows.splice(3);
          await canvas.preferences.update({ groupBy });
          await page.goto(canvas.url);
          await expect(page.locator(".row")).toHaveCount(3);
          const result = await page.evaluate(() => {
            const input = document.getElementById("search");
            input.value = "Needle tool";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            const actions = [...document.querySelectorAll(".repo-actions button, .row-actions button")];
            for (const button of actions) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            return { blocked: actions.every(button => button.disabled || button.getAttribute("aria-disabled") === "true"), searchDisabled: input.disabled };
          });
          expect(result).toEqual({ blocked: true, searchDisabled: false });
          expect(canvas.writes).toEqual([]);
          await expect(page.locator(".row")).toHaveCount(1);
          const button = page.locator(`.repo-${action}`);
          await expect(button).toBeEnabled();
          await expect(button).toHaveAccessibleDescription(`Mark 1 as ${action}`);
          await button.click();
          await expect.poll(() => canvas.writes).toEqual(["3"]);
          expect(canvas.doneWrites).toEqual(action === "done" ? ["3"] : []);
          expect(canvas.rows[0].unread).toBe(true);
          expect(canvas.rows[1].unread).toBe(true);
        });
      }
    }
  });
}
