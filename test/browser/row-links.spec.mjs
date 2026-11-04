import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`whole-row links (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    test("Tab skips the populated inbox wrapper but can reach an empty panel", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      const panel = page.getByRole("tabpanel");
      await expect(panel).toHaveAttribute("tabindex", "-1");
      await page.locator("#collapse").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator(".repo-toggle").first()).toBeFocused();
      canvas.rows.splice(0);
      await page.locator("#force-refresh").click();
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(panel).toHaveAttribute("tabindex", "0");
      await page.locator("#settings-toggle").focus();
      await page.keyboard.press("Tab");
      await expect(panel).toBeFocused();
      expect(canvas.writes).toEqual([]);
    });

    for (const focusElsewhere of [false, true]) {
      test(`initial loading ${focusElsewhere ? "preserves focus moved to Search" : "hands panel focus to the first group"}`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        let release;
        const held = new Promise(resolve => { release = resolve; });
        canvas.setRequestHook(args => args.includes("GET") && args.at(-1).startsWith("/notifications") ? held : undefined);
        try {
          await page.goto(canvas.url);
          await expect(page.locator("#theme")).toBeEnabled();
          const panel = page.getByRole("tabpanel");
          await page.locator("#collapse").focus();
          await page.keyboard.press("Tab");
          await expect(panel).toBeFocused();
          if (focusElsewhere) await page.getByRole("searchbox").focus();
          release();
          await expect(page.locator(".row")).toHaveCount(2);
          await expect(panel).toHaveAttribute("tabindex", "-1");
          await expect(panel).not.toBeFocused();
          await expect(focusElsewhere ? page.getByRole("searchbox") : page.locator(".repo-toggle").first()).toBeFocused();
          expect(canvas.writes).toEqual([]);
        } finally {
          release();
        }
      });
    }

    for (const width of [320, 960]) {
      test(`a second click in the retired Read position cannot open a row at ${width}px`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        canvas.rows[0].subject.title = "Short synthetic title";
        canvas.rows[1].unread = false;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        await page.evaluate(() => {
          window.rowOpenAttempts = [];
          document.addEventListener("click", event => {
            const link = event.target.closest(".row-link");
            if (link) {
              event.preventDefault();
              window.rowOpenAttempts.push(link.dataset.focusKey);
            }
          });
        });
        const row = page.locator(".row").first();
        const before = await row.locator(".mark-read").boundingBox();
        const x = before.x + before.width / 2;
        const y = before.y + before.height / 2;
        await page.mouse.click(x, y);
        await expect(row).toHaveClass("row read");
        await expect(row.locator(".mark-read")).toHaveCount(0);
        await expect(row.locator(".row-actions")).toHaveCSS("width", "68px");
        const actions = await row.locator(".row-actions").boundingBox();
        const link = await row.locator(".row-link").boundingBox();
        expect(actions.y).toBeCloseTo(link.y);
        expect(actions.height).toBeCloseTo(link.height);
        for (const point of [
          { x, y },
          { x: before.x + 2, y: before.y + 2 },
          { x: before.x + before.width - 2, y: before.y + before.height - 2 },
        ]) {
          expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".row-link")), point)).toBe(false);
        }
        await page.mouse.click(x, y);
        expect(await page.evaluate(() => window.rowOpenAttempts)).toEqual([]);
        expect(canvas.writes).toEqual(["1"]);
        await row.locator(".title").click();
        expect(await page.evaluate(() => window.rowOpenAttempts)).toEqual(["thread:1"]);
        await row.locator(".mark-done").click();
        await expect(page.locator(".row")).toHaveCount(1);
        expect(await page.evaluate(() => window.rowOpenAttempts)).toEqual(["thread:1"]);
        expect(canvas.writes).toEqual(["1", "1"]);
        expect(canvas.doneWrites).toEqual(["1"]);
        expect(canvas.deliveries).toEqual([]);
      });

      test(`row surfaces navigate natively without activating Read or Done at ${width}px`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        canvas.rows[0].subject = {
          title: "Open the linked notification", type: "Issue",
          url: "https://api.github.com/repos/example/widgets/issues/42",
        };
        canvas.rows[1].unread = false;
        await page.setViewportSize({ width, height: 900 });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        const row = page.locator(".row").first();
        const link = row.getByRole("link", { name: /^Open the linked notification / });
        await expect(link).toHaveAttribute("href", "https://github.com/example/widgets/issues/42");
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        await expect(link.locator("button, a")).toHaveCount(0);
        const box = await row.boundingBox();
        const linkBox = await link.boundingBox();
        expect(linkBox.x).toBeCloseTo(box.x);
        expect(linkBox.width).toBeCloseTo(box.width);
        expect(linkBox.y + linkBox.height).toBeCloseTo(box.y + box.height);
        await link.hover();
        await expect(link).toHaveCSS("text-decoration-line", "none");
        await expect(link.locator(".title")).toHaveCSS("text-decoration-line", "none");
        await expect(link.locator("time")).toHaveAttribute("title", /.+/);

        const destination = new URL("/synthetic-row-destination", canvas.url).href;
        await page.context().route(destination, route => route.fulfill({
          contentType: "text/html", body: "<!doctype html><title>Synthetic destination</title><p>Opened locally.</p>",
        }));
        await link.evaluate((node, url) => { node.href = url; }, destination);
        const open = async activate => {
          const opened = page.context().waitForEvent("page");
          await activate();
          const popup = await opened;
          await popup.waitForLoadState();
          expect(popup.url()).toBe(destination);
          await popup.close();
          await page.bringToFront();
          expect(canvas.writes).toEqual([]);
        };
        await page.locator(".repo-done").focus();
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
        await expect(link).toHaveCSS("outline-style", "solid");
        await expect(link).toHaveCSS("outline-offset", "-3px");
        await open(() => link.press("Enter"));
        await open(() => page.mouse.click(box.x + 4, box.y + 4));
        await open(() => link.locator(".metadata").click());
        await open(() => page.mouse.click(box.x + box.width - 4, box.y + box.height - 4, { button: "middle" }));
        await open(() => link.locator(".title").click({ modifiers: ["ControlOrMeta"] }));

        let unexpectedPages = 0;
        const onPage = () => { unexpectedPages++; };
        page.context().on("page", onPage);
        await row.locator(".mark-read").click();
        await expect(row).toHaveClass("row read");
        await expect(row.locator(".mark-read")).toHaveCount(0);
        await row.locator(".mark-done").click();
        await expect(page.locator(".row")).toHaveCount(1);
        expect(canvas.writes).toEqual(["1", "1"]);
        expect(canvas.doneWrites).toEqual(["1"]);
        expect(unexpectedPages).toBe(0);
        page.context().off("page", onPage);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      });
    }
  });
}
