import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`stable subject controls (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const selector of [".mark-read", ".mark-done", ".repo-read", ".repo-done"]) {
      test(`a status result between pointer down and up preserves ${selector}`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        canvas.rows[0].subject = {
          title: "Synthetic status result", type: "Issue",
          url: "https://api.github.com/repos/example/widgets/issues/1",
        };
        let release;
        const held = new Promise(resolve => { release = resolve; });
        canvas.setRequestHook(async args => {
          if (args.at(-1).endsWith("/issues/1")) await held;
        });
        try {
          await page.clock.install();
          await page.goto(canvas.url);
          await expect(page.locator(".subject-loading")).toHaveCount(1);
          const button = page.locator(selector);
          const original = await button.elementHandle();
          const box = await button.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          try {
            release();
            await page.clock.runFor(1000);
            await expect(page.locator(".subject-open")).toHaveCount(1);
            expect(await original.evaluate(node => node.isConnected)).toBe(true);
          } finally {
            await page.mouse.up();
          }
          await expect.poll(() => canvas.writes).toEqual(["1"]);
          expect(canvas.doneWrites).toEqual(selector.endsWith("done") ? ["1"] : []);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          release();
        }
      });
    }
  });
}
