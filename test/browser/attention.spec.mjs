import { test, expect } from "./fixtures.mjs";

test("attention tabs use tighter horizontal spacing without shrinking their height", async ({ page, canvas }) => {
  canvas.rows.splice(6);
  await page.setViewportSize({ width: 720, height: 900 });
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
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
  });
}
