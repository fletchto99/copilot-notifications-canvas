import { test, expect } from "./fixtures.mjs";

test.use({ packaged: true });

test("installed bundle supports search, saved settings and exact row writes in a real browser", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(page.locator("#development-build")).toBeHidden();
  await expect(page.locator("#development-build")).toBeEmpty();
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.locator(".toolbar > #refresh-control + #settings")).toHaveCount(1);
  await page.getByRole("searchbox").fill("Needle");
  await expect(page.locator(".row")).toHaveCount(3);
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("none");
  await expect(page.locator(".repo-group")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Mark as read: Needle widget 2", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(2);
  expect(canvas.writes).toEqual(["2"]);
  const done = page.getByRole("button", { name: "Mark as done: Needle tool", exact: true });
  await expect(done).toHaveText("");
  await expect(done.locator("svg")).toBeVisible();
  await done.hover();
  await expect(page.locator("#row-done-3-tooltip")).toBeVisible();
  await done.click();
  await expect(page.locator(".row")).toHaveCount(1);
  expect(canvas.writes).toEqual(["2", "3"]);
  expect(canvas.doneWrites).toEqual(["3"]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(page.locator(".repo-group")).toHaveCount(0);
  await expect(page.locator('[data-focus-key="done:3"]')).toHaveCount(0);
  expect((await canvas.preferences.read()).groupBy).toBe("none");
});

test("installed bundle sends repository Done actions through the split control", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  await page.getByRole("button", { name: "More actions for example/widgets", exact: true }).click();
  const done = page.getByRole("button", { name: "Mark 2 shown, loaded notifications as done in example/widgets", exact: true });
  await expect(done).toBeFocused();
  expect(canvas.doneWrites).toEqual([]);
  await done.press("Enter");
  await expect(page.locator(".row")).toHaveCount(0);
  expect(canvas.doneWrites).toEqual(["1", "2"]);
  expect(canvas.writes).toEqual(["1", "2"]);
});
