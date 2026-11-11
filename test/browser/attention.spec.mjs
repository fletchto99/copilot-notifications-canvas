import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

test.beforeEach(async ({ canvas }) => {
  for (const row of canvas.rows) row.subject.url = `https://api.github.com/repos/${row.repository.full_name}/issues/${row.id}`;
});

test("attention tabs use tighter horizontal spacing without shrinking their height", async ({ page, canvas }) => {
  canvas.rows.splice(6);
  await canvas.preferences.update({ hideEmptyTabs: false });
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(6);
  const strip = page.getByRole("tablist", { name: "Attention filters" });
  await expect(strip).toHaveCSS("column-gap", "4px");
  const tabs = strip.getByRole("tab");
  for (const tab of await tabs.all()) {
    await expect(tab).toHaveCSS("padding-left", "8px");
    await expect(tab).toHaveCSS("padding-right", "8px");
    await expect(tab).toHaveCSS("font-size", "13px");
    expect((await tab.boundingBox()).height).toBeGreaterThanOrEqual(38);
  }
  const first = await tabs.first().boundingBox();
  const last = await tabs.last().boundingBox();
  expect(last.x + last.width - first.x).toBeLessThanOrEqual((await strip.boundingBox()).width);
  await expect(page.locator("#attention-next")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
  expect(canvas.writes).toEqual([]);
});

for (const packaged of [false, true]) {
  test.describe(`GitHub attention filters (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    for (const initialType of ["all", "Issue"]) {
      test(`changing Type from ${initialType} keeps the header stable without flashing a scrollbar`, async ({ page, canvas }) => {
        canvas.rows.splice(4);
        const type = "RepositoryDependabotAlertsThread";
        for (const [index, row] of canvas.rows.entries()) {
          row.subject = { type: index === 3 ? type : "Issue", title: `Sample ${index + 1}`, url: null };
          row.repository.full_name = "example/widgets";
          row.reason = "security_advisory_credit";
        }
        await canvas.preferences.updateFilters({
          type: initialType, reason: initialType === "all" ? "all" : "security_advisory_credit",
        });
        await page.setViewportSize({ width: 320, height: 900 });
        await page.goto(canvas.url);
        const count = initialType === "all" ? 4 : 3;
        await expect(page.locator(".row")).toHaveCount(count);
        await page.locator("#filters-toggle").click();
        const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height + 8));
        await page.setViewportSize({ width: 320, height });
        const layout = () => page.evaluate(() => ({
          headerHeight: document.getElementById("inbox-header").getBoundingClientRect().height,
          pageOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        }));
        const before = await layout();
        expect(before.pageOverflow).toBe(false);
        let release;
        await page.route("**/api/filters", async route => {
          await new Promise(resolve => { release = resolve; });
          await route.continue();
        });
        await page.evaluate(() => {
          window.filterOverflowFrames = [];
          const sample = () => {
            const root = document.documentElement;
            if (root.scrollHeight > root.clientHeight) {
              window.filterOverflowFrames.push({ height: root.scrollHeight, viewport: root.clientHeight });
            }
            window.filterOverflowFrame = requestAnimationFrame(sample);
          };
          sample();
        });
        try {
          await page.getByLabel("Type", { exact: true }).selectOption(type);
          await expect.poll(() => typeof release).toBe("function");
          await expect(page.locator("#filter-sync-status")).toBeVisible();
          await expect(page.locator(".row")).toHaveCount(count);
          expect(await layout()).toEqual(before);
          release();
          await expect(page.locator("#filter-sync-status")).toBeHidden();
          await expect(page.locator(".row")).toHaveCount(1);
          await expect(page.locator("#filters-toggle")).toHaveText(`Filters (${initialType === "all" ? 1 : 2})`);
          expect(await layout()).toEqual(before);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          expect(await page.evaluate(() => window.filterOverflowFrames)).toEqual([]);
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          release?.();
          await page.evaluate(() => cancelAnimationFrame(window.filterOverflowFrame));
        }
      });
    }

    for (const surface of ["popover", "page"]) {
      test(`pending filters do not flash a ${surface} scrollbar`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        const type = surface === "page" ? "PullRequest" : "Issue";
        for (const [index, row] of canvas.rows.entries()) {
          row.subject = { type, title: `Sample ${index + 1}`, url: null };
        }
        await canvas.preferences.updateFilters({ readState: "unread" });
        await page.setViewportSize(surface === "page" ? { width: 320, height: 900 } : { width: 480, height: 440 });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        await page.locator("#filters-toggle").click();
        if (surface === "page") {
          const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height + 8));
          await page.setViewportSize({ width: 320, height });
        }
        const layout = () => page.evaluate(() => {
          const panel = document.getElementById("filters-panel");
          return {
            panelHeight: panel.getBoundingClientRect().height,
            headerHeight: document.getElementById("inbox-header").getBoundingClientRect().height,
            panelOverflow: panel.scrollHeight > panel.clientHeight,
            pageOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
          };
        });
        await expect.poll(async () => (await layout()).panelOverflow).toBe(false);
        const before = await layout();
        if (surface === "page") expect(before.pageOverflow).toBe(false);
        let release;
        await page.route("**/api/filters", async route => {
          await new Promise(resolve => { release = resolve; });
          await route.continue();
        });
        try {
          await page.getByLabel("Type", { exact: true }).selectOption(type);
          await expect.poll(() => typeof release).toBe("function");
          await expect(page.getByRole("status").filter({ hasText: "Syncing filters..." })).toHaveCount(1);
          await expect.poll(layout).toEqual(before);
          release();
          await expect(page.locator("#filter-sync-status")).toBeHidden();
          await expect.poll(layout).toEqual(before);
          await page.setViewportSize({ width: 320, height: 320 });
          const panel = page.locator("#filters-panel");
          await expect(panel).toHaveCSS("overflow-y", "auto");
          await expect.poll(async () => (await layout()).panelOverflow).toBe(true);
          const clear = page.getByRole("button", { name: "Clear filters", exact: true });
          await clear.focus();
          await expect(clear).toBeFocused();
          const bounds = await clear.boundingBox();
          expect(bounds.y).toBeGreaterThanOrEqual(8);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(312);
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        } finally { release?.(); }
      });
    }

    for (const darkMode of [false, true]) {
      test(`active dropdowns match the Filters button border in ${darkMode ? "dark" : "light"} mode`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        await canvas.preferences.update({ darkMode });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        const toggle = page.locator("#filters-toggle");
        await toggle.click();
        const rows = page.locator("#filters-panel .select-setting");
        const neutralBorder = await rows.first().evaluate(node => getComputedStyle(node).borderTopColor);
        for (const row of await rows.all()) await expect(row).toHaveCSS("border-top-color", neutralBorder);
        const choices = [
          ["Read state", "unread"], ["Type", "Issue"], ["Reason", "review_requested"], ["Age", "older_7d"],
        ];
        let activeBorder;
        for (const [index, [label, value]] of choices.entries()) {
          await page.getByLabel(label, { exact: true }).selectOption(value);
          await expect(page.locator("#filter-sync-status")).toBeHidden();
          activeBorder = await toggle.evaluate(node => getComputedStyle(node).borderTopColor);
          expect(activeBorder).not.toBe(neutralBorder);
          for (let row = 0; row < choices.length; row++) {
            await expect(rows.nth(row)).toHaveCSS("border-top-color", row <= index ? activeBorder : neutralBorder);
          }
        }
        await page.getByLabel("Type", { exact: true }).selectOption("all");
        await expect(rows.nth(1)).toHaveCSS("border-top-color", neutralBorder);
        await expect(rows.nth(0)).toHaveCSS("border-top-color", activeBorder);
        await expect(rows.nth(2)).toHaveCSS("border-top-color", activeBorder);
        await expect(rows.nth(3)).toHaveCSS("border-top-color", activeBorder);
        await page.getByRole("button", { name: "Clear filters", exact: true }).click();
        await expect(toggle).toHaveText("Filters");
        for (const row of await rows.all()) await expect(row).toHaveCSS("border-top-color", neutralBorder);
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      });

      test(`Clear filters distinguishes disabled and hovered states in ${darkMode ? "dark" : "light"} mode`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        await canvas.preferences.update({ darkMode });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        await page.locator("#filters-toggle").click();
        const clear = page.getByRole("button", { name: "Clear filters", exact: true });
        await expect(clear).toBeDisabled();
        await expect(clear).toHaveCSS("opacity", "0.55");
        await expect(clear).toHaveCSS("cursor", "default");
        const inactiveBackground = await clear.evaluate(node => getComputedStyle(node).backgroundColor);
        await clear.hover();
        await expect(clear).toHaveCSS("background-color", inactiveBackground);
        const revision = (await canvas.preferences.read()).revision;
        await clear.dispatchEvent("click");
        expect((await canvas.preferences.read()).revision).toBe(revision);
        await page.getByLabel("Read state", { exact: true }).selectOption("unread");
        await expect(page.locator("#filter-sync-status")).toBeHidden();
        await expect(clear).toBeEnabled();
        await expect(clear).toHaveCSS("opacity", "1");
        await expect(clear).toHaveCSS("cursor", "pointer");
        await page.mouse.move(0, 0);
        await expect(clear).toHaveCSS("background-color", inactiveBackground);
        await clear.hover();
        await expect.poll(() => clear.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(inactiveBackground);
        await clear.focus();
        await clear.press("Enter");
        await expect(clear).toBeDisabled();
        await expect(clear).toHaveCSS("opacity", "0.55");
        await expect(clear).toHaveCSS("background-color", inactiveBackground);
        await expect(clear).toBeFocused();
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      });
    }

    test("dropdowns save automatically and Clear filters clears shared choices without saving search or tabs", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[0].reason = "mention";
      canvas.rows[1].reason = "mention";
      canvas.rows[1].unread = false;
      const settingsWrites = [];
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/settings") {
          settingsWrites.push(request.postDataJSON());
        }
      });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      await page.getByRole("tab", { name: "Mentioned (2)", exact: true }).click();
      await page.getByRole("searchbox").fill("widget");
      await expect(page.locator(".row")).toHaveCount(2);
      await page.locator("#filters-toggle").click();
      for (const [label, value] of [["Type", "Issue"], ["Read state", "unread"], ["Reason", "mention"], ["Age", "older_7d"]]) {
        await page.getByLabel(label, { exact: true }).selectOption(value);
      }
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Save as default", exact: true })).toHaveCount(0);
      await expect(page.locator("#filter-sync-status")).toBeHidden();
      const filterDefaults = { type: "Issue", readState: "unread", reason: "mention", age: "older_7d" };
      expect((await canvas.preferences.read()).filterDefaults).toEqual(filterDefaults);
      expect(settingsWrites).toEqual([]);
      const saved = await canvas.preferences.read();
      expect(saved.revision).toBeGreaterThan(0);
      expect(new Date(saved.updatedAt).toISOString()).toBe(saved.updatedAt);
      const clear = page.getByRole("button", { name: "Clear filters", exact: true });
      await clear.focus();
      await clear.press("Enter");
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#filters-toggle")).toHaveText("Filters");
      await expect(page.getByRole("searchbox")).toHaveValue("widget");
      await expect(page.locator("#attention-mentioned")).toHaveAttribute("aria-selected", "true");
      expect((await canvas.preferences.read()).filterDefaults).toEqual({
        type: "all", readState: "all", reason: "all", age: "all",
      });
      await page.keyboard.press("Escape");
      await page.locator("#force-refresh").click();
      await expect(page.locator("#filter-type")).toHaveValue("all");
      await expect(page.locator("#filter-readState")).toHaveValue("all");
      await expect(page.locator(".row")).toHaveCount(2);
      expect(settingsWrites).toHaveLength(0);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("visible canvases pick up shared filter changes on polling while keeping local search and tabs", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[0].reason = "mention";
      canvas.rows[1].reason = "mention";
      canvas.rows[1].unread = false;
      const filterDefaults = { type: "Issue", readState: "all", reason: "mention", age: "all" };
      await canvas.preferences.update({ matchGitHubInbox: false, filterDefaults });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      for (const [key, value] of Object.entries(filterDefaults)) {
        await expect(page.locator(`#filter-${key}`)).toHaveValue(value);
      }
      await expect(page.getByRole("searchbox")).toHaveValue("");
      await expect(page.locator("#attention-all")).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "Mentioned (2)", exact: true }).click();
      await page.getByRole("searchbox").fill("widget");
      await canvas.preferences.updateFilters({ readState: "unread" });
      await expect(page.locator("#filter-readState")).toHaveValue("unread", { timeout: 10_000 });
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.getByRole("searchbox")).toHaveValue("widget");
      await expect(page.locator("#attention-mentioned")).toHaveAttribute("aria-selected", "true");
      await canvas.preferences.updateFilters({ type: "Release" });
      await expect(page.locator("#filter-type")).toHaveValue("Release", { timeout: 10_000 });
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(page.getByRole("searchbox")).toHaveValue("widget");
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("a delayed dropdown write merges with a newer change to another shared field", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      let release;
      await page.route("**/api/filters", async route => {
        await new Promise(resolve => { release = resolve; });
        await route.continue();
      });
      try {
        await page.locator("#filters-toggle").click();
        await page.getByLabel("Type", { exact: true }).selectOption("Issue");
        await expect.poll(() => typeof release).toBe("function");
        await expect(page.locator("#filter-sync-status")).toHaveText("Syncing filters...");
        await canvas.preferences.updateFilters({ age: "older_7d" });
        release();
        await expect(page.locator("#filter-sync-status")).toBeHidden();
        await expect(page.locator("#filter-type")).toHaveValue("Issue");
        await expect(page.locator("#filter-age")).toHaveValue("older_7d");
        expect((await canvas.preferences.read()).filterDefaults).toEqual({
          type: "Issue", readState: "all", reason: "all", age: "older_7d",
        });
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      } finally { release?.(); }
    });

    test("Filters combines all refinements with search and tabs, and clearing preserves the search", async ({ page, canvas }) => {
      canvas.rows.splice(5);
      for (const [index, row] of canvas.rows.entries()) {
        row.subject.type = index === 4 ? "Release" : "PullRequest";
        row.subject.url = null;
        row.subject.title = index === 0 || index === 3 ? "Needle review" : "Another item";
        row.updated_at = new Date(Date.now() - (index === 3 ? 1 : 14) * 86_400_000).toISOString();
        row.reason = index === 2 ? "mention" : "review_requested";
        row.unread = index !== 1;
      }
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(5);
      await page.getByRole("tab", { name: "Review Requested (4)", exact: true }).click();
      await page.getByRole("searchbox").fill("Needle");
      await expect(page.locator(".row")).toHaveCount(2);
      await page.locator("#filters-toggle").click();
      for (const [label, value] of [["Type", "PullRequest"], ["Read state", "unread"],
        ["Reason", "review_requested"], ["Age", "older_7d"]]) {
        await page.getByLabel(label, { exact: true }).selectOption(value);
      }
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator('[data-focus-key="thread:1"]')).toBeVisible();
      await expect(page.locator("#filters-toggle")).toHaveText("Filters (4)");
      await expect(page.locator("#count")).toHaveText("5 loaded · 4 unread · 1 matching");
      await expect(page.locator("#attention-all")).toHaveText("All (1)");
      const reset = page.getByRole("button", { name: "Clear filters", exact: true });
      await reset.focus();
      await reset.press("Enter");
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.getByRole("searchbox")).toHaveValue("Needle");
      await expect(page.locator("#attention-review_requested")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#filters-toggle")).toHaveText("Filters");
      await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator("#filters-panel")).toBeHidden();
      await expect(page.locator("#filters-toggle")).toBeFocused();
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("Filters is accessible at narrow widths and dismisses without changing legacy preferences", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      await canvas.preferences.update({ matchGitHubInbox: false });
      await page.setViewportSize({ width: 320, height: 480 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      const toggle = page.locator("#filters-toggle");
      const panel = page.locator("#filters-panel");
      await toggle.focus();
      await toggle.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(panel.locator("label")).toHaveText(["Read state", "Type", "Reason", "Age"]);
      await expect(panel.locator("p:visible")).toHaveCount(0);
      await expect(panel).not.toHaveAttribute("aria-describedby");
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Read state", { exact: true })).toBeFocused();
      await page.getByLabel("Read state", { exact: true }).selectOption("read");
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(page.locator("#empty-title")).toHaveText("No matches in loaded notifications");
      await expect(toggle).toHaveText("Filters (1)");
      await expect(page.locator("#show-notifications, #filter-view-help")).toHaveCount(0);
      await page.mouse.move(0, 0);
      for (const height of [480, 320]) {
        await page.setViewportSize({ width: 320, height });
        await expect.poll(async () => {
          const box = await panel.boundingBox();
          return box && box.x >= 0 && box.x + box.width <= 320 && box.y >= 8 && box.y + box.height <= height - 8;
        }).toBe(true);
        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(accessibility.violations).toEqual([]);
      }
      await page.getByRole("searchbox").focus();
      await expect(panel).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await page.locator("#settings-toggle").click();
      await expect(panel).toBeHidden();
      await expect(page.locator("#settings-panel")).toBeVisible();
      expect((await canvas.preferences.read()).matchGitHubInbox).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    for (const groupBy of packaged ? ["repo"] : ["repo", "none", "date"]) {
      test(`pending refinements protect ${groupBy} bulk actions and never include unloaded matches`, async ({ page, canvas }) => {
        for (const row of canvas.rows) row.reason = ["1", "3", "51"].includes(row.id) ? "mention" : "subscribed";
        await canvas.preferences.update({ groupBy });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(50);
        let release;
        let hold = true;
        await page.route("**/api/filters", async route => {
          if (hold) await new Promise(resolve => { release = resolve; });
          await route.continue();
        });
        try {
          await page.locator("#filters-toggle").click();
          await page.getByLabel("Reason", { exact: true }).selectOption("mention");
          await expect.poll(() => typeof release).toBe("function");
          const blocked = await page.evaluate(() => {
            const actions = [...document.querySelectorAll(".repo-actions button, .row-actions button")];
            for (const button of actions) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            return actions.every(button => button.disabled || button.getAttribute("aria-disabled") === "true");
          });
          expect(blocked).toBe(true);
          expect(canvas.writes).toEqual([]);
          hold = false;
          release();
          await expect(page.locator(".row")).toHaveCount(2);
          await page.keyboard.press("Escape");
          await page.locator(".repo-done").first().click();
          const expected = groupBy === "repo" ? ["1"] : ["1", "3"];
          await expect.poll(() => [...canvas.doneWrites].sort()).toEqual(expected);
          expect(canvas.rows[50].unread).toBe(true);
          expect(canvas.requests.some(endpoint => endpoint.includes("page=2"))).toBe(false);
        } finally {
          hold = false;
          release?.();
        }
      });
    }

    test("tab order, participation and separate personal/team mentions match GitHub", async ({ page, canvas }) => {
      const reasons = ["review_requested", "author", "comment", "mention", "team_mention",
        "assign", "manual", "state_change", "invitation", "security_advisory_credit", "subscribed", "ci_activity"];
      canvas.rows.splice(reasons.length);
      for (const [index, row] of canvas.rows.entries()) row.reason = reasons[index];
      canvas.rows[1].unread = false;
      await page.goto(canvas.url);
      const tabs = page.getByRole("tablist", { name: "Attention filters" });
      await expect(tabs.getByRole("tab")).toHaveText([
        "All (12)", "Assigned (1)", "Participating (10)", "Mentioned (1)", "Team Mentioned (1)", "Review Requested (1)",
      ]);
      await page.getByRole("tab", { name: "Participating (10)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(10);
      await expect(page.locator('[data-focus-key="read:1"]')).toBeVisible();
      await expect(page.locator('[data-focus-key="read:2"]')).toBeDisabled();
      await expect(page.locator('[data-focus-key="read:11"]')).toHaveCount(0);
      await expect(page.locator('[data-focus-key="read:12"]')).toHaveCount(0);
      await page.getByRole("tab", { name: "Mentioned (1)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator('[data-focus-key="read:4"]')).toBeVisible();
      await page.getByRole("tab", { name: "Team Mentioned (1)", exact: true }).click();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator('[data-focus-key="read:5"]')).toBeVisible();
      await expect(page.locator('[data-focus-key="read:4"]')).toHaveCount(0);
      await page.locator('[data-focus-key="done:5"]').click();
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Team Mentioned (0)", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: "Participating (9)", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Mentioned (1)", exact: true })).toBeVisible();
      expect(canvas.doneWrites).toEqual(["5"]);
      expect(canvas.rows[3].unread).toBe(true);
    });

    test("hiding empty tabs defaults on, persists, ignores search and keeps keyboard navigation accessible", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].reason = "mention";
      canvas.rows[0].unread = false;
      await page.goto(canvas.url);
      const tabs = page.getByRole("tablist", { name: "Attention filters" }).getByRole("tab");
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Mentioned (1)"]);
      await Promise.all([
        page.evaluate(() => new Promise(resolve => {
          document.getElementById("settings").addEventListener("toggle", () => resolve(), { once: true });
        })),
        page.getByLabel("Settings", { exact: true }).click(),
      ]);
      const toggle = page.getByRole("switch", { name: "Hide empty tabs", exact: true });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("switch", { name: "Auto-open", exact: true })).toBeFocused();
      expect((await canvas.preferences.read()).hideEmptyTabs).toBe(true);
      const settingsAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(settingsAccessibility.violations).toEqual([]);
      await page.keyboard.press("Escape");
      await tabs.first().focus();
      for (const [key, name] of [
        ["ArrowRight", "Participating (1)"], ["ArrowRight", "Mentioned (1)"], ["ArrowRight", "All (1)"],
        ["ArrowLeft", "Mentioned (1)"], ["Home", "All (1)"], ["End", "Mentioned (1)"],
      ]) {
        await page.keyboard.press(key);
        const selected = page.getByRole("tab", { name, exact: true });
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", await selected.getAttribute("id"));
      }
      await page.getByRole("searchbox").fill("no matches");
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Mentioned (1)"]);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      await page.reload();
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Mentioned (1)"]);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(tabs).toHaveCount(7);
      expect((await canvas.preferences.read()).hideEmptyTabs).toBe(false);
      await page.reload();
      await expect(tabs).toHaveCount(7);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Mentioned (1)"]);
      await page.reload();
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Mentioned (1)"]);
      expect((await canvas.preferences.read()).hideEmptyTabs).toBe(true);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("All and the selected tab remain visible when empty and tabs return on refresh", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].reason = "mention";
      await canvas.preferences.update({ hideEmptyTabs: true });
      await page.goto(canvas.url);
      const tabs = page.getByRole("tablist", { name: "Attention filters" }).getByRole("tab");
      await page.getByRole("tab", { name: "Mentioned (1)", exact: true }).click();
      await page.locator('[data-focus-key="done:1"]').click();
      await expect(tabs).toHaveText(["All (0)", "Mentioned (0)"]);
      const selected = page.getByRole("tab", { name: "Mentioned (0)", exact: true });
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "attention-mentioned");
      await selected.focus();
      await page.keyboard.press("Home");
      await expect(tabs).toHaveText(["All (0)"]);
      await expect(tabs.first()).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(tabs.first()).toBeFocused();
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      Object.assign(canvas.rows[0], { done: false, unread: true, reason: "review_requested" });
      await page.getByRole("button", { name: "Force refresh", exact: true }).click();
      await expect(tabs).toHaveText(["All (1)", "Participating (1)", "Review Requested (1)"]);
      expect(canvas.doneWrites).toEqual(["1"]);
    });

    for (const [away, back, reason, label] of [
      ["ArrowRight", "ArrowLeft", "review_requested", "Review Requested"],
      ["Home", "End", "subscribed", "All"],
    ]) {
      test(`${away} then ${back} preserves empty-tab focus across delayed filter responses`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        canvas.rows[0].reason = reason;
        canvas.rows[1].reason = "mention";
        await page.goto(canvas.url);
        await page.getByRole("tab", { name: "Mentioned (1)", exact: true }).click();
        await page.locator('[data-focus-key="done:2"]').click();
        const mentioned = page.getByRole("tab", { name: "Mentioned (0)", exact: true });
        await expect(mentioned).toHaveAttribute("aria-selected", "true");
        await mentioned.focus();
        let hold = true;
        const releases = [];
        await page.route("**/api/filters", async route => {
          if (hold) await new Promise(resolve => releases.push(resolve));
          await route.continue();
        });
        try {
          await page.keyboard.press(away);
          await expect.poll(() => releases.length).toBe(1);
          await expect(page.getByRole("tab", { name: `${label} (1)`, exact: true })).toBeFocused();
          await page.keyboard.press(back);
          await expect(mentioned).toBeFocused();
          releases[0]();
          await expect.poll(() => releases.length).toBe(2);
          await expect(mentioned).toBeVisible();
          await expect(mentioned).toBeFocused();
          await expect(mentioned).toHaveAttribute("tabindex", "0");
          hold = false;
          releases[1]();
          await expect(mentioned).toHaveAttribute("aria-selected", "true");
          await expect(mentioned).toBeFocused();
          await page.keyboard.press("Home");
          await expect(page.getByRole("tab", { name: "All (1)", exact: true })).toBeFocused();
          await expect(page.locator("#attention-mentioned")).toBeHidden();
          expect(canvas.doneWrites).toEqual(["2"]);
        } finally {
          hold = false;
          for (const release of releases) release();
        }
      });
    }

    test("hidden tabs reappear when older matching notifications are loaded", async ({ page, canvas }) => {
      canvas.rows.splice(51);
      for (const row of canvas.rows) row.reason = "subscribed";
      canvas.rows[50].reason = "assign";
      await canvas.preferences.update({ hideEmptyTabs: true });
      await page.goto(canvas.url);
      const tabs = page.getByRole("tablist", { name: "Attention filters" }).getByRole("tab");
      await expect(tabs).toHaveText(["All (50)"]);
      await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
      await expect(tabs).toHaveText(["All (51)", "Assigned (1)", "Participating (1)"]);
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
      expect(canvas.writes).toEqual([]);
    });
  });
}
