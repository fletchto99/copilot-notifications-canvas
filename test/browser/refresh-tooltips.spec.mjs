import { test, expect } from "./fixtures.mjs";

async function refreshProvider(page) {
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${location.hash.slice(1)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  await page.clock.fastForward(5000);
}

for (const packaged of [false, true]) {
  test.describe(`refresh tooltip lifecycle (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const selector of [".mark-read", ".mark-done", ".repo-read", ".repo-done"]) {
      test(`${selector} hover tooltip closes after refresh when the pointer leaves`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        await page.clock.install();
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        const control = page.locator(selector).first();
        await control.evaluate(node => node.addEventListener("click", event => {
          event.preventDefault();
          event.stopImmediatePropagation();
        }, { capture: true, once: true }));
        await control.click();
        await control.focus();
        await expect(control).toBeFocused();
        const tooltip = page.locator(`#${await control.getAttribute("aria-describedby")}`);
        await expect(tooltip).toBeVisible();
        canvas.rows[0].subject.title = "Refreshed synthetic notification";
        await refreshProvider(page);
        await expect(page.locator(".row .title").first()).toHaveText("Refreshed synthetic notification");
        await expect(control).toBeFocused();
        await page.mouse.move(0, 0);
        await expect(tooltip).toBeHidden();
        await expect(control).toBeFocused();
        expect(canvas.writes).toEqual([]);
      });
    }

    test("keyboard tooltips remain accessible and Escape dismissal survives refresh", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.clock.install();
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      await page.getByRole("searchbox").focus();
      await page.keyboard.press("Tab");
      const control = page.locator(".mark-done");
      await control.focus();
      await page.mouse.move(0, 0);
      const tooltip = page.locator(`#${await control.getAttribute("aria-describedby")}`);
      await expect(tooltip).toBeVisible();
      canvas.rows[0].subject.title = "Keyboard refresh one";
      await refreshProvider(page);
      await expect(page.locator(".row .title")).toHaveText("Keyboard refresh one");
      await expect(control).toBeFocused();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
      canvas.rows[0].subject.title = "Keyboard refresh two";
      await refreshProvider(page);
      await expect(page.locator(".row .title")).toHaveText("Keyboard refresh two");
      await expect(control).toBeFocused();
      await expect(tooltip).toBeHidden();
      expect(canvas.writes).toEqual([]);
    });
  });
}
