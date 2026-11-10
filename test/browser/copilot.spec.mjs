import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread, workflowRun, workflowJob } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`Copilot actions (${packaged ? "packaged" : "source"})`, () => {
    test.use({ copilotEnabled: true, packaged });

    test("Copilot handoff is accessible, summary-first, explicitly confirmed, and independent of Read/Done", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url =
        "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      const action = page.getByRole("button", {
        name: /^Investigate with Copilot:/,
      });
      await expect(action).toBeEnabled();
      await action.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "Investigate with Copilot",
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Start session" }),
      ).toBeVisible();
      expect(
        canvas.copilotHost.calls.some(
          (call) => call.name === "create_session",
        ),
      ).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(action).toBeFocused();
      await action.click();
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await expect
        .poll(
          () =>
            canvas.copilotHost.calls.filter(
              (call) => call.name === "navigate_to",
            ).length,
        )
        .toBe(1);
      const create = canvas.copilotHost.calls.find(call => call.name === "create_session");
      const { kickoff, ...creation } = create.args;
      expect(kickoff.mode).toBe("plan");
      expect(kickoff.prompt).toContain(
        "first substantive response must summarize",
      );
      expect(kickoff.prompt).not.toContain(canvas.rows[0].subject.title);
      expect(creation).toEqual({
        project_id: canvas.copilotHost.repositories[0].id, name: "Investigate issue #1",
        workspace_type: "worktree", detached: true,
      });
      expect(canvas.copilotHost.sessions[0].parent_session_id).toBeNull();
      expect(canvas.copilotHost.sessions[0].activity.status).toBe("unknown");
      const completedDialog = page.getByRole("dialog", { name: "Work with Copilot", exact: true });
      await expect(completedDialog).toContainText("Opened a summary-first Copilot session.");
      await expect(completedDialog.getByRole("button", { name: /^Open existing session:/ })).toHaveCount(0);
      expect(canvas.copilotHost.calls.some(call => ["get_session", "send_session_message"].includes(call.name))).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("own and other PR labels use identity, remain stable during hydration, and fit narrow panels", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(2);
      for (const [index, row] of canvas.rows.entries()) {
        row.subject.type = "PullRequest";
        row.subject.url = `https://api.github.com/repos/example/widgets/pulls/${index + 1}`;
        row.subjectDetails = {
          state: "open",
          merged: false,
          draft: false,
          user: { id: index ? 8 : 7 },
        };
        row.reason = index ? "author" : "review_requested";
      }
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto(canvas.url);
      await expect(
        page.getByRole("button", { name: /^Continue with Copilot:/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Review with Copilot:/ }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(360);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: /^Review with Copilot:/ }).click();
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
      const create = canvas.copilotHost.calls.find(call => call.name === "create_session");
      const { kickoff, ...creation } = create.args;
      const reviewPrompt = kickoff.prompt;
      expect(reviewPrompt).toContain("After the summary, use ask_user");
      expect(reviewPrompt).toContain("skill named \"review\" if it is available");
      expect(reviewPrompt).toContain("Wait for the user's answer before reviewing or drafting findings");
      expect(creation).toEqual({
        project_id: canvas.copilotHost.repositories[0].id, name: "Work on PR #2",
        workspace_type: "worktree", detached: true, base_branch: "b".repeat(40),
      });
      expect(canvas.copilotHost.sessions[0].parent_session_id).toBeNull();
      expect(canvas.writes).toEqual([]);
    });

    test("failed CI starts at the exact failed commit only after confirmation", async ({
      page,
      canvas,
    }) => {
      canvas.rows.splice(1);
      const row = canvas.rows[0];
      const runId = 12345678901;
      row.subject = {
        title: "Synthetic failing checks",
        type: "CheckSuite",
        url: `https://api.github.com/repos/example/widgets/actions/runs/${runId}`,
      };
      row.subjectDetails = {
        id: runId,
        run_attempt: 2,
        head_sha: "a".repeat(40),
        repository: { full_name: "example/widgets" },
        html_url: `https://github.com/example/widgets/actions/runs/${runId}`,
        status: "completed",
        conclusion: "failure",
      };
      await page.goto(canvas.url);
      await page
        .getByRole("button", { name: /^Investigate CI failures with Copilot:/ })
        .click();
      await expect(page.locator("#copilot-reference")).toHaveText(
        `https://github.com/example/widgets/actions/runs/${runId}/attempts/2`,
      );
      await page
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await expect
        .poll(() =>
          canvas.copilotHost.calls.some(
            (call) => call.name === "navigate_to",
          ),
        )
        .toBe(true);
      const create = canvas.copilotHost.calls.find(
        (call) => call.name === "create_session",
      );
      expect(create.args.base_branch).toBe("a".repeat(40));
      expect(create.args.workspace_type).toBe("worktree");
      expect(create.args.detached).toBe(true);
      expect(create.args.name.length).toBeLessThanOrEqual(40);
      expect(create.args.kickoff.prompt).toContain(`${row.subjectDetails.html_url}/attempts/2`);
      expect(canvas.copilotHost.sessions[0].parent_session_id).toBeNull();
      expect(canvas.writes).toEqual([]);
    });

    for (const failedJob of [false, true]) {
      test(`inferred CI ${failedJob ? "job" : "run"} navigation and handoff keep the original attempt after a successful rerun`, async ({ page, canvas }) => {
        await canvas.preferences.update({ confirmCopilotActions: false });
        const base = "https://github.com/example/widgets/actions/runs/42";
        const attempt = workflowRun({
          id: 42, run_attempt: 2, html_url: base, head_sha: "a".repeat(40),
          repository: { full_name: "example/widgets" },
        });
        canvas.rows.splice(0, canvas.rows.length, thread("1", {
          subject: { type: "CheckSuite", title: "Synthetic build workflow run, Attempt #2 failed for main branch", url: null },
          workflowRunResults: { total_count: 1, workflow_runs: [attempt] },
          workflowRunAttempts: [attempt],
          workflowJobs: failedJob ? [workflowJob({ id: 91, run_id: 42, run_attempt: 2, html_url: `${base}/job/91` })] : [],
        }));
        await page.goto(canvas.url);
        const link = page.locator(".row-link");
        const destination = `${base}/${failedJob ? "job/91" : "attempts/2"}`;
        await expect(link).toHaveAttribute("href", destination);
        const action = page.getByRole("button", { name: /^Investigate CI failures with Copilot:/ });
        await expect(action).toBeEnabled();
        await page.evaluate(() => {
          document.addEventListener("click", event => {
            const link = event.target.closest(".row-link");
            if (link) {
              window.selectedRunDestination = link.href;
              event.preventDefault();
            }
          });
        });
        await link.locator(".title").click();
        expect(await page.evaluate(() => window.selectedRunDestination)).toBe(destination);
        const newer = { ...attempt, run_attempt: 3, conclusion: "success", head_sha: "b".repeat(40) };
        canvas.rows[0].workflowRunResults.workflow_runs = [newer];
        canvas.setRequestHook(args => args.at(-1) === "/repos/example/widgets/actions/runs/42" ? http(newer) : undefined);
        await action.click();
        await expect(page.locator("#copilot-reference")).toHaveText(`${base}/attempts/2`);
        await expect(page.locator("#copilot-status")).toContainText("matched from notification metadata, not linked by GitHub");
        await expect(page.locator("#copilot-status")).toContainText("Confirm the run and attempt");
        expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
        expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.base_branch).toBe(attempt.head_sha);
        expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.kickoff.prompt).toContain(`${base}/attempts/2`);
        expect(canvas.requests).toContain("/repos/example/widgets/actions/runs/42/attempts/2");
        expect(canvas.requests).not.toContain("/repos/example/widgets/actions/runs/42");
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      });
    }

    test("repository setup is an explicit, accessible second confirmation", async ({
      page,
      canvas,
    }) => {
      canvas.copilotHost.repositories.splice(0);
      await canvas.preferences.update({ confirmCopilotActions: false });
      canvas.rows.splice(1);
      canvas.rows[0].subject.url =
        "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      await page
        .getByRole("button", { name: /^Investigate with Copilot:/ })
        .click();
      const clone = page.getByRole("button", {
        name: "Clone repository and start",
        exact: true,
      });
      await expect(clone).toBeVisible();
      await expect(page.locator("#copilot-clone")).toContainText(
        "significant disk space",
      );
      expect(
        canvas.copilotHost.calls.some((call) => call.name === "add_repository"),
      ).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await clone.click();
      await expect
        .poll(() =>
          canvas.copilotHost.calls.some(
            (call) => call.name === "navigate_to",
          ),
        )
        .toBe(true);
      expect(
        canvas.copilotHost.calls.filter(
          (call) => call.name === "add_repository",
        ),
      ).toHaveLength(1);
      expect(canvas.writes).toEqual([]);
    });

    test("the popup opt-out saves only on confirmation, survives reload, and can be restored in Settings", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      const action = page.getByRole("button", { name: /^Investigate with Copilot:/ });
      const dialog = page.getByRole("dialog", { name: "Investigate with Copilot", exact: true });
      const skip = page.getByRole("switch", { name: "Skip routine confirmations", exact: true });
      await action.click();
      await expect(skip).toBeVisible();
      await skip.focus();
      await page.keyboard.press("Space");
      await expect(skip).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(action).toBeFocused();
      expect((await canvas.preferences.read()).confirmCopilotActions).toBe(true);
      expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
      await action.click();
      await expect(skip).toHaveAttribute("aria-checked", "false");
      await skip.click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => canvas.copilotHost.calls.filter(call => call.name === "navigate_to").length).toBe(1);
      expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.kickoff.mode).toBe("plan");
      await expect.poll(async () => (await canvas.preferences.read()).confirmCopilotActions).toBe(false);
      await expect(page.locator("#copilot-dialog")).toBeHidden();
      await page.reload();
      await expect(action).toBeEnabled();
      const navigations = canvas.copilotHost.calls.filter(call => call.name === "navigate_to").length;
      await action.click();
      await expect.poll(() => canvas.copilotHost.calls.filter(call => call.name === "navigate_to").length).toBe(navigations + 1);
      await expect(page.locator("#copilot-dialog")).toBeHidden();
      expect(canvas.copilotHost.calls.filter(call => call.name === "create_session")).toHaveLength(1);
      expect(canvas.copilotHost.calls.some(call => call.name === "send_session_message")).toBe(false);
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByLabel("Settings", { exact: true })).toHaveAttribute("aria-expanded", "true");
      const confirmations = page.getByRole("switch", { name: "Confirm Copilot actions", exact: true });
      await expect(confirmations).toHaveAttribute("aria-checked", "false");
      await confirmations.click();
      await expect(confirmations).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await action.click();
      await expect(dialog.getByRole("button", { name: /^Open existing session:/ })).toBeVisible();
      expect(canvas.copilotHost.calls.filter(call => call.name === "navigate_to")).toHaveLength(navigations + 1);
      expect(canvas.writes).toEqual([]);
    });

    test("a direct start shows nonmodal progress and never opens a routine popup", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await canvas.preferences.update({ confirmCopilotActions: false });
      let release;
      let opening = false;
      const held = new Promise(resolve => { release = resolve; });
      const execute = canvas.copilotHost.rpc.execute;
      canvas.copilotHost.rpc.execute = async input => {
        if (input.name === "create_session") {
          opening = true;
          await held;
        }
        return execute(input);
      };
      try {
        await page.goto(canvas.url);
        await page.evaluate(() => {
          window.copilotDialogOpens = 0;
          const dialog = document.getElementById("copilot-dialog");
          new MutationObserver(() => {
            if (dialog.open) window.copilotDialogOpens++;
          }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
        });
        const action = page.getByRole("button", { name: /^Investigate with Copilot:/ });
        await action.click();
        await expect.poll(() => opening).toBe(true);
        await expect(page.locator("#copilot-dialog")).toBeHidden();
        await expect(action).toBeDisabled();
        await expect(action).toHaveAttribute("aria-busy", "true");
        await expect(page.locator("#copilot-feedback")).toHaveText("Opening Copilot...");
        release();
        await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
        await expect(action).toBeEnabled();
        expect(await page.evaluate(() => window.copilotDialogOpens)).toBe(0);
        expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.kickoff.mode).toBe("plan");
        expect(canvas.writes).toEqual([]);
      } finally {
        release();
      }
    });

    test("multiple existing sessions still require a choice after opting out", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await canvas.preferences.update({ confirmCopilotActions: false });
      canvas.copilotHost.sessions.push(
        { type: "session", id: "22222222-2222-4222-8222-222222222222", project_repo: "example/widgets", source_issue_number: 1, name: "First" },
        { type: "session", id: "33333333-3333-4333-8333-333333333333", project_repo: "example/widgets", source_issue_number: 1, name: "Second" },
      );
      await page.goto(canvas.url);
      await page.getByRole("button", { name: /^Investigate with Copilot:/ }).click();
      const choose = page.getByRole("button", { name: "Open existing session: Second", exact: true });
      await expect(choose).toBeVisible();
      expect(canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(false);
      await choose.click();
      await expect.poll(() => canvas.copilotHost.calls.find(call => call.name === "navigate_to")?.args.id)
        .toBe("33333333-3333-4333-8333-333333333333");
      expect(canvas.copilotHost.calls.some(call => call.name === "send_session_message")).toBe(false);
      expect(canvas.writes).toEqual([]);
    });

    test("merged and merge-queued PRs hide Copilot but retain normal notification actions", async ({ page, canvas }) => {
      canvas.rows.splice(4);
      for (const [index, row] of canvas.rows.entries()) {
        row.subject.type = "PullRequest";
        row.subject.url = `https://api.github.com/repos/example/widgets/pulls/${index + 1}`;
        row.repository.full_name = "example/widgets";
        row.subjectDetails = {
          state: index === 0 || index === 3 ? "closed" : "open",
          merged: index === 0, draft: index === 2, user: { id: index === 2 ? 7 : 8 },
        };
        row.mergeQueued = index === 1;
      }
      await page.goto(canvas.url);
      await expect(page.locator(".subject-merged")).toHaveCount(1);
      await expect(page.locator(".subject-merge-queued")).toHaveCount(1);
      for (const index of [0, 1]) {
        const row = page.locator(".row").nth(index);
        await expect(row.getByRole("button", { name: /Copilot:/ })).toHaveCount(0);
        await expect(row.locator(".mark-read")).toBeEnabled();
        await expect(row.locator(".mark-done")).toBeEnabled();
      }
      await expect(page.getByRole("button", { name: /^Continue with Copilot: #3/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Review with Copilot: #4/ })).toBeVisible();
    });

    test("Copilot integration defaults on above Hide empty tabs and persists when toggled", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      const action = page.getByRole("button", { name: /^Investigate with Copilot:/ });
      await expect(action).toBeVisible();
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByLabel("Settings", { exact: true })).toHaveAttribute("aria-expanded", "true");
      const toggle = page.getByRole("switch", { name: "Copilot integration", exact: true });
      await expect(page.locator("#copilot-integration + #copilot-confirmations + #hide-empty-tabs")).toHaveCount(1);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(action).toBeHidden();
      expect((await canvas.preferences.read()).copilotIntegration).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.reload();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(action).toBeHidden();
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByLabel("Settings", { exact: true })).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(action).toBeVisible();
      expect((await canvas.preferences.read()).copilotIntegration).toBe(true);
      expect(canvas.writes).toEqual([]);
      expect(canvas.copilotHost.calls).toEqual([]);
    });

    for (const width of [320, 960]) {
      test(`action columns stay aligned across missing actions at ${width}px`, async ({ page, canvas }) => {
        canvas.rows.splice(4);
        for (const [index, row] of canvas.rows.entries()) {
          row.repository.full_name = "example/widgets";
          row.unread = index % 2 === 0;
          row.subject = {
            title: `Synthetic notification ${index + 1}`,
            type: index < 2 ? "Issue" : "Release",
            url: index < 2 ? `https://api.github.com/repos/example/widgets/issues/${index + 1}` : null,
          };
        }
        await page.setViewportSize({ width, height: 900 });
        await page.goto(canvas.url);
        const rows = page.locator(".row");
        await expect(rows).toHaveCount(4);
        await expect(rows.nth(1).locator(".copilot-action")).toBeVisible();
        const copilot = await rows.first().locator(".copilot-action").boundingBox();
        const read = await rows.first().locator(".mark-read").boundingBox();
        const done = await rows.first().locator(".mark-done").boundingBox();
        expect(read.x - copilot.x).toBeCloseTo(36);
        expect(done.x - read.x).toBeCloseTo(36);
        expect((await rows.nth(1).locator(".copilot-action").boundingBox()).x).toBeCloseTo(copilot.x);
        expect((await rows.nth(2).locator(".mark-read").boundingBox()).x).toBeCloseTo(read.x);
        for (const index of [0, 1, 2, 3]) {
          await expect(rows.nth(index).locator(".row-actions")).toHaveCSS("width", "104px");
          expect((await rows.nth(index).locator(".mark-done").boundingBox()).x).toBeCloseTo(done.x);
          await expect(rows.nth(index).getByRole("button")).toHaveCount([3, 3, 2, 2][index]);
        }
        expect((await page.locator(".repo-read").boundingBox()).x).toBeCloseTo(read.x);
        expect((await page.locator(".repo-done").boundingBox()).x).toBeCloseTo(done.x);
        await expect(rows.nth(1).locator(".mark-read")).toBeDisabled();
        const emptyActions = await rows.nth(2).locator(".row-actions").boundingBox();
        expect(await page.evaluate(({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest("a, button")), {
          x: copilot.x + copilot.width / 2, y: emptyActions.y + emptyActions.height / 2,
        })).toBe(false);
        await rows.nth(1).locator(".row-link").focus();
        await page.keyboard.press("Tab");
        await expect(rows.nth(1).locator(".copilot-action")).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(rows.nth(1).locator(".mark-done")).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.getByLabel("Settings", { exact: true }).click();
        await expect(page.getByLabel("Settings", { exact: true })).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("switch", { name: "Copilot integration", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-copilot-integration", "false");
        for (const index of [0, 1, 2, 3]) {
          await expect(rows.nth(index).locator(".row-actions")).toHaveCSS("width", "68px");
          expect((await rows.nth(index).locator(".mark-done").boundingBox()).x).toBeCloseTo(done.x);
        }
        expect((await rows.first().locator(".mark-read").boundingBox()).x).toBeCloseTo(read.x);
        expect(canvas.writes).toEqual([]);
        expect(canvas.copilotHost.calls).toEqual([]);
      });
    }
  });
}
