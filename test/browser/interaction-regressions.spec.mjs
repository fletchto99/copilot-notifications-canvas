import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`interaction regressions (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("holding Enter on Read cannot activate Done after focus moves to the replacement action", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(2);
      await page.goto(canvas.url);
      const read = page.locator('[data-focus-key="read:1"]');
      const done = page.locator('[data-focus-key="done:1"]');
      await read.focus();
      try {
        await page.keyboard.down("Enter");
        await expect.poll(() => canvas.writes).toEqual(["1"]);
        await expect(done).toBeFocused();
        await page.evaluate(() => {
          document.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && event.repeat) window.repeatedActivationPrevented = event.defaultPrevented;
          });
        });
        await page.keyboard.down("Enter");
        await expect(done).toBeEnabled();
        expect(canvas.doneWrites).toEqual([]);
        expect(await page.evaluate(() => window.repeatedActivationPrevented)).toBe(true);
      } finally {
        await page.keyboard.up("Enter");
      }
      await done.press("Enter");
      await expect.poll(() => canvas.doneWrites).toEqual(["1"]);
      await expect(page.locator(".row")).toHaveCount(1);
    });

    test("holding Enter to start a batch cannot immediately activate Stop when focus moves", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(2);
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      canvas.setRequestHook(async (args) => {
        if (args.includes("PATCH")) await held;
      });
      await page.goto(canvas.url);
      await page.locator(".repo-read").focus();
      try {
        await page.keyboard.down("Enter");
        await expect(page.locator("#batch-stop")).toBeFocused();
        await page.evaluate(() => {
          document.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && event.repeat) window.repeatedActivationPrevented = event.defaultPrevented;
          });
        });
        await page.keyboard.down("Enter");
        await expect(page.locator("#batch-title")).toContainText("Marking as read...");
        await expect(page.locator("#batch-stop")).toBeEnabled();
        expect(await page.evaluate(() => window.repeatedActivationPrevented)).toBe(true);
      } finally {
        await page.keyboard.up("Enter");
        release();
      }
      await expect.poll(() => canvas.writes).toEqual(["1", "2"]);
      expect(canvas.doneWrites).toEqual([]);
    });

    test("toolbar hover clears when the window loses focus and resumes only with fresh pointer input", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      const inbox = page.locator("#open-inbox");
      await inbox.hover();
      await expect(inbox).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(inbox).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(inbox).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.mouse.move(0, 0);
      await inbox.hover();
      await expect(inbox).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.evaluate(() => {
        for (const type of ["click", "auxclick"])
          document.addEventListener(type, (event) => {
            if (event.target.closest("#open-inbox")) {
              window.preventedInboxNavigation = event.defaultPrevented;
              event.preventDefault();
            }
          });
      });
      for (const options of [{ modifiers: ["Meta"] }, { button: "middle" }]) {
        await page.mouse.move(0, 0);
        await inbox.hover();
        await inbox.click(options);
        await expect(inbox).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect(await page.evaluate(() => window.preventedInboxNavigation)).toBe(false);
      }
      expect(canvas.writes).toEqual([]);
    });

    test("search waits for text composition to finish before changing the displayed selection", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(2);
      await page.clock.install();
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      const queries = [];
      await page.route("**/api/filters", async (route) => {
        queries.push(route.request().postDataJSON().query);
        await route.continue();
      });
      const search = page.locator("#search");
      await search.focus();
      await search.evaluate((node) => {
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        node.value = "Needle widget";
        node.dispatchEvent(
          new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }),
        );
      });
      await page.clock.runFor(1000);
      expect(queries).toEqual([]);
      await expect(page.locator(".mark-read").first()).toBeDisabled();
      await expect(search).toHaveValue("Needle widget");
      await search.evaluate((node) => {
        node.value = "Needle widget 2";
        node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "Needle widget 2" }));
        node.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false, inputType: "insertText" }));
      });
      await page.clock.runFor(250);
      await expect(page.locator(".row")).toHaveCount(1);
      expect(queries).toEqual(["Needle widget 2"]);
      await expect(page.locator(".mark-read")).toBeEnabled();
      expect(canvas.writes).toEqual([]);
    });
  });
}
