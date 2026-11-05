import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const width of [320, 960]) {
  test(`tooltips share above placement and flip only at the viewport edge at ${width}px`, async ({ page, canvas }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(50);
    const controls = [
      page.locator("#open-inbox"), page.locator("#force-refresh"), page.locator("#settings-toggle"),
      page.locator(".repo-read").first(), page.locator(".repo-done").first(),
      page.locator('[data-focus-key="read:1"]'), page.locator('[data-focus-key="done:1"]'),
    ];
    for (const control of controls) {
      await page.getByRole("searchbox").focus();
      await control.hover();
      const tooltip = page.locator(`#${await control.getAttribute("aria-describedby")}`);
      await expect(tooltip).toBeVisible();
      const bounds = await tooltip.boundingBox();
      const button = await control.boundingBox();
      expect(bounds.y).toBeGreaterThanOrEqual(8);
      if (controls.indexOf(control) < 3) {
        expect(Math.abs(bounds.y - button.y - button.height)).toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(bounds.y + bounds.height - button.y)).toBeLessThanOrEqual(1);
      }
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
    }

    for (const control of [controls[1], controls[3], controls[5]]) {
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement?.blur());
      await control.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 12));
      await expect.poll(async () => (await control.boundingBox()).y).toBeCloseTo(12);
      // Locator hover can auto-scroll again in WebKit, invalidating the edge placement.
      const target = await control.boundingBox();
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
      await expect(control.locator("..")).toHaveAttribute("data-tooltip-placement", "below");
      const tooltip = page.locator(`#${await control.getAttribute("aria-describedby")}`);
      await expect(tooltip).toBeVisible();
      const bounds = await tooltip.boundingBox();
      const button = await control.boundingBox();
      expect(button.y).toBeCloseTo(12);
      expect(bounds.y).toBeCloseTo(button.y + button.height);
      const content = await tooltip.locator(".tooltip-content").boundingBox();
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="tooltip"]')?.id,
        { x: content.x + content.width / 2, y: content.y + content.height / 2 })).toBe(await tooltip.getAttribute("id"));
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
    }

    await page.getByRole("searchbox").focus();
    const scrollControl = controls[3];
    await scrollControl.focus();
    const tooltip = page.locator(`#${await scrollControl.getAttribute("aria-describedby")}`);
    const anchor = scrollControl.locator("..");
    await expect(tooltip).toBeVisible();
    await scrollControl.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 12));
    await expect(anchor).toHaveAttribute("data-tooltip-placement", "below");
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(anchor).toHaveAttribute("data-tooltip-placement", "above");
    await expect(tooltip).toBeVisible();
    await page.setViewportSize({ width, height: 850 });
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width, height: 900 });
    await expect(tooltip).toBeHidden();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    expect(canvas.writes).toEqual([]);
  });
}
