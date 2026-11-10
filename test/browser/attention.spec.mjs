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
      await expect(page.locator('[data-focus-key="read:2"]')).toHaveCount(0);
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
