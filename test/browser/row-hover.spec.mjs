import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`inactive row hover (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const activation of ["command-click", "middle-click"]) {
      test(`${activation} clears the highlight until fresh pointer input`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        await page.goto(canvas.url);
        const row = page.locator(".row");
        const link = row.locator(".row-link");
        await page.evaluate(() => {
          for (const type of ["click", "auxclick"]) document.addEventListener(type, event => {
            const link = event.target.closest(".row-link");
            if (!link) return;
            window.rowActivation = {
              type, metaKey: event.metaKey, button: event.button, preventedByCanvas: event.defaultPrevented,
              target: link.target, href: link.href,
            };
            event.preventDefault();
          });
        });
        await link.hover();
        await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await link.click(activation === "command-click" ? { modifiers: ["Meta"] } : { button: "middle" });
        await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect(await row.evaluate(node => node.matches(":hover"))).toBe(true);
        const event = await page.evaluate(() => window.rowActivation);
        expect(event.preventedByCanvas).toBe(false);
        expect(event.target).toBe("_blank");
        expect(event.href).toBe(await link.getAttribute("href"));
        expect(activation === "command-click" ? event.metaKey : event.button === 1).toBe(true);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await page.mouse.move(0, 0);
        await link.hover();
        await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect(canvas.writes).toEqual([]);
      });
    }

    test("window blur clears a hovered row without changing its link or focus target", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      const row = page.locator(".row");
      const link = row.locator(".row-link");
      await link.focus();
      await link.hover();
      await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const href = await link.getAttribute("href");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(link).toBeFocused();
      await expect(link).toHaveAttribute("href", href);
      await page.mouse.move(0, 0);
      await link.hover();
      await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect(canvas.writes).toEqual([]);
    });
  });
}
