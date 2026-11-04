import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

async function expectPanelInViewport(page) {
  await expect.poll(async () => {
    const box = await page.locator("#settings-panel").boundingBox();
    const { width, height } = page.viewportSize();
    return box && box.y >= 8 && box.y + box.height <= height - 8 && box.x >= 0 && box.x + box.width <= width;
  }).toBe(true);
}

for (const packaged of [false, true]) {
  test.describe(`settings viewport (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    test("Settings stays on-screen through resizing and scrolls its own content", async ({ page, canvas }) => {
      canvas.rows.splice(6);
      await page.setViewportSize({ width: 320, height: 480 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(6);
      const toggle = page.locator("#settings-toggle");
      const panel = page.locator("#settings-panel");
      await toggle.click();
      await expect(page.locator("#theme")).toBeEnabled();
      for (const [width, height, placement] of [[320, 480, "below"], [320, 320, "above"], [480, 640, "below"]]) {
        await page.setViewportSize({ width, height });
        await expect(panel).toHaveAttribute("data-placement", placement);
        await expect.poll(async () => {
          const box = await panel.boundingBox();
          return box.y >= 8 && box.y + box.height <= height - 8 && box.x >= 0 && box.x + box.width <= width;
        }).toBe(true);
        await expect(panel).toHaveCSS("overflow-y", "auto");
        await expect(panel).toHaveCSS("overscroll-behavior", "contain");
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(results.violations).toEqual([]);
      }
      await page.setViewportSize({ width: 320, height: 480 });
      await expect(panel).toHaveAttribute("data-placement", "below");
      const scrollBefore = await page.evaluate(() => window.scrollY);
      await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const updates = page.locator("#check-updates");
      await updates.focus();
      const control = await updates.boundingBox();
      expect(control.y).toBeGreaterThanOrEqual(8);
      expect(control.y + control.height).toBeLessThanOrEqual(472);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(page.locator("#settings-tooltip")).toBeHidden();
      await toggle.click();
      await page.evaluate(() => window.scrollTo(0, 400));
      await expect(panel).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("increased text spacing keeps setting labels, selected values and chevrons readable", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      await canvas.preferences.update({ matchGitHubInbox: false, groupBy: "none" });
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      await page.locator("#settings-toggle").click();
      await expect(page.locator("#theme")).toBeEnabled();
      expect(await page.locator(".select-setting").evaluateAll(nodes => nodes
        .map(node => node.getBoundingClientRect().height).filter(height => height > 0))).toEqual([38, 38, 38, 38]);
      await page.addStyleTag({ content: `
        * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
        p { margin-bottom: 2em !important; }
      ` });
      await expectPanelInViewport(page);
      const metrics = await page.locator(".select-setting select").evaluateAll(nodes => nodes
        .filter(node => node.getBoundingClientRect().height)
        .map(node => {
          const style = getComputedStyle(node);
          const probe = document.createElement("span");
          probe.textContent = node.selectedOptions[0].textContent;
          Object.assign(probe.style, {
            position: "absolute", visibility: "hidden", whiteSpace: "pre",
            font: style.font, letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing,
          });
          document.body.append(probe);
          const textWidth = probe.getBoundingClientRect().width;
          probe.remove();
          const row = node.parentElement;
          const rowBox = row.getBoundingClientRect();
          const box = node.getBoundingClientRect();
          const chevron = getComputedStyle(row, "::after");
          const center = rowBox.bottom - parseFloat(getComputedStyle(row).borderBottomWidth) -
            parseFloat(chevron.bottom) - parseFloat(chevron.height) / 2;
          return {
            id: node.id, textWidth,
            available: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            arrowOffset: Math.abs(center - (box.y + box.height / 2)),
          };
        }));
      expect(metrics.length).toBe(4);
      for (const metric of metrics) {
        expect(metric.textWidth, `${metric.id} selected value fits`).toBeLessThanOrEqual(metric.available + 0.5);
        expect(metric.arrowOffset, `${metric.id} chevron follows the select`).toBeLessThanOrEqual(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      for (const id of ["show-notifications", "auto-open", "desktop-notifications", "theme", "group-by", "check-updates"]) {
        const control = page.locator(`#${id}`);
        await control.focus();
        await expect(control).toBeFocused();
        const box = await control.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(8);
        expect(box.y + box.height).toBeLessThanOrEqual(792);
      }
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("zoom-equivalent reflow keeps Settings usable down to a 320px layout viewport", async ({ page, canvas }) => {
      canvas.rows.splice(6);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(6);
      for (const scale of [1, 2, 4]) {
        const width = 1280 / scale;
        const height = 960 / scale;
        await page.setViewportSize({ width, height });
        await page.locator("#settings-toggle").click();
        await expectPanelInViewport(page);
        const last = page.locator("#check-updates");
        await last.focus();
        await expect(last).toBeFocused();
        const box = await last.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(8);
        expect(box.y + box.height).toBeLessThanOrEqual(height - 8);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await last.press("Escape");
        await expect(page.locator("#settings-panel")).toBeHidden();
        await expect(page.locator("#settings-toggle")).toBeFocused();
      }
      expect(canvas.writes).toEqual([]);
    });

    test("an open Settings panel follows typography changes and a newly appearing update banner", async ({ page, canvas }) => {
      canvas.rows.splice(6);
      let showUpdate = false;
      await page.route(/\/api\/(?:state|refresh)$/, async route => {
        const response = await route.fetch();
        const state = await response.json();
        if (showUpdate) Object.assign(state.updates, {
          status: "available", latestVersion: "99.0.0", prompt: "Synthetic update prompt. Do not install anything.",
          releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v99.0.0",
        });
        await route.fulfill({ response, json: state });
      });
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.setViewportSize({ width: 320, height: 480 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(6);
      await page.locator("#settings-toggle").click();
      await expectPanelInViewport(page);
      const panel = page.locator("#settings-panel");
      await expect(panel).toHaveAttribute("data-placement", "below");
      await page.addStyleTag({ content: "h1 { line-height: 64px; }" });
      await expectPanelInViewport(page);
      showUpdate = true;
      await page.clock.runFor(5000);
      await expect(page.locator("#update-banner")).toBeVisible();
      await expect(panel).toHaveAttribute("data-placement", "above");
      await expectPanelInViewport(page);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });
  });
}
