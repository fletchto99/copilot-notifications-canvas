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
      const copilotIntegration = page.getByRole("switch", { name: "Copilot integration", exact: true });
      const copilotConfirmations = page.getByRole("switch", { name: "Confirm Copilot actions", exact: true });
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
          await expect(copilotIntegration).toBeFocused();
          await copilotIntegration.press("Tab");
          await expect(copilotConfirmations).toBeFocused();
          await copilotConfirmations.press("Tab");
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
  await expect(page.locator("#count")).toHaveText("2 loaded \u00b7 1 unread");
  await expect(page.locator("#inbox-mode")).toBeHidden();
  await expect(page.locator('[data-focus-key="read:2"]')).toBeDisabled();
  await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
  await page.locator('[data-focus-key="read:1"]').click();
  await expect(page.locator(".row")).toHaveCount(2);
  await expect(page.locator(".row.unread")).toHaveCount(0);
  await expect(page.locator(".mark-read:disabled")).toHaveCount(2);
  await expect(page.locator("#row-read-1-tooltip")).toHaveText("Already read");
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
  await expect(page.locator("#inbox-mode")).toHaveText("Unread only");
  await expect(page.locator("#inbox-mode")).toBeVisible();
  expect((await canvas.preferences.read()).matchGitHubInbox).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(page.locator(".row")).toHaveCount(0);
  await expect(page.locator("#inbox-mode")).toBeVisible();
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(select).toHaveValue("unread");
  await select.selectOption("all");
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator("#inbox-mode")).toBeHidden();
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
    await expect(page.locator("#inbox-mode")).toBeHidden();
    await page.getByLabel("Settings", { exact: true }).click();
    const select = page.getByRole("combobox", { name: "Show notifications", exact: true });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("all");
    const selection = page.waitForRequest(request =>
      new URL(request.url()).pathname === "/api/subjects" &&
      request.postDataJSON().complete && request.postDataJSON().positions.length === 1);
    const selectedState = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== "/api/state") return false;
      const snapshot = await response.json();
      const { selectionKey, version } = (await selection).postDataJSON();
      return snapshot.selectionKey === selectionKey && snapshot.subjectSelectionVersion === version;
    });
    await select.selectOption("unread");
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(select).toHaveValue("unread");
    await expect(page.locator("#inbox-mode")).toBeVisible();
    await expect(page.getByRole("tab", { name: "All (1)", exact: true })).toBeVisible();
    // Let the selection's follow-up fetch finish before WebKit starts navigating away.
    expect(await (await selectedState).finished()).toBeNull();
    await page.reload();
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator("#inbox-mode")).toBeVisible();
    expect((await canvas.preferences.read()).matchGitHubInbox).toBe(false);
    await page.locator('[data-focus-key="read:1"]').click();
    await expect(page.locator(".row")).toHaveCount(0);
    await expect(page.locator("#inbox-mode")).toBeVisible();
    await page.getByLabel("Settings", { exact: true }).click();
    await select.selectOption("all");
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator("#inbox-mode")).toBeHidden();
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
