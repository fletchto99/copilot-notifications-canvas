import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";
import { octicons } from "../../src/renderer/octicons.mjs";

const resolved = { closed: true, isAnswered: false, stateReason: "RESOLVED" };
const discussion = (id, subjectDetails, url = `https://api.github.com/repos/example/widgets/discussions/${id}`) =>
  thread(id, { subject: { type: "Discussion", title: `Synthetic discussion ${id}`, url }, subjectDetails });

for (const packaged of [false, true]) {
  test.describe(`discussion states (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("closed discussions have purple checkmarked icons in every view and theme", async ({ page, canvas }, testInfo) => {
      const cases = [
        [resolved, "Closed", "closed"],
        [{ closed: false, isAnswered: false, stateReason: null }, "Open", "open"],
        [{ closed: false, isAnswered: true, stateReason: null }, "Answered", "answered"],
        [{ ...resolved, stateReason: "DUPLICATE" }, "Closed (duplicate)", "duplicate"],
        [{ ...resolved, stateReason: "OUTDATED" }, "Closed (outdated)", "outdated"],
        [{ ...resolved, stateReason: null }, "Closed", "closed"],
        [{ closed: false, isAnswered: null, stateReason: "REOPENED" }, "Open", "open"],
      ];
      canvas.rows.splice(0, canvas.rows.length,
        ...cases.map(([details], index) => discussion(String(index + 1), details)),
        discussion("8", null, null),
        thread("9", { subject: { type: "Issue", title: "Synthetic closed issue",
          url: "https://api.github.com/repos/example/widgets/issues/9" }, subjectDetails: { state: "closed" } }),
        thread("10", { subject: { type: "Issue", title: "Synthetic open issue",
          url: "https://api.github.com/repos/example/widgets/issues/10" }, subjectDetails: { state: "open" } }));
      await page.goto(canvas.url);
      const fields = page.locator('.notification-subject[data-subject-type="Discussion"]');
      await expect(fields).toHaveCount(8);
      for (const [index, [, label, state]] of cases.entries()) {
        await expect(fields.nth(index)).toHaveClass(`notification-subject subject-${state}`);
        await expect(fields.nth(index).getByRole("img")).toHaveAttribute("aria-label", new RegExp(`^Discussion: ${label.replaceAll("(", "\\(").replaceAll(")", "\\)")}\\. Checked `));
        await expect(fields.nth(index).locator(".notification-type")).toHaveText("Discussion");
        await expect(page.locator(`[data-focus-key="thread:${index + 1}"]`)).toHaveAttribute("href",
          `https://github.com/example/widgets/discussions/${index + 1}`);
      }
      await expect(fields.nth(7).getByRole("img")).toHaveAttribute("aria-label", /Discussion: Status unavailable/);
      for (const theme of ["light", "dark"]) {
        for (const groupBy of ["repo", "none", "date"]) {
          await page.locator("#settings-toggle").click();
          await page.locator("#theme").selectOption(theme);
          await page.locator("#group-by").selectOption(groupBy);
          await expect(page.locator("#group-by")).toBeEnabled();
          await page.keyboard.press("Escape");
          const colors = theme === "light"
            ? { closed: "rgb(130, 80, 223)", answered: "rgb(26, 127, 55)", muted: "rgb(101, 109, 118)" }
            : { closed: "rgb(171, 125, 248)", answered: "rgb(63, 185, 80)", muted: "rgb(145, 152, 161)" };
          for (const index of [0, 5]) await expect(fields.nth(index).getByRole("img")).toHaveCSS("color", colors.closed);
          await expect(fields.nth(2).getByRole("img")).toHaveCSS("color", colors.answered);
          for (const index of [1, 3, 4, 6, 7]) await expect(fields.nth(index).getByRole("img")).toHaveCSS("color", colors.muted);
          const shapes = await fields.evaluateAll(nodes => nodes.map(node =>
            [...node.querySelectorAll("path")].map(path => path.getAttribute("d")).join(" ")));
          expect(shapes[0]).toBe(octicons["discussion-closed"].paths.join(" "));
          expect(shapes[2]).toBe(octicons["check-circle"].paths.join(" "));
          expect(new Set(shapes).size).toBe(5);
          for (const width of [320, 960]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
            for (const field of await fields.all()) {
              await expect(field.getByRole("img")).not.toHaveAttribute("title");
              await expect(field.locator("svg")).toHaveCSS("width", "16px");
            }
          }
          expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
        }
        await page.screenshot({ path: testInfo.outputPath(`discussions-${theme}.png`), fullPage: true });
      }
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(7);
      expect(canvas.requests.some(path => path.includes("/discussions/"))).toBe(false, "Discussion status uses GraphQL, not a nonexistent REST endpoint");
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("collapsed discussions refresh authorship and state, while failed lookups preserve their last known icon", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, discussion("1", resolved));
      await page.goto(canvas.url);
      const icon = page.locator(".subject-icon");
      await expect(icon).toHaveAttribute("aria-label", /^Discussion: Closed\. Checked /);
      await page.locator(".repo-toggle").click();
      await expect(page.locator(".repo-items")).toBeHidden();
      canvas.rows[0].subjectDetails = { closed: false, isAnswered: false, stateReason: "REOPENED" };
      await page.locator("#force-refresh").click();
      await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
      await expect(icon).toHaveAttribute("aria-label", /^Discussion: Open\. Checked /);
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(2);
      await page.locator(".repo-toggle").click();
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(2);
      canvas.setRequestHook(args => args.at(-1) === "graphql" ? http({}, {}, 403) : undefined);
      await page.locator("#force-refresh").click();
      await expect(icon).toHaveAttribute("aria-label", /Discussion: Open\. Cached result; refresh failed\./);
      await expect(page.locator(".subject-open")).toHaveCount(1);
      await expect(page.locator(".subject-loading")).toHaveCount(0);
      await expect(page.locator(".row-link")).toHaveAttribute("href", "https://github.com/example/widgets/discussions/1");
      expect(canvas.writes).toEqual([]);
    });
  });
}
