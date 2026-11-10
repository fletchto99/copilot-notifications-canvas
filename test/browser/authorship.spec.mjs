import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`authored notifications (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("Mine resolves hidden rows, explains incomplete counts, and limits search and Done to confirmed matches", async ({ page, canvas }) => {
      const types = ["PullRequest", "Issue", "Discussion", "Issue", "PullRequest"];
      canvas.rows.splice(0, canvas.rows.length, ...types.map((type, index) => {
        const id = String(index + 1);
        const resource = { PullRequest: "pulls", Issue: "issues", Discussion: "discussions" }[type];
        return thread(id, {
          reason: index === 4 ? "author" : "mention",
          unread: index !== 1,
          subject: { type, title: `Synthetic authored item ${id}`, url: `https://api.github.com/repos/example/widgets/${resource}/${id}` },
          authoredByViewer: index < 3,
        });
      }));
      let release;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(async args => {
        if (args.at(-1) === "graphql" && args.includes("number=3")) await held;
        if (args.at(-1).endsWith("/issues/4")) return http({}, {}, 403);
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(5);
        await page.getByRole("button", { name: "Collapse all", exact: true }).click();
        await expect(page.locator("#attention-mine")).toHaveText("Mine (2+)");
        await page.locator("#attention-mine").click();
        await expect(page.locator("#authorship-status")).toContainText("Checking authorship");
        await expect(page.locator("#authorship-status")).toContainText("Authorship unavailable");
        release();
        await expect(page.locator("#attention-mine")).toHaveText("Mine (3+)");
        await expect(page.locator("#authorship-status")).not.toContainText("Checking authorship");
        await page.getByRole("button", { name: "Expand all", exact: true }).click();
        await expect(page.locator(".row")).toHaveCount(3);
        const markers = page.locator(".notification-mine:visible");
        await expect(markers).toHaveCount(3);
        await expect(markers.first()).toHaveCSS("font-style", "italic");
        expect(await markers.evaluateAll(nodes => nodes.map(node => ({
          before: node.parentElement.previousElementSibling.firstElementChild.textContent,
          after: node.parentElement.nextElementSibling.firstElementChild.tagName,
        })))).toEqual(Array(3).fill({ before: "mention", after: "TIME" }));
        await expect(page.locator('[data-focus-key="thread:5"]')).toHaveCount(0);
        await expect(page.locator('[data-focus-key="thread:4"]')).toHaveCount(0);
        await expect(page.locator('[data-focus-key="read:2"]')).toBeDisabled();
        await page.getByRole("searchbox").fill("item 2");
        await expect(page.locator(".row")).toHaveCount(1);
        await expect(page.locator("#attention-mine")).toHaveText("Mine (3+)");
        const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(accessibility.violations).toEqual([]);
        await page.locator(".repo-done").click();
        await expect.poll(() => canvas.doneWrites).toEqual(["2"]);
        await expect(page.locator(".row")).toHaveCount(0);
        await expect(page.locator("#attention-mine")).toHaveText("Mine (2+)");
        expect(canvas.rows.find(row => row.id === "4").unread).toBe(true);
        expect(canvas.rows.find(row => row.id === "5").unread).toBe(true);
        expect(canvas.deliveries).toEqual([]);
      } finally {
        release();
      }
    });

    test("a confirmed empty Mine tab hides, while unknown authorship remains available", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      await expect(page.locator("#attention-mine")).toHaveText("Mine (0)");
      await expect(page.locator("#attention-mine")).toBeHidden();
      canvas.rows[0].subject.url = null;
      await page.locator("#force-refresh").click();
      await expect(page.locator("#attention-mine")).toHaveText("Mine (0+)");
      await expect(page.locator("#attention-mine")).toBeVisible();
      await page.locator("#attention-mine").click();
      await expect(page.locator("#authorship-status")).toContainText("Authorship unavailable for 1 loaded item.");
      await expect(page.locator(".row")).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
    });
  });
}
