import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { thread } from "../fixtures.mjs";
import octicons from "@primer/octicons";

for (const packaged of [false, true]) {
  test.describe(`compact ordered views (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged, timezoneId: "UTC" });

    test("toolbar and row actions render complete upstream Octicons with inherited colors and accessible controls", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      for (const [selector, name] of [
        ["#inbox-icon", "inbox"], ["#refresh-icon", "sync"], ["#shortcuts-icon", "question"],
        ["#settings-icon", "gear"], ["#attention-previous-icon", "chevron-left"],
        ["#attention-next-icon", "chevron-right"], ["#update-details-icon", "triangle-right"],
        [".mark-read svg", "read"], [".mark-done svg", "check"],
      ]) {
        const svg = page.locator(selector);
        const expected = octicons[name].heights[24];
        await expect(svg).toHaveAttribute("viewBox", `0 0 ${expected.width} 24`);
        await expect(svg).toHaveAttribute("width", selector === "#update-details-icon" ? "12" : "18");
        await expect(svg).toHaveAttribute("height", selector === "#update-details-icon" ? "12" : "18");
        await expect(svg).toHaveAttribute("fill", "currentColor");
        await expect(svg).toHaveAttribute("stroke", "none");
        await expect(svg).toHaveAttribute("aria-hidden", "true");
        await expect(svg).toHaveAttribute("focusable", "false");
        expect(await svg.locator("path").evaluateAll(paths => paths.map(path => path.getAttribute("d"))))
          .toEqual(expected.ast.children.map(path => path.attributes.d));
      }
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
      expect(canvas.writes).toEqual([]);
    });

    test("date and flat views preserve interleaved API order and date actions target the displayed day", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[0].repository.full_name = "example/zulu";
      canvas.rows[1].repository.full_name = "example/alpha";
      canvas.rows[2].repository.full_name = "example/zulu";
      canvas.rows[0].updated_at = "2026-01-10T12:00:00Z";
      canvas.rows[1].updated_at = "2026-01-12T10:00:00Z";
      canvas.rows[2].updated_at = "2026-01-12T14:00:00Z";
      await page.goto(canvas.url);
      await page.getByLabel("Settings", { exact: true }).click();
      const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
      await grouping.selectOption("none");
      await expect(page.locator(".row .title")).toHaveText(canvas.rows.map(row => row.subject.title));
      await grouping.selectOption("date");
      await expect(page.locator(".repo-name")).toHaveText(["January 12, 2026", "January 10, 2026"]);
      await expect(page.locator(".row .title")).toHaveText([1, 2, 0].map(index => canvas.rows[index].subject.title));
      await page.keyboard.press("Escape");
      await page.locator('[data-focus-key="bulk-done:date:2026-01-12"]').click();
      await expect(page.locator(".row")).toHaveCount(1);
      expect(canvas.doneWrites.toSorted()).toEqual(["2", "3"]);
      await expect(page.locator('[data-focus-key="done:1"]')).toBeVisible();
    });

    test("compact spacing fits more rows without shrinking text or action targets", async ({ page, canvas }) => {
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      for (const [width, maximumRowHeight, minimumVisible] of [[480, 84, 7], [960, 60, 9]]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".row")].map(row => row.getBoundingClientRect());
          const heights = rows.map(row => row.height).sort((a, b) => a - b);
          return {
            medianHeight: heights[Math.floor(heights.length / 2)],
            visible: rows.filter(row => row.top >= 0 && row.bottom <= innerHeight).length,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(layout.medianHeight).toBeLessThanOrEqual(maximumRowHeight);
        expect(layout.visible).toBeGreaterThanOrEqual(minimumVisible);
        expect(layout.overflow).toBe(false);
        await expect(page.locator(".row .title").first()).toHaveCSS("font-size", "14px");
        await expect(page.locator(".metadata").first()).toHaveCSS("font-size", "12px");
        for (const selector of [".mark-read", ".mark-done"]) {
          await expect(page.locator(selector).first()).toHaveCSS("width", "32px");
          await expect(page.locator(selector).first()).toHaveCSS("height", "32px");
        }
        await expect(page.locator("#force-refresh")).toHaveCSS("width", "38px");
        await expect(page.locator("#force-refresh")).toHaveCSS("height", "38px");
      }
      expect(canvas.writes).toEqual([]);
    });

    test("group headers keep a subtle highlight without changing on hover", async ({ page, canvas }, testInfo) => {
      canvas.rows.splice(3);
      canvas.rows[0].subject.title = "Add notification filters";
      canvas.rows[1].subject.title = "Improve keyboard navigation";
      canvas.rows[1].unread = false;
      canvas.rows[2].subject.title = "Review the release checklist";
      await page.setViewportSize({ width: 480, height: 900 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      for (const theme of ["light", "dark"]) {
        for (const groupBy of ["repo", "date", "none"]) {
          await page.locator("#settings-toggle").click();
          await page.locator("#theme").selectOption(theme);
          await page.locator("#group-by").selectOption(groupBy);
          await page.keyboard.press("Escape");
          await expect(page.locator("html")).toHaveAttribute("data-notification-theme", theme);
          await expect(page.locator(".repo-name").first()).toHaveText(
            groupBy === "repo" ? "example/widgets" : groupBy === "date" ? "January 10, 2026" : "All notifications");
          const group = page.locator(".repo-group").first();
          const header = group.locator(".repo-header");
          const toggle = group.locator(".repo-toggle");
          await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
          const background = await header.evaluate(node => getComputedStyle(node).backgroundColor);
          expect(background).not.toBe("rgba(0, 0, 0, 0)");
          await toggle.hover();
          await expect(header).toHaveCSS("background-color", background);
          await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await toggle.focus();
          await expect(header).toHaveCSS("background-color", background);
          const done = group.locator(".repo-done");
          await done.hover();
          await expect(done).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(header).toHaveCSS("background-color", background);
          await expect(header).toHaveCSS("border-top-right-radius", "9px");
          await expect(header).toHaveCSS("border-bottom-right-radius", "0px");
          await page.keyboard.press("Escape");
          await toggle.click();
          await expect(group.locator(".repo-items")).toBeHidden();
          await expect(header).toHaveCSS("background-color", background);
          await expect(header).toHaveCSS("border-bottom-right-radius", "9px");
          await toggle.click();
          await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
          const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(results.violations).toEqual([]);
          if (groupBy === "repo") await page.screenshot({ path: testInfo.outputPath(`group-headers-${theme}.png`), fullPage: true });
        }
      }
      expect(canvas.writes).toEqual([]);
    });

    test("a poll between pointer down and up does not cancel Load more", async ({ page, canvas }) => {
      await page.clock.install();
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      const more = page.locator("#more");
      await more.scrollIntoViewIfNeeded();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      const box = await more.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      try {
        await page.evaluate(() => {
          window.pollRendered = false;
          const observer = new MutationObserver(() => {
            window.pollRendered = true;
            observer.disconnect();
          });
          observer.observe(document.getElementById("count"), { childList: true });
        });
        await page.clock.runFor(5000);
        await expect.poll(() => page.evaluate(() => window.pollRendered)).toBe(true);
      } finally {
        await page.mouse.up();
      }
      await expect(page.locator(".row")).toHaveCount(53);
      expect(canvas.writes).toEqual([]);
    });

    test("100 loaded notifications keep API order, counts and DOM identity through unchanged polls", async ({ page, canvas }) => {
      const rows = Array.from({ length: 100 }, (_, index) => thread(String(index + 1), {
        unread: index % 2 === 0,
        repository: { full_name: index % 2 === 0 ? "example/widgets" : "example/tools" },
      }));
      canvas.rows.splice(0, canvas.rows.length, ...rows);
      await canvas.preferences.update({ groupBy: "none" });
      await page.clock.install();
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      await page.locator("#more").click();
      await expect(page.locator(".row")).toHaveCount(100);
      await expect(page.locator("#more")).toBeHidden();
      await expect(page.locator("#count")).toHaveText("100 loaded \u00b7 50 unread");
      await expect(page.locator(".repo-count")).toHaveText("100 loaded \u00b7 50 unread");
      const first = page.locator('[data-focus-key="thread:1"]');
      await expect(first.locator(".subject-open")).toHaveCount(1);
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await first.focus();
      const original = await first.elementHandle();
      const acknowledged = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/state") {
          acknowledged.push(Number(request.headers()["x-notification-acknowledged-version"]));
        }
      });
      const poll = page.waitForResponse(response => response.url().endsWith("/api/state"));
      await page.clock.runFor(5000);
      const response = await poll;
      let snapshotVersion;
      // The next state request acknowledges only snapshots the renderer has finished rendering.
      await Promise.all([
        response.json().then(snapshot => { snapshotVersion = snapshot.snapshotVersion; }),
        expect.poll(async () => {
          await page.clock.runFor(5000);
          return snapshotVersion !== undefined && acknowledged.some(version => version >= snapshotVersion);
        }).toBe(true),
      ]);
      await expect(first).toBeFocused();
      expect(await original.evaluate(node => node.isConnected)).toBe(true);
      expect(canvas.requests.filter(path => path.startsWith("/notifications?"))).toHaveLength(2);
      await page.getByRole("searchbox").fill("notification 100");
      await page.clock.runFor(250);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#count")).toHaveText("100 loaded \u00b7 50 unread \u00b7 1 matching");
      await page.getByRole("searchbox").fill("");
      await page.clock.runFor(250);
      await expect(page.locator(".row")).toHaveCount(100);
      expect(await page.locator(".row-link").evaluateAll(nodes => nodes.map(node => node.dataset.focusKey)))
        .toEqual(rows.map(row => `thread:${row.id}`));
      for (const width of [320, 480, 960]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });
  });
}
