import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`stable subject controls (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const selector of [".mark-read", ".mark-done", ".repo-read", ".repo-done", ".subject-icon", ".notification-type"]) {
      test(`a status result between pointer down and up preserves ${selector}`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        canvas.rows[0].subject = {
          title: "Synthetic status result", type: "Issue",
          url: "https://api.github.com/repos/example/widgets/issues/1",
        };
        canvas.rows[0].authoredByViewer = true;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        canvas.setRequestHook(async args => {
          if (args.at(-1).endsWith("/issues/1")) await held;
        });
        const rowLink = [".subject-icon", ".notification-type"].includes(selector);
        const destination = new URL("/synthetic-row-destination", canvas.url).href;
        try {
          if (rowLink) {
            await page.context().route(destination, route => route.fulfill({
              contentType: "text/html", body: "<!doctype html><title>Synthetic destination</title>",
            }));
            await page.route(/\/api\/(?:state|refresh)$/, async route => {
              const response = await route.fetch();
              const state = await response.json();
              for (const group of state.groups ?? []) {
                for (const item of group.items) item.url = destination;
              }
              await route.fulfill({ response, json: state });
            });
          }
          await page.clock.install();
          await page.goto(canvas.url);
          await expect(page.locator(".subject-loading")).toHaveCount(1);
          const button = page.locator(selector);
          const original = await button.elementHandle();
          const box = await button.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          let opened;
          try {
            release();
            await page.clock.runFor(1000);
            await expect(page.locator(".subject-open")).toHaveCount(1);
            await expect(page.locator(".notification-mine:visible")).toHaveCount(1);
            expect(await original.evaluate(node => node.isConnected)).toBe(true);
            if (rowLink) opened = page.context().waitForEvent("page");
          } finally {
            await page.mouse.up();
          }
          if (rowLink) {
            const popup = await opened;
            await expect(popup).toHaveURL(destination);
            await popup.close();
            expect(canvas.writes).toEqual([]);
          } else {
            await expect.poll(() => canvas.writes).toEqual(["1"]);
          }
          expect(canvas.doneWrites).toEqual(selector.endsWith("done") ? ["1"] : []);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          release();
        }
      });
    }
  });
}
