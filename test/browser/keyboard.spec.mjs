import AxeBuilder from "@axe-core/playwright";
import { test, expect, openSettings } from "./fixtures.mjs";

const rowLink = (page, id) => page.locator(`[data-focus-key="thread:${id}"]`);

for (const packaged of [false, true]) {
  test.describe(`keyboard shortcuts (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const groupBy of ["repo", "date", "none"]) {
      test(`j/k follow visible ${groupBy} order, skip collapsed groups and reveal offscreen rows`, async ({ page, canvas }) => {
        canvas.rows.splice(12);
        canvas.rows[0].updated_at = "2026-01-09T12:00:00Z";
        await canvas.preferences.update({ groupBy });
        await page.setViewportSize({ width: 360, height: 500 });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(12);
        await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
        const ids = await page.locator(".row-link").evaluateAll(nodes => nodes.map(node => node.dataset.threadId));
        await page.locator("#collapse").focus();
        for (const id of ids) {
          await page.keyboard.press("j");
          const link = rowLink(page, id);
          await expect(link).toBeFocused();
          await expect(link).toBeInViewport({ ratio: 0.9 });
          await expect(link).toHaveCSS("outline-style", "solid");
        }
        await page.keyboard.press("j");
        await expect(rowLink(page, ids.at(-1))).toBeFocused();
        for (const id of ids.slice(0, -1).reverse()) {
          await page.keyboard.press("k");
          await expect(rowLink(page, id)).toBeFocused();
        }
        await page.keyboard.press("k");
        await expect(rowLink(page, ids[0])).toBeFocused();
        await page.locator("#collapse").focus();
        await page.keyboard.press("k");
        await expect(rowLink(page, ids.at(-1))).toBeFocused();
        if (groupBy !== "none") {
          await page.locator(".repo-toggle").first().click();
          const firstVisible = page.locator(".repo-items:not([hidden]) .row-link").first();
          await page.keyboard.press("j");
          await expect(firstVisible).toBeFocused();
        }
        await page.locator("#collapse").focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("j");
        await expect(page.locator("#collapse")).toBeFocused();
        expect(canvas.writes).toEqual([]);
        expect(canvas.requests.filter(path => path.startsWith("/notifications?"))).toHaveLength(1);
        expect(canvas.deliveries).toEqual([]);
      });
    }

    for (const matchGitHubInbox of [true, false]) {
      test(`row actions require Shift for Done and preserve focus in ${matchGitHubInbox ? "All" : "Unread only"}`, async ({ page, canvas }) => {
        canvas.rows.splice(3);
        await canvas.preferences.update({ matchGitHubInbox, groupBy: "none" });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(3);
        await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
        await page.locator("#collapse").focus();
        await page.keyboard.press("Shift+KeyE");
        expect(canvas.writes).toEqual([]);
        await page.keyboard.press("j");
        await expect(rowLink(page, "1")).toBeFocused();
        await page.keyboard.press("e");
        await page.keyboard.press("Shift+KeyI");
        expect(canvas.writes).toEqual([]);
        await page.keyboard.down("i");
        await expect.poll(() => canvas.writes).toEqual(["1"]);
        await expect(rowLink(page, "2")).toBeFocused();
        await page.keyboard.down("i");
        await page.keyboard.up("i");
        expect(canvas.writes).toEqual(["1"]);
        if (matchGitHubInbox) {
          await expect(page.locator('[data-focus-key="read:1"]')).toHaveCount(0);
          await rowLink(page, "1").focus();
          await page.keyboard.press("i");
          expect(canvas.writes).toEqual(["1"]);
          await rowLink(page, "2").focus();
        }
        await page.keyboard.down("Shift");
        await page.keyboard.down("KeyE");
        await expect.poll(() => canvas.doneWrites).toEqual(["2"]);
        await expect(rowLink(page, "3")).toBeFocused();
        await page.keyboard.down("KeyE");
        await page.keyboard.up("KeyE");
        await page.keyboard.up("Shift");
        expect(canvas.doneWrites).toHaveLength(1);
        await page.keyboard.press("Shift+KeyE");
        await expect(page.locator(".row")).toHaveCount(matchGitHubInbox ? 1 : 0);
        if (matchGitHubInbox) {
          await expect(rowLink(page, "1")).toBeFocused();
          await page.keyboard.press("Shift+KeyE");
        }
        await expect(page.locator(".row")).toHaveCount(0);
        await expect(page.getByRole("searchbox")).toBeFocused();
        expect(canvas.deliveries).toEqual([]);
      });
    }

    test("native Enter opens only the focused link and typing, modifiers and composition never trigger actions", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
      await page.evaluate(() => {
        window.openedRows = [];
        document.addEventListener("click", event => {
          const link = event.target.closest(".row-link");
          if (link) {
            event.preventDefault();
            window.openedRows.push(link.dataset.threadId);
          }
        });
      });
      await page.locator("#collapse").focus();
      await page.keyboard.press("j");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.openedRows)).toEqual(["1"]);
      for (const options of [
        { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 },
      ]) {
        for (const [key, shiftKey] of [["j", false], ["k", false], ["i", false], ["E", true], ["/", false], ["?", true]]) {
          const prevented = await page.evaluate(({ key, shiftKey, options }) => !document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown", { key, shiftKey, ...options, bubbles: true, cancelable: true }),
          ), { key, shiftKey, options });
          expect(prevented).toBe(false);
        }
      }
      await expect(rowLink(page, "1")).toBeFocused();
      await page.keyboard.press("/");
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.keyboard.type("jk/i?E");
      await expect(page.getByRole("searchbox")).toHaveValue("jk/i?E");
      await page.keyboard.press("Shift+KeyE");
      await expect(page.getByRole("searchbox")).toHaveValue("jk/i?EE");
      await expect(page.locator("#shortcuts-dialog")).not.toBeVisible();
      await page.getByRole("searchbox").fill("Needle widget 2");
      await expect(page.locator(".row")).toHaveCount(1);
      await page.locator("#collapse").focus();
      await page.keyboard.press("j");
      await expect(rowLink(page, "2")).toBeFocused();
      await openSettings(page);
      await expect(page.locator("#group-by")).toBeEnabled();
      await page.locator("#group-by").focus();
      await page.keyboard.press("i");
      await page.keyboard.press("Shift+KeyE");
      await page.keyboard.press("?");
      await expect(page.locator("#shortcuts-dialog")).not.toBeVisible();
      await expect(page.locator("#group-by")).toBeFocused();
      expect(canvas.writes).toEqual([]);
    });

    test("help is accessible, modal, viewport-safe and returns focus after live row replacement", async ({ page, canvas }, testInfo) => {
      canvas.rows.splice(3);
      await page.setViewportSize({ width: 320, height: 500 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
      await expect(page.locator(".toolbar > #shortcuts-control + #settings")).toHaveCount(1);
      await expect(page.locator("#shortcuts-toggle")).toHaveText("");
      await expect(page.locator("#shortcuts-toggle svg")).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator("#shortcuts-toggle")).toHaveAccessibleDescription("Keyboard shortcuts (?)");
      await expect(page.locator(".status-line button")).toHaveText(["Collapse all"]);
      await rowLink(page, "1").focus();
      await page.keyboard.press("?");
      const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#shortcuts-close")).toBeFocused();
      for (let index = 0; index < 3; index++) {
        await page.keyboard.press("Tab");
        // Native dialogs may tab through browser chrome and their scroll container, but never the inbox.
        expect(await page.evaluate(() => !document.hasFocus() ||
          document.querySelector("#shortcuts-dialog").contains(document.activeElement))).toBe(true);
      }
      await page.locator("#shortcuts-close").focus();
      for (const key of ["j", "i", "Shift+KeyE", "/"]) await page.keyboard.press(key);
      await expect(dialog).toBeVisible();
      expect(canvas.writes).toEqual([]);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(500);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("keyboard-guide.png") });
      canvas.rows[0].subject.title = "Updated synthetic row while help is open";
      // Trigger the real refresh handler without changing focus out of the modal.
      await page.locator("#force-refresh").evaluate(button => button.click());
      await expect(rowLink(page, "1")).toContainText("Updated synthetic row");
      await expect(page.locator("#shortcuts-close")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(rowLink(page, "1")).toBeFocused();
      await page.locator("#shortcuts-toggle").click();
      await page.locator("#shortcuts-close").click();
      await expect(page.locator("#shortcuts-toggle")).toBeFocused();
      expect(canvas.deliveries).toEqual([]);
    });

    test("Enter from search focuses the settled result without opening it on held-key repeats", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
      await page.evaluate(() => {
        window.openedRows = [];
        document.addEventListener("click", event => {
          const link = event.target.closest(".row-link");
          if (link) {
            event.preventDefault();
            window.openedRows.push(link.dataset.threadId);
          }
        });
      });
      await rowLink(page, "1").focus();
      await page.keyboard.press("/");
      const search = page.getByRole("searchbox");
      await search.fill("Needle widget 2");
      await page.keyboard.down("Enter");
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(rowLink(page, "2")).toBeFocused();
      await expect(search).toHaveValue("Needle widget 2");
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      expect(await page.evaluate(() => window.openedRows)).toEqual([]);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.openedRows)).toEqual(["2"]);
      await page.keyboard.press("i");
      await expect(page.locator(".row")).toHaveClass("row read");
      await expect(rowLink(page, "2")).toBeFocused();
      expect(canvas.writes).toEqual(["2"]);
      expect(canvas.doneWrites).toEqual([]);
    });

    for (const cancellation of ["none", "edit", "focus"]) {
      test(`search Enter waits for in-flight filters (${cancellation})`, async ({ page, canvas }) => {
        canvas.rows.splice(3);
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(3);
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route("**/api/filters", async route => {
          await held;
          await route.continue();
        });
        const search = page.getByRole("searchbox");
        try {
          const started = page.waitForRequest(request => new URL(request.url()).pathname === "/api/filters");
          await search.fill("Needle widget 2");
          await started;
          await page.keyboard.press("Enter");
          await expect(search).toBeFocused();
          await expect(page.locator(".row")).toHaveCount(3);
          if (cancellation === "edit") await search.fill("Needle tool");
          if (cancellation === "focus") {
            await page.locator("#force-refresh").focus();
            await search.focus();
          }
          release();
          await expect(page.locator(".row")).toHaveCount(1);
          await expect(rowLink(page, cancellation === "edit" ? "3" : "2")).toBeVisible();
          await expect(cancellation === "none" ? rowLink(page, "2") : search).toBeFocused();
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          release();
        }
      });
    }

    test("search Enter stays in search for no matches and collapsed results", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      const search = page.getByRole("searchbox");
      await search.fill("No matching synthetic notification");
      await page.keyboard.press("Enter");
      await expect(page.locator(".row")).toHaveCount(0);
      await expect(search).toBeFocused();
      await search.fill("");
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(search).toBeFocused();
      await page.locator("#collapse").click();
      await search.focus();
      await page.keyboard.press("Enter");
      await expect(search).toBeFocused();
      await expect(page.locator(".row-link").first()).toBeHidden();
      expect(canvas.writes).toEqual([]);
    });

    test("disabling character shortcuts persists across reloads, hides help and preserves native navigation", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await openSettings(page);
      const toggle = page.getByRole("switch", { name: "Keyboard shortcuts", exact: true });
      await expect(page.locator("#auto-open + #keyboard-shortcuts + #desktop-notifications")).toHaveCount(1);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(toggle).toBeEnabled();
      await page.locator("#auto-open").focus();
      await page.keyboard.press("Tab");
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("#desktop-notifications")).toBeFocused();
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(page.locator("#shortcuts-control")).toBeHidden();
      expect((await canvas.preferences.read()).keyboardShortcuts).toBe(false);
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#keyboard-shortcuts")).toBeEnabled();
      await expect(page.locator("#shortcuts-toggle")).toBeHidden();
      await page.locator("#force-refresh").focus();
      await page.keyboard.press("Tab");
      await expect(page.locator("#settings-toggle")).toBeFocused();
      await rowLink(page, "1").focus();
      for (const key of ["j", "k", "/", "?", "i", "Shift+KeyE"]) await page.keyboard.press(key);
      await expect(rowLink(page, "1")).toBeFocused();
      await expect(page.locator("#groups")).not.toHaveAttribute("aria-keyshortcuts");
      await page.keyboard.press("Tab");
      await expect(page.locator('[data-focus-key="read:1"]')).toBeFocused();
      await page.getByRole("searchbox").focus();
      await page.keyboard.press("Enter");
      await expect(rowLink(page, "1")).toBeFocused();
      await openSettings(page);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("#shortcuts-toggle")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator("#shortcuts-toggle").click();
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await page.keyboard.press("Escape");
      await rowLink(page, "1").focus();
      await page.keyboard.press("j");
      await expect(rowLink(page, "2")).toBeFocused();
      expect(canvas.writes).toEqual([]);
    });

    test("shortcut writes can run on separate rows while pending filters still block new actions", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(3);
      let release;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(args => args.includes("DELETE") ? held : undefined);
      try {
        await rowLink(page, "1").focus();
        await page.keyboard.press("Shift+KeyE");
        await expect(page.locator('[data-focus-key="done:1"]')).toHaveAttribute("aria-busy", "true");
        await page.keyboard.press("j");
        await page.keyboard.press("Shift+KeyE");
        await expect(page.locator('[data-focus-key="done:2"]')).toHaveAttribute("aria-busy", "true");
        await page.keyboard.press("i");
        await page.keyboard.press("/");
        await page.getByRole("searchbox").fill("Needle tool");
        await rowLink(page, "3").focus();
        await page.keyboard.press("Shift+KeyE");
        await page.keyboard.press("/");
        release();
        await expect(page.locator(".row")).toHaveCount(1);
        await expect(page.getByRole("searchbox")).toBeFocused();
        await expect.poll(() => canvas.writes).toEqual(["1", "2"]);
        expect(canvas.doneWrites).toEqual(["1", "2"]);
      } finally {
        release();
      }
    });
  });
}
