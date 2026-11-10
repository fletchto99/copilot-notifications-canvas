import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread, workflowRun, workflowJob } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`inferred workflow links (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged, copilotEnabled: true });

    test("unique matches open their failed job, ambiguous matches use filtered Actions, and uncertainty is accessible", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, ...[
        ["Synthetic build", [workflowRun()]],
        ["Ambiguous build", [
          workflowRun({ id: 124, name: "Ambiguous build", html_url: "https://github.com/example/widgets/actions/runs/124" }),
          workflowRun({ id: 125, name: "Ambiguous build", conclusion: "success",
            html_url: "https://github.com/example/widgets/actions/runs/125" }),
        ]],
        ["Missing build", []],
      ].map(([name, workflow_runs], index) => thread(String(index + 1), {
        subject: { type: "CheckSuite", title: `${name} workflow run failed for main branch`, url: null },
        workflowRunResults: { total_count: workflow_runs.length, workflow_runs },
        workflowJobs: index === 0 ? [workflowJob()] : [],
      })));
      await page.goto(canvas.url);
      const first = page.locator('[data-focus-key="thread:1"]');
      await expect(first).toHaveAttribute("href", "https://github.com/example/widgets/actions/runs/123/job/456");
      await expect(first).toHaveAttribute("target", "_blank");
      await expect(first).toHaveAttribute("rel", "noopener noreferrer");
      await expect(first.locator(".destination")).toHaveCount(0);
      await expect(first).toHaveAccessibleName(/Open failed job logs for inferred workflow run/);
      await expect(first.locator(".subject-icon")).toHaveAttribute("aria-label", /Reported by this notification.*Run link inferred.*not confirmed by GitHub/);
      await expect(first.locator(".subject-icon")).toHaveAttribute("aria-label", /Opens the only failed job's log viewer/);
      await expect(first.locator(".subject-icon")).not.toHaveAttribute("title");
      await expect(first.locator(".subject-failure")).toHaveCount(1);
      await expect(first).not.toHaveAttribute("title");
      await expect(page.locator(".row").first().getByRole("button", { name: /^Investigate CI failures with Copilot:/ })).toBeEnabled();
      await expect.poll(() => canvas.requests.filter(path => path.includes("/actions/runs?")).length).toBe(3);
      for (const [id, name] of [["2", "Ambiguous build"], ["3", "Missing build"]]) {
        const row = page.locator(`[data-focus-key="thread:${id}"]`);
        await expect(row).toHaveAttribute("href", /\/actions\?query=/);
        const url = new URL(await row.getAttribute("href"));
        expect(url.pathname).toBe("/example/widgets/actions");
        expect(url.searchParams.get("query")).toBe(`workflow:"${name}" branch:"main" is:failure`);
        await expect(row.locator(".destination")).toHaveCount(0);
        await expect(row).toHaveAccessibleName(/Open filtered repository Actions/);
        await expect(row.locator("..").getByRole("button", { name: /^Investigate CI failures with Copilot:/ })).toBeDisabled();
      }
      for (const theme of ["light", "dark"]) {
        await page.locator("#settings-toggle").click();
        await page.locator("#theme").selectOption(theme);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 320, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(results.violations).toEqual([]);
      }
      await page.evaluate(() => {
        document.addEventListener("click", event => {
          const link = event.target.closest(".row-link");
          if (link) {
            window.runNavigation = { url: link.href, preventedByCanvas: event.defaultPrevented, modified: event.metaKey };
            event.preventDefault();
          }
        });
      });
      await first.locator(".title").click({ modifiers: ["Meta"] });
      expect(await page.evaluate(() => window.runNavigation)).toEqual({
        url: "https://github.com/example/widgets/actions/runs/123/job/456", preventedByCanvas: false, modified: true,
      });
      expect(canvas.requests.some(path => path.includes("/logs"))).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("failed matching refresh removes an inferred link but keeps the reported result and explains the fallback", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, thread("1", {
        subject: { type: "CheckSuite", title: "Synthetic build workflow run, Attempt #3 failed for main branch", url: null },
        workflowRunResults: { total_count: 1, workflow_runs: [workflowRun({ run_attempt: 3 })] },
      }));
      await page.goto(canvas.url);
      const row = page.locator(".row-link");
      await expect(row).toHaveAttribute("href", "https://github.com/example/widgets/actions/runs/123/attempts/3");
      canvas.setRequestHook(args => args.at(-1).includes("/actions/runs?") ? http({}, {}, 403) : undefined);
      await page.locator("#force-refresh").click();
      await expect(row).toHaveAttribute("href", /\/actions\?query=/);
      await expect(row.locator(".destination")).toHaveCount(0);
      await expect(row.locator(".subject-failure")).toHaveCount(1);
      await expect(row.locator(".subject-icon")).toHaveAttribute("aria-label", /Run results link unavailable.*denied access to workflow runs/);
      await expect(row.locator(".subject-icon")).not.toHaveAttribute("title");
      const count = canvas.requests.filter(path => path.includes("/actions/runs?")).length;
      await page.locator("#force-refresh").click();
      expect(canvas.requests.filter(path => path.includes("/actions/runs?"))).toHaveLength(count);
      expect(canvas.writes).toEqual([]);
    });

    test("known runs open the unique failed job and keep the summary for zero, multiple or unavailable jobs", async ({ page, canvas }) => {
      const base = "https://github.com/example/widgets/actions/runs/";
      canvas.rows.splice(0, canvas.rows.length, ...[123, 124, 125, 126].map((id, index) => {
        const job = (jobId, conclusion = "failure") => workflowJob({
          id: jobId, run_id: id, conclusion, html_url: `${base}${id}/job/${jobId}`,
        });
        return thread(String(index + 1), {
          subject: { type: "CheckSuite", title: `Synthetic known run ${index + 1}`,
            url: `https://api.github.com/repos/example/widgets/${index === 0 ? "check-suites/7" : `actions/runs/${id}`}` },
          subjectDetails: { status: "completed", conclusion: "failure" },
          workflowRunResults: { total_count: 1, workflow_runs: [workflowRun({ id, check_suite_id: 7, html_url: `${base}${id}` })] },
          workflowJobs: index === 0 ? [job(456), job(457, "success")] : index === 1 ? [job(458), job(459)]
            : index === 2 ? [job(460, "success")] : [job(461)],
        });
      }));
      await page.goto(canvas.url);
      const first = page.locator('[data-focus-key="thread:1"]');
      const last = page.locator('[data-focus-key="thread:4"]');
      await expect(first).toHaveAttribute("href", `${base}123/job/456`);
      await expect(first).toHaveAccessibleName(/Open failed job logs/);
      await expect(first.locator(".destination")).toHaveCount(0);
      await expect(first.locator(".subject-icon")).toHaveAttribute("aria-label", /Opens the only failed job's log viewer/);
      await expect(last).toHaveAttribute("href", `${base}126/job/461`);
      await expect(page.locator('[data-focus-key="thread:2"]')).toHaveAttribute("href", `${base}124`);
      await expect(page.locator('[data-focus-key="thread:3"]')).toHaveAttribute("href", `${base}125`);
      canvas.setRequestHook(args => args.at(-1).includes("/runs/126/jobs?") ? http({}, {}, 403) : undefined);
      await page.locator("#force-refresh").click();
      await expect(last).toHaveAttribute("href", `${base}126`);
      await expect(last.locator(".subject-icon")).toHaveAttribute("aria-label", /Job logs link unavailable.*denied access to job details/);
      await expect(last.locator(".subject-failure")).toHaveCount(1);
      await expect(first).toHaveAttribute("href", `${base}123/job/456`);
      expect(canvas.requests.some(path => path.includes("/logs"))).toBe(false);
      expect(canvas.writes).toEqual([]);
    });
  });
}
