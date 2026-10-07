import { test, expect } from "./fixtures.mjs";

test.use({ packaged: true });

test("installed bundle supports search, saved settings and exact row writes in a real browser", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(page.locator("#development-build")).toBeHidden();
  await expect(page.locator("#development-build")).toBeEmpty();
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
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(page.locator(".repo-group")).toHaveCount(0);
  expect((await canvas.preferences.read()).groupBy).toBe("none");
});
