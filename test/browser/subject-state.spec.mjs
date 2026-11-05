import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`subject state icons (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("state icons remain accessible in all views, themes, and narrow panels", async ({ page, canvas }, testInfo) => {
      const cases = [
        ["Issue", { state: "open" }, "Open", "subject-open"],
        ["Issue", { state: "closed", state_reason: "completed" }, "Closed", "subject-closed"],
        ["Issue", { state: "closed", state_reason: "not_planned" }, "Closed (not planned)", "subject-not-planned"],
        ["Issue", { state: "closed", state_reason: "duplicate" }, "Closed (duplicate)", "subject-duplicate"],
        ["PullRequest", { state: "open", merged: false, draft: false }, "Open", "subject-open"],
        ["PullRequest", { state: "open", merged: false, draft: true }, "Draft", "subject-draft"],
        ["PullRequest", { state: "closed", merged: false, draft: false }, "Closed", "subject-closed"],
        ["PullRequest", { state: "closed", merged: true, draft: false }, "Merged", "subject-merged"],
        ["PullRequest", { state: "open", merged: false, draft: false }, "In merge queue", "subject-merge-queued"],
        ["CheckSuite", { status: "completed", conclusion: "success" }, "Passing", "subject-success"],
        ["CheckSuite", { status: "completed", conclusion: "failure" }, "Failed", "subject-failure"],
        ["CheckSuite", { status: "in_progress", conclusion: null }, "In progress", "subject-in-progress"],
        ["CheckSuite", { status: "completed", conclusion: "skipped" }, "Skipped", "subject-skipped"],
        ["CheckSuite", null, "Failed", "subject-failure"],
        ["CheckSuite", null, "Passing", "subject-success"],
      ];
      canvas.rows.splice(0, canvas.rows.length, ...cases.map(([type, subjectDetails], index) => thread(String(index + 1), {
        unread: index % 2 === 0,
        subject: { type, title: !subjectDetails ? `Synthetic build workflow run ${index === 13 ? "failed" : "succeeded"} for main`
          : `Synthetic ${type === "Issue" ? "issue" : type === "CheckSuite" ? "check suite" : "pull request"} ${index + 1}`,
        url: !subjectDetails ? null
          : `https://api.github.com/repos/example/widgets/${type === "Issue" ? "issues" : type === "CheckSuite" ? "check-suites" : "pulls"}/${index + 1}` },
        subjectDetails, mergeQueued: index === 8,
      })));
      const expectedLabels = cases.map(([type, , label]) => `${type.replace(/([a-z])([A-Z])/g, "$1 $2")}: ${label}`);
      const labels = () => page.locator(".subject-icon").evaluateAll(nodes =>
        nodes.map(node => node.getAttribute("aria-label").split(".")[0]));
      await page.setViewportSize({ width: 960, height: 1800 });
      await page.goto(canvas.url);
      await expect.poll(labels, { timeout: 15_000 }).toEqual(expectedLabels);
      await expect(page.locator(".subject-state")).toHaveCount(0);
      await expect(page.locator(".notification-subject")).toHaveText(cases.map(([type], index) =>
        `${type.replace(/([a-z])([A-Z])/g, "$1 $2")}${type === "CheckSuite" ? "" : ` #${index + 1}`}`));
      for (const [index, [, , , css]] of cases.entries()) {
        const row = page.locator(".row").nth(index);
        await expect(row.locator(".notification-subject")).toHaveClass(`notification-subject ${css}`);
        await expect(row.locator(".subject-icon svg")).toHaveAttribute("aria-hidden", "true");
        await expect(row.locator(".subject-icon")).toHaveAttribute("role", "img");
        await expect(row.locator(".subject-icon")).not.toHaveAttribute("title");
        await expect(row.locator(".dot")).toHaveCSS("visibility", index % 2 === 0 ? "visible" : "hidden");
      }
      await expect(page.locator(".subject-icon").nth(13)).toHaveAttribute("aria-label", /Reported by this notification; may not reflect a later rerun/);
      const shapes = await page.locator('.notification-subject[data-subject-type="PullRequest"] path')
        .evaluateAll(paths => paths.map(path => path.getAttribute("d")));
      expect(new Set(shapes).size).toBe(5);
      for (const theme of ["light", "dark"]) {
        for (const groupBy of ["repo", "none", "date"]) {
          await page.locator("#settings-toggle").click();
          await page.locator("#theme").selectOption(theme);
          await page.locator("#group-by").selectOption(groupBy);
          await page.keyboard.press("Escape");
          await expect.poll(labels).toEqual(expectedLabels);
          for (const width of [320, 960]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          }
          const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
          expect(results.violations).toEqual([]);
        }
        await page.screenshot({ path: testInfo.outputPath(`subject-states-${theme}.png`), fullPage: true });
      }
      const colors = await page.locator(".subject-icon").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
      expect(colors[0]).toBe(colors[4]);
      expect(colors[1]).toBe(colors[7]);
      expect(colors[2]).toBe(colors[5]);
      expect(new Set([colors[0], colors[1], colors[2], colors[6]]).size).toBe(4);
      expect(colors[8]).toBe(colors[7]);
      expect(colors[9]).toBe(colors[0]);
      expect(colors[10]).toBe(colors[6]);
      expect(colors[13]).toBe(colors[10]);
      expect(colors[14]).toBe(colors[9]);
      expect(colors[11]).not.toBe(colors[2]);
      expect(canvas.requests.filter(path => path.startsWith("/repos/example/") && !path.includes("/actions/runs?"))).toHaveLength(cases.length - 2);
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(2);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("slow or unavailable status never blocks the inbox, and Force refresh updates state", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      for (const [index, row] of canvas.rows.entries()) row.subject = {
        type: "PullRequest", title: `Synthetic PR ${index + 1}`,
        url: `https://api.github.com/repos/example/widgets/pulls/${index + 1}`,
      };
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let requests = 0;
      canvas.setRequestHook(async args => {
        if (!args.at(-1).startsWith("/repos/example/widgets/pulls/")) return;
        requests++;
        if (args.at(-1).endsWith("/2")) return http({}, {}, 404);
        if (requests === 1) {
          await held;
          return http({ state: "open", merged: false, draft: true });
        }
        return http({ state: "closed", merged: true, draft: false });
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        await expect(page.locator(".subject-icon").first()).toHaveAttribute("aria-label", "Pull Request: Loading status");
        await expect(page.locator(".mark-read").first()).toBeEnabled();
        release();
        await expect(page.locator(".subject-icon").first()).toHaveAttribute("aria-label", /^Pull Request: Draft\. Checked /, { timeout: 15_000 });
        await expect(page.locator(".subject-icon").nth(1)).toHaveAttribute("aria-label", /Status unavailable/, { timeout: 15_000 });
        await page.locator("#force-refresh").click();
        await expect(page.locator(".subject-icon").first()).toHaveAttribute("aria-label", /^Pull Request: Merged\. Checked /, { timeout: 15_000 });
        await expect(page.locator(".subject-icon").nth(1)).toHaveAttribute("aria-label", /Status unavailable/);
        expect(requests).toBe(3, "force refresh does not bypass the failed lookup's backoff");
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      } finally {
        release();
      }
    });

    test("queue membership refreshes independently without changing the PR or notification", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = {
        type: "PullRequest", title: "Synthetic queued PR",
        url: "https://api.github.com/repos/example/widgets/pulls/42",
      };
      canvas.rows[0].mergeQueued = true;
      await page.goto(canvas.url);
      const icon = page.locator(".subject-icon");
      await expect(icon).toHaveAttribute("aria-label", /^Pull Request: In merge queue\. Checked /, { timeout: 15_000 });
      canvas.rows[0].mergeQueued = false;
      await page.locator("#force-refresh").click();
      await expect(icon).toHaveAttribute("aria-label", /^Pull Request: Open\. Checked /, { timeout: 15_000 });
      canvas.setRequestHook(args => args.at(-1) === "graphql"
        ? http({ errors: [{ message: "Synthetic SSO error" }] }) : undefined);
      await page.locator("#force-refresh").click();
      await expect(icon).toHaveAttribute("aria-label", /Pull Request: Open\. Cached result; refresh failed\./, { timeout: 15_000 });
      await expect(page.locator(".subject-state")).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("a primary GraphQL limit leaves inbox refresh and Read/Done available", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = {
        type: "PullRequest", title: "Synthetic rate-limited queue check",
        url: "https://api.github.com/repos/example/widgets/pulls/42",
      };
      canvas.rows[0].subjectDetails = { state: "open", merged: false, draft: false };
      canvas.setRequestHook(args => args.at(-1) === "graphql"
        ? http({ errors: [{ type: "RATE_LIMITED", message: "Synthetic primary quota exhaustion" }] },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) })
        : undefined);
      await page.goto(canvas.url);
      await expect(page.locator(".subject-icon")).toHaveAttribute("aria-label", /GraphQL rate limit/);
      await expect(page.locator("#retry-status")).toBeHidden();
      await expect(page.locator("#notice")).toBeHidden();
      await expect(page.locator("#force-refresh")).toHaveAttribute("aria-disabled", "false");
      await page.locator("#force-refresh").click();
      await page.locator(".mark-read").click();
      await expect.poll(() => canvas.writes).toEqual(["1"]);
      await page.locator(".mark-done").click();
      await expect.poll(() => canvas.doneWrites).toEqual(["1"]);
      await expect(page.locator(".row")).toHaveCount(0);
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(1);
    });

    test("completed icons render on the one-second local poll without extra GitHub requests", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = {
        type: "PullRequest", title: "Synthetic status latency",
        url: "https://api.github.com/repos/example/widgets/pulls/42",
      };
      let release;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(async args => {
        if (args.at(-1) !== "/repos/example/widgets/pulls/42") return;
        await held;
        return http({ state: "closed", merged: true, draft: false });
      });
      let polls = 0;
      page.on("request", request => { if (request.url().endsWith("/api/state")) polls++; });
      let releaseViewport;
      const heldViewport = new Promise(resolve => { releaseViewport = resolve; });
      let viewportStarted = false;
      await page.route("**/api/state", async route => {
        if (!viewportStarted) {
          viewportStarted = true;
          await heldViewport;
        }
        await route.continue();
      });
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      try {
        await page.goto(canvas.url);
        const icon = page.locator(".subject-icon");
        await expect(page.locator(".row")).toHaveCount(1);
        await page.clock.runFor(50);
        await expect.poll(() => viewportStarted).toBe(true);
        // Start the polling interval after the setup clock stops advancing.
        releaseViewport();
        await expect(page.locator(".subject-loading")).toHaveCount(1);
        await expect(icon).toHaveAttribute("aria-label", "Pull Request: Loading status");
        release();
        await expect.poll(() => page.evaluate(async () => {
          const response = await fetch("/api/state", {
            headers: { Authorization: `Bearer ${location.hash.slice(1)}` }, credentials: "omit", cache: "no-store",
          });
          return (await response.json()).subjectsLoading;
        })).toBe(false);
        const pendingPolls = polls;
        await page.clock.runFor(999);
        await expect(icon).toHaveAttribute("aria-label", "Pull Request: Loading status");
        expect(polls).toBe(pendingPolls);
        await page.clock.runFor(1);
        await expect(icon).toHaveAttribute("aria-label", /^Pull Request: Merged\. Checked /);
        expect(polls).toBe(pendingPolls + 1);
        const completedPolls = polls;
        const nextPoll = page.waitForResponse(response => response.url().endsWith("/api/state"));
        await page.clock.runFor(5000);
        await nextPoll;
        expect(polls).toBeGreaterThan(completedPolls);
        expect(canvas.requests.filter(path => path === "/repos/example/widgets/pulls/42")).toHaveLength(1);
        expect(canvas.writes).toEqual([]);
      } finally {
        releaseViewport();
        release();
      }
    });
  });
}
