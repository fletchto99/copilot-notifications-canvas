import { test, expect } from "./fixtures.mjs";
import { http } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`repository activity order (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    for (const matchGitHubInbox of [true, false]) {
      test(`API order wins over timestamps and retains focus across reordering, inbox matching ${matchGitHubInbox}`, async ({ page, canvas }) => {
        canvas.rows.splice(3);
        for (const [index, row] of canvas.rows.entries()) {
          row.repository.full_name = index === 1 ? "example/alpha" : "example/zulu";
          row.updated_at = `2026-01-${[10, 30, 20][index]}T00:00:00Z`;
        }
        canvas.setRequestHook(args => args.includes("GET") && args.at(-1).startsWith("/notifications?")
          ? http(canvas.rows) : undefined);
        await canvas.preferences.update({ matchGitHubInbox });
        await page.clock.install();
        await page.goto(canvas.url);
        await expect(page.locator(".repo-name")).toHaveText(["example/zulu", "example/alpha"]);
        await expect(page.locator(".row .title")).toHaveText([0, 2, 1].map(index => canvas.rows[index].subject.title));
        const alpha = page.locator('[data-focus-key="repo:example/alpha"]');
        await alpha.click();
        await alpha.focus();
        await expect(alpha).toHaveAttribute("aria-expanded", "false");
        canvas.rows.unshift(canvas.rows.splice(1, 1)[0]);
        const url = new URL(canvas.url);
        const response = await page.request.post(new URL("/api/refresh", url).href, {
          headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin },
          data: { force: true },
        });
        expect(response.status()).toBe(200);
        await page.clock.fastForward(5000);
        await expect(page.locator(".repo-name")).toHaveText(["example/alpha", "example/zulu"]);
        await expect(alpha).toBeFocused();
        await expect(alpha).toHaveAttribute("aria-expanded", "false");
        await expect(page.locator(".repo-group").first().locator(".row")).toBeHidden();
        expect(canvas.writes).toEqual([]);
      });
    }
  });
}
