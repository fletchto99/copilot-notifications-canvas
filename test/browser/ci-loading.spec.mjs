import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread, workflowRun, workflowJob } from "../fixtures.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const packaged of [false, true]) {
  test.describe(`CI destination loading (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged, copilotEnabled: true });

    test("initial matching and job resolution block navigation with a spinner, but refreshes retain usable links", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, thread("1", {
        subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
        workflowRunResults: { total_count: 1, workflow_runs: [workflowRun()] },
        workflowJobs: [workflowJob()],
      }));
      const matching = deferred();
      const jobs = deferred();
      const refresh = deferred();
      let jobStarted = false;
      let refreshStarted = false;
      canvas.setRequestHook(async args => {
        if (args.at(-1).includes("/actions/runs?")) await matching.promise;
        if (args.at(-1).includes("/jobs?")) { jobStarted = true; await jobs.promise; }
      });
      try {
        await page.goto(canvas.url);
        const row = page.locator(".row-link");
        const icon = row.locator(".subject-icon");
        await expect(row).toHaveAttribute("aria-disabled", "true");
        await expect(row).toHaveAttribute("aria-busy", "true");
        await expect(row).not.toHaveAttribute("href");
        await expect(row.locator(".subject-loading")).toHaveCount(1);
        await expect(icon).toHaveAttribute("aria-label", /Failed\. Loading run destination/);
        await expect(icon).not.toHaveAttribute("title");
        await expect(row).toHaveCSS("cursor", "progress");
        await expect(page.locator(".mark-read")).toBeEnabled();
        await expect(page.locator(".mark-done")).toBeEnabled();
        await expect(page.locator(".copilot-action")).toBeDisabled();
        await row.focus();
        await page.keyboard.press("Enter");
        expect(await row.evaluate(node => ["click", "auxclick"].map(type => {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, metaKey: true, button: type === "auxclick" ? 1 : 0 });
          node.dispatchEvent(event);
          return event.defaultPrevented;
        }))).toEqual([true, true]);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect(icon.locator("svg")).toHaveCSS("animation-name", "refresh-spin");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(icon.locator("svg")).toHaveCSS("animation-name", "none");
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(results.violations).toEqual([]);
        matching.resolve();
        await expect.poll(() => jobStarted).toBe(true);
        await expect(row).not.toHaveAttribute("href");
        await expect(row.locator(".subject-loading")).toHaveCount(1);
        await expect(page.locator(".copilot-action")).toBeDisabled();
        jobs.resolve();
        const destination = "https://github.com/example/widgets/actions/runs/123/job/456";
        await expect(row).toHaveAttribute("href", destination);
        await expect(row).not.toHaveAttribute("aria-disabled");
        await expect(row).not.toHaveAttribute("aria-busy");
        await expect(row).toBeFocused();
        await expect(row.locator(".subject-loading")).toHaveCount(0);
        await expect(page.locator(".copilot-action")).toBeEnabled();
        await expect(row.locator(".subject-failure")).toHaveCount(1);
        await expect(row.locator(".destination")).toHaveCount(0);
        await expect(icon).toHaveAttribute("aria-label", /Run link inferred.*not confirmed by GitHub/);
        await expect(icon).not.toHaveAttribute("title");
        canvas.setRequestHook(async args => {
          if (args.at(-1).includes("/jobs?")) { refreshStarted = true; await refresh.promise; }
        });
        await page.locator("#force-refresh").click();
        await expect.poll(() => refreshStarted).toBe(true);
        await expect(row).toHaveAttribute("href", destination);
        await expect(row).not.toHaveAttribute("aria-disabled");
        await expect(row.locator(".subject-loading")).toHaveCount(0);
        refresh.resolve();
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      } finally {
        matching.resolve();
        jobs.resolve();
        refresh.resolve();
      }
    });

    test("a failed initial lookup enables the Actions fallback and restores the reported result", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, thread("1", {
        subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null },
      }));
      const held = deferred();
      canvas.setRequestHook(async args => {
        if (args.at(-1).includes("/actions/runs?")) {
          await held.promise;
          return http({}, {}, 403);
        }
      });
      try {
        await page.goto(canvas.url);
        const row = page.locator(".row-link");
        await expect(row).toHaveAttribute("aria-disabled", "true");
        await expect(row.locator(".subject-loading")).toHaveCount(1);
        held.resolve();
        await expect(row).toHaveAttribute("href", /\/actions\?query=/);
        await expect(row).not.toHaveAttribute("aria-disabled");
        await expect(row.locator(".subject-loading")).toHaveCount(0);
        await expect(row.locator(".subject-failure")).toHaveCount(1);
        await expect(row.locator(".subject-icon")).toHaveAttribute("aria-label", /Run results link unavailable/);
        await expect(row.locator(".subject-icon")).not.toHaveAttribute("title");
        expect(canvas.writes).toEqual([]);
      } finally {
        held.resolve();
      }
    });
  });
}
