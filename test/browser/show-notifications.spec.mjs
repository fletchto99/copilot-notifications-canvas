import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`notification view control (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    test("Group By follows Show notifications in layout and keyboard order without obstruction", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      const settings = page.getByLabel("Settings", { exact: true });
      const select = page.getByRole("combobox", { name: "Show notifications", exact: true });
      const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
      const hideEmptyTabs = page.getByRole("switch", { name: "Hide empty tabs", exact: true });
      for (const width of [320, 960]) {
        await page.setViewportSize({ width, height: 640 });
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await settings.click();
          await expect(select).toBeEnabled();
          await expect(select).toHaveAccessibleName("Show notifications");
          await expect(select).toHaveValue("all");
          await expect(select.locator("option")).toHaveText(["All", "Unread only"]);
          await expect(select).not.toHaveAttribute("aria-describedby");
          await expect(select).not.toHaveAttribute("title");
          await expect(page.locator("#show-notifications-help, #show-notifications-tooltip")).toHaveCount(0);
          const controlBounds = await select.locator("..").boundingBox();
          const nextBounds = await grouping.locator("..").boundingBox();
          expect(nextBounds.y - controlBounds.y - controlBounds.height).toBeCloseTo(8, 1);
          await select.selectOption("unread");
          await expect(select).toBeEnabled();
          expect(await select.evaluate(node => {
            const style = getComputedStyle(node);
            const context = document.createElement("canvas").getContext("2d");
            context.font = style.font;
            return context.measureText(node.options[node.selectedIndex].text).width <=
              node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 0.5;
          })).toBe(true);
          await select.selectOption("all");
          await expect(select).toBeEnabled();
          await select.hover();
          expect(await grouping.evaluate(node => {
            const bounds = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
          })).toBe(true);
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          await select.focus();
          await select.press("Tab");
          await expect(grouping).toBeFocused();
          await grouping.press("Tab");
          await expect(hideEmptyTabs).toBeFocused();
          await hideEmptyTabs.click();
          await expect(hideEmptyTabs).toHaveAttribute("aria-checked", "false");
          await hideEmptyTabs.click();
          await expect(hideEmptyTabs).toHaveAttribute("aria-checked", "true");
          await page.keyboard.press("Escape");
          await expect(settings).toBeFocused();
        }
      }
      expect(canvas.writes).toEqual([]);
      expect((await canvas.preferences.read()).matchGitHubInbox).toBe(true);
    });
  });
}

test("inbox matching, persistence and action eligibility remain accessible", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  canvas.rows[1].unread = false;
  canvas.rows[2].unread = false;
  canvas.rows[2].done = true;
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  await expect(page.locator(".row.read")).toHaveCount(1);
  await expect(page.locator("#count")).toHaveText("2 total \u00b7 1 unread");
  await expect(page.locator('[data-focus-key="read:2"]')).toHaveCount(0);
  await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
  await page.locator('[data-focus-key="read:1"]').click();
  await expect(page.locator(".row")).toHaveCount(2);
  await expect(page.locator(".row.unread")).toHaveCount(0);
  await expect(page.locator(".mark-read")).toHaveCount(0);
  await expect(page.locator("#row-read-1-tooltip")).toHaveCount(0);
  await expect(page.locator('[data-focus-key="done:1"]')).toBeFocused();
  await expect(page.locator('[data-focus-key="bulk:example/widgets"]')).toBeDisabled();
  await page.locator('[data-focus-key="done:2"]').click();
  await expect(page.locator(".row")).toHaveCount(1);
  await page.getByLabel("Settings", { exact: true }).click();
  const select = page.getByRole("combobox", { name: "Show notifications", exact: true });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("all");
  await select.selectOption("unread");
  await expect(select).toHaveValue("unread");
  await expect(page.locator(".row")).toHaveCount(0);
  expect((await canvas.preferences.read()).matchGitHubInbox).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(page.locator(".row")).toHaveCount(0);
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(select).toHaveValue("unread");
  await select.selectOption("all");
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator('[data-focus-key="done:3"]')).toHaveCount(0);
  await expect(page.locator('[data-focus-key="done:2"]')).toHaveCount(0);
  expect(canvas.writes).toEqual(["1", "2"]);
  expect(canvas.doneWrites).toEqual(["2"]);
  expect(canvas.deliveries).toEqual([]);
});

test.describe("packaged notification views", () => {
  test.use({ packaged: true });
  test("the installed bundle saves the selected view and reloads the matching API scope", async ({ page, canvas }) => {
    canvas.rows.splice(3);
    canvas.rows[1].unread = false;
    canvas.rows[2].unread = false;
    canvas.rows[2].done = true;
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(2);
    await page.getByLabel("Settings", { exact: true }).click();
    const select = page.getByRole("combobox", { name: "Show notifications", exact: true });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("all");
    await select.selectOption("unread");
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(select).toHaveValue("unread");
    await page.reload();
    await expect(page.locator(".row")).toHaveCount(1);
    expect((await canvas.preferences.read()).matchGitHubInbox).toBe(false);
    await page.locator('[data-focus-key="read:1"]').click();
    await expect(page.locator(".row")).toHaveCount(0);
    await page.getByLabel("Settings", { exact: true }).click();
    await select.selectOption("all");
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator('[data-focus-key="done:3"]')).toHaveCount(0);
    const queries = canvas.requests.filter(path => path.startsWith("/notifications?"))
      .map(path => new URL(path, "https://api.github.com").searchParams);
    expect(queries.some(query => query.get("all") === "false" && !query.has("is_done"))).toBe(true);
    expect(queries.some(query => query.get("all") === "true" && query.get("is_done") === "false")).toBe(true);
    expect(queries.every(query => query.get("all") === "false" || query.get("is_done") === "false")).toBe(true);
    expect(canvas.writes).toEqual(["1"]);
    expect(canvas.deliveries).toEqual([]);
  });
});
