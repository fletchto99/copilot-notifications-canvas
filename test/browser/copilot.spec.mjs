import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread, workflowRun, workflowJob } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`Copilot actions (${packaged ? "packaged" : "source"})`, () => {
    test.use({ copilotEnabled: true, packaged });

    test("cold discovery keeps the inbox usable and enables Copilot without refreshing or moving focus", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await canvas.preferences.update({ confirmCopilotActions: false });
      const metadata = await canvas.copilotHost.rpc.getCurrentMetadata();
      let release;
      const discovery = new Promise(resolve => { release = resolve; });
      canvas.copilotHost.rpc.getCurrentMetadata = () => discovery;
      try {
        await page.goto(canvas.url);
        const action = page.locator(".copilot-action");
        await expect(action).toBeVisible();
        await expect(action).toBeDisabled();
        await expect(action).toHaveAccessibleName(/^Waiting on copilot SDK Availability/);
        await expect(action).toHaveAttribute("aria-busy", "true");
        await action.locator("..").hover();
        await expect(action.locator("..").getByRole("tooltip")).toHaveText("Waiting on copilot SDK Availability");
        await expect(page.locator(".mark-read")).toBeEnabled();
        await expect(page.locator(".mark-done")).toBeEnabled();
        const link = page.locator(".row-link");
        await expect(link).toHaveAttribute("href", "https://github.com/example/widgets/issues/1");
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await link.focus();
        release(metadata);
        await expect(action).toBeEnabled();
        await expect(action).toHaveAccessibleName(/^Investigate with Copilot:/);
        await expect(action).toHaveAttribute("aria-busy", "false");
        await expect(link).toBeFocused();
        expect(canvas.copilotHost.calls).toEqual([]);
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      } finally {
        release(metadata);
      }
    });

    for (const supported of [true, false]) {
      test(`cold discovery ${supported ? "recovers after the first minute" : "shows unavailable tooling after three minutes"}`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
        const metadata = await canvas.copilotHost.rpc.getCurrentMetadata();
        const start = Date.now();
        let elapsed = 0;
        const setTime = async time => {
          await canvas.setCopilotTime(start + time);
          elapsed = time;
        };
        await setTime(0);
        let calls = 0;
        canvas.copilotHost.rpc.getCurrentMetadata = async () => {
          calls++;
          return supported && elapsed >= 68_000 ? metadata : { tools: [] };
        };
        await page.goto(canvas.url);
        const action = page.locator(".copilot-action");
        for (const [index, time] of [0, 1000, 3000, 8000].entries()) {
          await setTime(time);
          await expect.poll(() => calls).toBe(index + 1);
        }
        await expect(action).toBeVisible();
        await expect(action).toBeDisabled();
        await expect(action).toHaveAttribute("aria-busy", "true");
        const link = page.locator(".row-link");
        await link.focus();
        await setTime(supported ? 60_000 : 179_999);
        await expect.poll(() => calls).toBe(5);
        const request = await page.waitForRequest(request => new URL(request.url()).pathname === "/api/state");
        const snapshot = await (await request.response()).json();
        expect(snapshot.copilotLoading).toBe(true);
        await expect(action).toBeDisabled();
        await expect(action).toHaveAccessibleName(/^Waiting on copilot SDK Availability/);
        await expect(action).toHaveAttribute("aria-busy", "true");
        await setTime(supported ? 68_000 : 180_000);
        if (supported) {
          await expect(action).toBeEnabled();
        } else {
          await expect(action).toHaveAccessibleName(/^Copilot tooling unavailable:/);
          await expect(action).toBeDisabled();
          await expect(action).toHaveAttribute("aria-busy", "false");
          await action.locator("..").hover();
          await expect(action.locator("..").getByRole("tooltip")).toHaveText("Copilot tooling unavailable");
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        }
        expect(calls).toBe(6);
        await expect(link).toBeFocused();
        await expect(page.locator(".mark-read")).toBeEnabled();
        await expect(page.locator(".mark-done")).toBeEnabled();
        expect(canvas.copilotHost.calls).toEqual([]);
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      });
    }

    for (const [type, closed] of [["Issue", false], ["Discussion", false], ["Discussion", true]]) test(
      `${closed ? "Closed" : "Open"} ${type} handoff is accessible, explicitly confirmed, and independent of Read/Done`, async ({ page, canvas }) => {
      canvas.rows.splice(1);
      const discussion = type === "Discussion";
      const label = discussion ? "Summarize with Copilot" : "Investigate with Copilot";
      const name = discussion ? "Summarize discussion #1" : "Investigate issue #1";
      canvas.rows[0].subject.type = type;
      canvas.rows[0].subject.url = `https://api.github.com/repos/example/widgets/${discussion ? "discussions" : "issues"}/1`;
      if (discussion) canvas.rows[0].subjectDetails = { closed, isAnswered: false, stateReason: closed ? "RESOLVED" : null };
      await page.goto(canvas.url);
      if (discussion) await expect(page.locator(".subject-icon")).toHaveAttribute("aria-label", new RegExp(`Discussion: ${closed ? "Closed" : "Open"}`));
      const action = page.getByRole("button", {
        name: new RegExp(`^${label}:`),
      });
      await expect(action).toBeEnabled();
      await action.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: label,
      });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#copilot-status")).toHaveText(discussion
        ? "Copilot will summarize this discussion, then stop and wait for further instructions."
        : "Copilot will summarize this item first, then investigate read-only. Implementation and GitHub changes require your approval.");
      await expect(page.locator("#copilot-reference")).toHaveText(`https://github.com/example/widgets/${discussion ? "discussions" : "issues"}/1`);
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
      if (discussion) {
        expect(kickoff.prompt).toMatch(/comments,? and replies/);
        expect(kickoff.prompt).toContain("open or closed state");
        expect(kickoff.prompt).toContain("Stop after the summary");
      }
      expect(kickoff.prompt).not.toContain(canvas.rows[0].subject.title);
      expect(creation).toEqual({
        project_id: canvas.copilotHost.repositories[0].id, name,
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

    test("row navigation and Read/Done shortcuts work from the Copilot button", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      for (const row of canvas.rows) {
        row.subject = { title: `Synthetic issue ${row.id}`, type: "Issue",
          url: `https://api.github.com/repos/${row.repository.full_name}/issues/${row.id}` };
      }
      await page.goto(canvas.url);
      const copilot = page.locator('[data-focus-key="copilot:2"]');
      await expect(copilot).toBeEnabled();
      await copilot.focus();
      await page.keyboard.press("j");
      await expect(page.locator('[data-focus-key="thread:3"]')).toBeFocused();
      await copilot.focus();
      await page.keyboard.press("k");
      await expect(page.locator('[data-focus-key="thread:1"]')).toBeFocused();
      await copilot.focus();
      await page.keyboard.press("i");
      await expect.poll(() => canvas.writes).toEqual(["2"]);
      await expect(page.locator('[data-focus-key="read:2"]')).toBeDisabled();
      await expect(page.locator('[data-focus-key="read:2"]')).toHaveAccessibleName(/^Already read:/);
      await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
      await copilot.focus();
      await expect(copilot).toBeFocused();
      await page.keyboard.press("Shift+KeyE");
      await expect.poll(() => canvas.doneWrites).toEqual(["2"]);
      await expect(copilot).toHaveCount(0);
      expect(canvas.writes).toEqual(["2", "2"]);
      expect(canvas.copilotHost.calls).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("a direct PR handoff waits for pending merge-queue membership", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = { title: "Synthetic queued PR", type: "PullRequest",
        url: "https://api.github.com/repos/example/widgets/pulls/1" };
      canvas.rows[0].mergeQueued = true;
      await canvas.preferences.update({ confirmCopilotActions: false });
      let release;
      let checking = false;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(async args => {
        if (args.at(-1) === "graphql") {
          checking = true;
          await held;
        }
      });
      try {
        await page.goto(canvas.url);
        await expect.poll(() => checking).toBe(true);
        const action = page.locator(".copilot-action");
        await expect(action).toBeEnabled();
        await action.click();
        await expect(action).toHaveAttribute("aria-busy", "true");
        expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
        release();
        await expect(page.locator("#copilot-status")).toContainText("merge-queued");
        expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
        expect(canvas.writes).toEqual([]);
      } finally {
        release();
      }
    });

    for (const change of ["head", "queue", "head during final queue lookup", "closure during final queue lookup"]) test(
      `a PR ${change} change after confirmation shows an error without creating a session`, async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = { title: "Synthetic PR", type: "PullRequest",
        url: "https://api.github.com/repos/example/widgets/pulls/1" };
      canvas.rows[0].subjectDetails = {
        state: "open", merged: false, draft: false, user: { id: 8 }, head: { sha: "b".repeat(40) },
      };
      await page.goto(canvas.url);
      await page.getByRole("button", { name: /^Review with Copilot:/ }).click();
      const start = page.getByRole("button", { name: "Start session", exact: true });
      await expect(start).toBeVisible();
      if (change.includes("during")) {
        canvas.setRequestHook(args => {
          if (args.at(-1) !== "graphql" ||
              canvas.copilotHost.calls.filter(call => call.name === "list_sessions_and_chats").length !== 3) return;
          if (change.startsWith("head")) canvas.rows[0].subjectDetails.head.sha = "c".repeat(40);
          else canvas.rows[0].subjectDetails.state = "closed";
        });
      } else if (change === "head") canvas.rows[0].subjectDetails.head.sha = "c".repeat(40);
      else canvas.rows[0].mergeQueued = true;
      await start.click();
      await expect(page.locator("#copilot-status")).toContainText(
        change.startsWith("head") ? "head commit changed" : change === "queue" ? "merge-queued" : "state changed",
      );
      await expect(page.locator("#copilot-status")).toHaveAttribute("role", "alert");
      await expect(start).toBeHidden();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    for (const merged of [false, true]) test(
      `${merged ? "merged" : "closed"} PR summaries use fresh REST state despite an unavailable queue check`, async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = { title: "Synthetic PR", type: "PullRequest",
        url: "https://api.github.com/repos/example/widgets/pulls/1" };
      canvas.rows[0].subjectDetails = { state: "open", merged: false, draft: false, user: { id: 8 } };
      canvas.setRequestHook(args => args.at(-1) === "graphql" ? http({}, {}, 403) : undefined);
      await page.goto(canvas.url);
      const action = page.getByRole("button", { name: /^Review with Copilot:/ });
      await expect(action).toBeEnabled();
      await expect.poll(() => canvas.requests.filter(path => path === "graphql").length).toBeGreaterThan(0);
      const queueChecks = canvas.requests.filter(path => path === "graphql").length;
      Object.assign(canvas.rows[0].subjectDetails, { state: "closed", merged });
      await action.click();
      const dialog = page.getByRole("dialog", { name: "Summarize Changes", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(merged
        ? "summarize what this merged PR changed" : "changes proposed by this closed PR");
      expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
      await dialog.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
      const creation = canvas.copilotHost.calls.find(call => call.name === "create_session").args;
      expect(creation.kickoff.prompt).toContain(`Summarize what this ${merged ? "merged" : "closed, unmerged"} pull request changed.`);
      expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(queueChecks);
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

    for (const type of ["PullRequest", "CheckSuite"]) {
      test(`a missing ${type} commit is fetched before the session kickoff`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        const sha = "d".repeat(40);
        const row = canvas.rows[0];
        row.subject = { title: "Synthetic selected commit", type,
          url: `https://api.github.com/repos/example/widgets/${type === "PullRequest" ? "pulls/1" : "actions/runs/42"}` };
        row.subjectDetails = type === "PullRequest"
          ? { state: "open", merged: false, draft: false, user: { id: 7 }, head: { sha } }
          : workflowRun({ id: 42, run_attempt: 2, head_sha: sha, html_url: "https://github.com/example/widgets/actions/runs/42",
            repository: { full_name: "example/widgets" } });
        const run = canvas.copilotHost.rpc.runGit;
        const execute = canvas.copilotHost.rpc.execute;
        let releaseCheckout;
        let releaseStart;
        let release;
        let fetching = false;
        let present = false;
        const held = new Promise(resolve => { release = resolve; });
        const checkout = new Promise(resolve => { releaseCheckout = resolve; });
        const starting = new Promise(resolve => { releaseStart = resolve; });
        const direct = type === "CheckSuite";
        if (direct) await canvas.preferences.update({ confirmCopilotActions: false });
        canvas.copilotHost.rpc.runGit = async input => {
          if (input.args.includes("--show-toplevel")) await checkout;
          if (input.args.includes("--verify") && !present) {
            throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
          }
          if (input.args.includes("fetch")) {
            fetching = true;
            await held;
            present = true;
          }
          return run(input);
        };
        canvas.copilotHost.rpc.execute = async input => {
          if (input.name === "create_session") await starting;
          return execute(input);
        };
        try {
          await page.goto(canvas.url);
          expect(canvas.copilotHost.gitCalls).toEqual([]);
          await page.locator(".copilot-action").click();
          if (!direct) await page.getByRole("button", { name: "Start session", exact: true }).click();
          const progress = page.locator(direct ? "#copilot-feedback" : "#copilot-status");
          await expect(progress).toHaveText("Preparing checkout...");
          releaseCheckout();
          await expect.poll(() => fetching).toBe(true);
          await expect(progress).toHaveText("Fetching selected commit...");
          await expect(page.locator(".copilot-action")).toBeDisabled();
          await expect(page.locator("#row-copilot-1-tooltip")).toHaveText("Fetching selected commit...");
          expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
          release();
          await expect(progress).toContainText("Starting session.");
          if (direct) await expect(page.locator("#copilot-dialog")).toBeHidden();
          releaseStart();
          await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
          expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.base_branch).toBe(sha);
          expect(canvas.copilotHost.gitCalls.find(call => call.args.includes("fetch")).args.at(-1))
            .toBe(type === "PullRequest" ? "refs/pull/1/head" : sha);
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          releaseCheckout();
          releaseStart();
          release();
        }
      });
    }

    test("a session appearing during a direct fetch restores the existing-or-new choice", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = { title: "Synthetic PR", type: "PullRequest",
        url: "https://api.github.com/repos/example/widgets/pulls/1" };
      await canvas.preferences.update({ confirmCopilotActions: false });
      const run = canvas.copilotHost.rpc.runGit;
      let release;
      let fetching = false;
      let present = false;
      const held = new Promise(resolve => { release = resolve; });
      canvas.copilotHost.rpc.runGit = async input => {
        if (input.args.includes("--verify") && !present) {
          throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
        }
        if (input.args.includes("fetch")) {
          fetching = true;
          await held;
          present = true;
        }
        return run(input);
      };
      try {
        await page.goto(canvas.url);
        await page.locator(".copilot-action").click();
        await expect.poll(() => fetching).toBe(true);
        await expect(page.locator("#copilot-dialog")).toBeHidden();
        const existing = { type: "session", id: "22222222-2222-4222-8222-222222222222",
          project_repo: "example/widgets", name: "Work on PR #1" };
        canvas.copilotHost.sessions.push(existing);
        release();
        const dialog = page.locator("#copilot-dialog");
        const open = dialog.getByRole("button", { name: "Open existing session: Work on PR #1", exact: true });
        await expect(open).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Start a new session", exact: true })).toBeVisible();
        expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
        await open.click();
        await expect.poll(() => canvas.copilotHost.calls.find(call => call.name === "navigate_to")?.args.id).toBe(existing.id);
        expect(canvas.copilotHost.sessions).toEqual([existing]);
        expect(canvas.copilotHost.calls.some(call => ["create_session", "send_session_message"].includes(call.name))).toBe(false);
        expect(canvas.writes).toEqual([]);
      } finally {
        release();
      }
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

    test("confirmation details stay readable on narrow panels without hiding consent or moving focus", async ({ page, canvas }) => {
      canvas.copilotHost.repositories.splice(0);
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await page.goto(canvas.url);
      const action = page.getByRole("button", { name: /^Investigate with Copilot:/ });
      await action.click();
      const dialog = page.locator("#copilot-dialog");
      const start = page.getByRole("button", { name: "Clone repository and start", exact: true });
      await expect(start).toBeVisible();
      for (const width of [320, 480]) {
        await page.setViewportSize({ width, height: 640 });
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await page.locator("#copilot-close").focus();
          for (const id of ["copilot-status", "copilot-reference", "copilot-clone", "copilot-privacy", "copilot-confirmation-help"]) {
            const text = page.locator(`#${id}`);
            await text.scrollIntoViewIfNeeded();
            await expect(text).toBeInViewport();
            const box = await text.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(16);
            expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
          }
          const clone = await page.locator("#copilot-clone").boundingBox();
          const privacy = await page.locator("#copilot-privacy").boundingBox();
          expect(clone.y + clone.height).toBeLessThan(privacy.y);
          await expect(dialog).toContainText("significant disk space");
          await expect(dialog).toContainText("retained in its session history");
          await expect(dialog).toContainText("Read/Done stays unchanged");
          await expect(dialog).toContainText("Saved when you confirm, not when you cancel");
          await page.locator("#copilot-close").focus();
          await page.keyboard.press("Tab");
          await expect(page.locator("#copilot-skip-confirmation")).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(start).toBeFocused();
          await expect(start).toBeInViewport();
          const bounds = await dialog.boundingBox();
          expect(bounds.y).toBeGreaterThanOrEqual(16);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(624);
          expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        }
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(action).toBeFocused();
      expect((await canvas.preferences.read()).confirmCopilotActions).toBe(true);
      expect(canvas.copilotHost.calls.filter(call =>
        !["list_repositories", "list_sessions_and_chats"].includes(call.name))).toEqual([]);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

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

    test("context changes during repository setup block session creation", async ({ page, canvas }) => {
      canvas.copilotHost.repositories.splice(0);
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      canvas.rows[0].subjectDetails = { state: "open" };
      let setupComplete = false;
      let readsAfterSetup = 0;
      const execute = canvas.copilotHost.rpc.execute;
      canvas.copilotHost.rpc.execute = async input => {
        const result = await execute(input);
        if (input.name === "add_repository") {
          canvas.rows[0].subjectDetails.state = "closed";
          setupComplete = true;
        }
        return result;
      };
      canvas.setRequestHook(args => {
        if (setupComplete && args.at(-1) === "/repos/example/widgets/issues/1") readsAfterSetup++;
      });
      await page.goto(canvas.url);
      await page.getByRole("button", { name: /^Investigate with Copilot:/ }).click();
      await page.getByRole("button", { name: "Clone repository and start", exact: true }).click();
      await expect(page.locator("#copilot-status")).toContainText("This issue's state changed.");
      await expect(page.locator("#copilot-status")).toHaveAttribute("role", "alert");
      expect(readsAfterSetup).toBeGreaterThan(0);
      expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    for (const boundary of ["setup", "inspection"]) test(
      `queue entry during repository ${boundary} blocks checkout or fetch`, async ({ page, canvas }) => {
      canvas.rows.splice(1);
      const row = canvas.rows[0];
      row.subject = { title: "Synthetic PR", type: "PullRequest",
        url: "https://api.github.com/repos/example/widgets/pulls/1" };
      row.subjectDetails = { state: "open", merged: false, draft: false, head: { sha: "b".repeat(40) } };
      if (boundary === "setup") canvas.copilotHost.repositories.splice(0);
      const execute = canvas.copilotHost.rpc.execute;
      canvas.copilotHost.rpc.execute = async input => {
        const result = await execute(input);
        if (input.name === "add_repository") row.mergeQueued = true;
        return result;
      };
      const run = canvas.copilotHost.rpc.runGit;
      let present = false;
      canvas.copilotHost.rpc.runGit = async input => {
        if (input.args.includes("--verify") && !present) {
          if (boundary === "inspection") row.mergeQueued = true;
          throw Object.assign(new Error("Missing synthetic commit"), { code: 1 });
        }
        if (input.args.includes("fetch")) present = true;
        return run(input);
      };
      await page.goto(canvas.url);
      await page.getByRole("button", { name: /^Review with Copilot:/ }).click();
      await page.getByRole("button", {
        name: boundary === "setup" ? "Clone repository and start" : "Start session", exact: true,
      }).click();
      await expect(page.locator("#copilot-status")).toContainText("merge-queued");
      await expect(page.locator("#copilot-status")).toHaveAttribute("role", "alert");
      expect(row.mergeQueued).toBe(true);
      expect(canvas.copilotHost.gitCalls.some(call => call.args.includes("fetch"))).toBe(false);
      if (boundary === "setup") expect(canvas.copilotHost.gitCalls).toEqual([]);
      expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
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
      await expect(dialog.getByRole("button", { name: "Start a new session", exact: true })).toBeVisible();
      expect(canvas.copilotHost.calls.filter(call => call.name === "navigate_to")).toHaveLength(navigations);
      await dialog.getByRole("button", { name: /^Open existing session:/ }).click();
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
        await expect(page.locator("#copilot-feedback")).toContainText("Starting session.");
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

    test("a fresh start is explicitly confirmed and leaves existing sessions untouched", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/1";
      await canvas.preferences.update({ confirmCopilotActions: false });
      const existing = { type: "session", id: "22222222-2222-4222-8222-222222222222",
        project_repo: "example/widgets", name: "Investigate issue #1", activity: { status: "unknown" } };
      canvas.copilotHost.sessions.push(existing);
      const before = structuredClone(existing);
      await page.goto(canvas.url);
      const action = page.locator(".copilot-action");
      await action.click();
      const dialog = page.locator("#copilot-dialog");
      const fresh = dialog.getByRole("button", { name: "Start a new session", exact: true });
      await expect(fresh).toBeVisible();
      await expect(dialog.getByRole("button", { name: /^Open existing session:/ })).toBeVisible();
      await expect(dialog).toContainText("Existing sessions and their work are left untouched.");
      expect(canvas.copilotHost.calls.some(call => ["create_session", "navigate_to"].includes(call.name))).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(action).toBeFocused();
      expect(canvas.copilotHost.sessions).toEqual([before]);
      await action.click();
      await fresh.click();
      await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
      expect(canvas.copilotHost.sessions).toHaveLength(2);
      expect(canvas.copilotHost.sessions[0]).toEqual(before);
      const created = canvas.copilotHost.sessions[1];
      expect(created.id).not.toBe(existing.id);
      expect(created.parent_session_id).toBeNull();
      expect(canvas.copilotHost.calls.find(call => call.name === "create_session").args.kickoff.mode).toBe("plan");
      expect(canvas.copilotHost.calls.find(call => call.name === "navigate_to").args.id).toBe(created.id);
      expect(canvas.copilotHost.calls.some(call => ["get_session", "send_session_message"].includes(call.name))).toBe(false);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    for (const [type, status, label, task] of [
      ["Issue", "closed", "Summarize with Copilot", "Summarize this closed issue read-only."],
      ["Discussion", "open", "Summarize with Copilot", "Summarize this discussion read-only."],
      ["Discussion", "closed", "Summarize with Copilot", "Summarize this discussion read-only."],
      ["Commit", null, "Summarize commit", "Summarize the code changed in this commit read-only."],
    ]) test(`${type} ${status ?? "diff"} has an accessible summary-only Copilot action`, async ({ page, canvas }) => {
      const sha = "c".repeat(40);
      canvas.rows.splice(1);
      const path = type === "Issue" ? "issues/1" : type === "Discussion" ? "discussions/1" : `commits/${sha}`;
      const url = `https://github.com/example/widgets/${type === "Commit" ? `commit/${sha}` : path}`;
      canvas.rows[0].subject = { title: "Synthetic selected item", type, url: `https://api.github.com/repos/example/widgets/${path}` };
      canvas.rows[0].subjectDetails = type === "Issue" ? { state: "closed", state_reason: "not_planned" } :
        type === "Discussion" ? { closed: status === "closed", isAnswered: false, stateReason: status === "closed" ? "RESOLVED" : null } :
          { sha, html_url: url, commit: { message: "Private commit message" }, files: [{ patch: "Private patch" }] };
      await page.goto(canvas.url);
      const action = page.locator(".copilot-action");
      await expect(action).toBeEnabled();
      await expect(action).toHaveAccessibleName(new RegExp(`^${label}:`));
      await action.hover();
      await expect(page.locator(".row").getByRole("tooltip")).toHaveText(label);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await action.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: label, exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#copilot-reference")).toHaveText(url);
      await expect(page.locator("#copilot-status")).not.toContainText("then investigate");
      expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await dialog.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
      const creation = canvas.copilotHost.calls.find(call => call.name === "create_session").args;
      expect(creation.base_branch).toBe(type === "Commit" ? sha : undefined);
      expect(creation.kickoff.mode).toBe("plan");
      expect(creation.kickoff.prompt).toContain(task);
      expect(creation.kickoff.prompt).toContain("Stop after the summary");
      expect(creation.kickoff.prompt).not.toMatch(/Synthetic selected item|Private|After the summary, use ask_user/);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("release notes are summarized only for the confirmed exact release, with accessible missing-link feedback", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      canvas.rows[0].subject = { title: "Synthetic release", type: "Release",
        url: "https://api.github.com/repos/example/widgets/releases/42" };
      canvas.rows[0].subjectDetails = { id: 42, tag_name: "v1.2.0", draft: false,
        html_url: "https://github.com/example/widgets/releases/tag/v1.2.0", body: "Private release notes" };
      canvas.rows[1].subject = { title: "Unlinked release", type: "Release", url: null };
      await page.goto(canvas.url);
      const linked = page.locator(".row").first();
      const action = linked.getByRole("button", { name: "Summarize Release Notes: Synthetic release" });
      await expect(action).toBeEnabled();
      await action.hover();
      await expect(linked.getByRole("tooltip")).toHaveText("Summarize Release Notes");
      const unlinked = page.locator(".row").nth(1);
      const disabled = unlinked.getByRole("button", { name: "Summarize Release Notes: Unlinked release" });
      await expect(disabled).toBeDisabled();
      await disabled.locator("..").hover();
      await expect(unlinked.getByRole("tooltip")).toHaveText("No specific release is linked. Open GitHub to choose a release.");
      await expect(unlinked.locator(".mark-read")).toBeEnabled();
      await expect(unlinked.locator(".mark-done")).toBeEnabled();
      expect(canvas.requests).not.toContain("/repos/example/widgets/releases/42");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await linked.locator(".row-link").focus();
      await page.keyboard.press("Tab");
      await expect(action).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Summarize Release Notes" });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#copilot-reference")).toHaveText(canvas.rows[0].subjectDetails.html_url);
      await expect(dialog).toContainText("selected release notes read-only");
      expect(canvas.copilotHost.calls.some(call => call.name === "create_session")).toBe(false);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await dialog.getByRole("button", { name: "Start session", exact: true }).click();
      await expect.poll(() => canvas.copilotHost.calls.some(call => call.name === "navigate_to")).toBe(true);
      const creation = canvas.copilotHost.calls.find(call => call.name === "create_session").args;
      expect(creation.name).toBe("Summarize release 42");
      expect(creation.base_branch).toBeUndefined();
      expect(creation.kickoff.mode).toBe("plan");
      expect(creation.kickoff.prompt).toContain("endpoint repos/example/widgets/releases/42");
      expect(creation.kickoff.prompt).toContain("never substitute the latest release");
      expect(creation.kickoff.prompt).not.toMatch(/Synthetic release|Private release notes/);
      expect(canvas.copilotHost.gitCalls).toEqual([]);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("closed and merged PRs offer accessible summaries while queued PRs stay disabled", async ({ page, canvas }) => {
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
      for (const [index, reason] of [[1, "PR in merge queue"]]) {
        const row = page.locator(".row").nth(index);
        const action = row.locator(".copilot-action");
        await expect(action).toBeVisible();
        await expect(action).toBeDisabled();
        await expect(action).toHaveAccessibleName(new RegExp(`^${reason}:`));
        await action.locator("..").hover();
        await expect(row.getByRole("tooltip")).toBeVisible();
        await expect(row.getByRole("tooltip")).toHaveText(reason);
        await action.click({ force: true });
        await row.locator(".row-link").focus();
        await page.keyboard.press("Tab");
        await expect(row.locator(".mark-read")).toBeFocused();
        await expect(row.locator(".mark-read")).toBeEnabled();
        await expect(row.locator(".mark-done")).toBeEnabled();
      }
      await expect(page.getByRole("button", { name: /^Continue with Copilot: #3/ })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(canvas.copilotHost.calls).toEqual([]);
      for (const [index, closed] of [[0, false], [3, true]]) {
        const row = page.locator(".row").nth(index);
        const action = row.getByRole("button", { name: /^Summarize Changes:/ });
        const starts = canvas.copilotHost.calls.filter(call => call.name === "create_session").length;
        const navigations = canvas.copilotHost.calls.filter(call => call.name === "navigate_to").length;
        await expect(action).toBeEnabled();
        await action.hover();
        await expect(row.getByRole("tooltip")).toHaveText("Summarize Changes");
        await row.locator(".row-link").focus();
        await page.keyboard.press("Tab");
        await expect(action).toBeFocused();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Summarize Changes" });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(closed
          ? "ask whether you'd like help reopening it" : "Copilot will summarize what this merged PR changed.");
        expect(canvas.copilotHost.calls.filter(call => call.name === "create_session")).toHaveLength(starts);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await dialog.getByRole("button", { name: "Start session", exact: true }).click();
        await expect.poll(() => canvas.copilotHost.calls.filter(call => call.name === "navigate_to").length).toBe(navigations + 1);
        const creation = canvas.copilotHost.calls.filter(call => call.name === "create_session").at(-1).args;
        expect(creation.kickoff.mode).toBe("plan");
        expect(creation.kickoff.prompt).toContain(`Summarize what this ${closed ? "closed, unmerged" : "merged"} pull request changed.`);
        if (closed) {
          expect(creation.kickoff.prompt).toContain("After the summary, use ask_user to ask whether the user would like help reopening");
          expect(creation.kickoff.prompt).toContain("Do not reopen the PR, restore a branch, or make other changes without explicit approval.");
        } else {
          expect(creation.kickoff.prompt).not.toContain("After the summary, use ask_user");
        }
        expect(creation.base_branch).toBe("b".repeat(40));
        await page.locator("#copilot-close").click();
      }
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
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
            type: index < 2 ? "Issue" : index === 2 ? "Commit" : "Release",
            url: index < 2 ? `https://api.github.com/repos/example/widgets/issues/${index + 1}` : null,
          };
        }
        await page.setViewportSize({ width, height: 900 });
        await page.goto(canvas.url);
        const rows = page.locator(".row");
        await expect(rows).toHaveCount(4);
        if (width === 320) {
          expect((await rows.first().boundingBox()).y).toBeLessThanOrEqual(290);
          await expect(page.locator("h1")).toHaveCSS("font-size", "24px");
          for (const selector of ["#force-refresh", "#settings-toggle"]) {
            await expect(page.locator(selector)).toHaveCSS("width", "38px");
            await expect(page.locator(selector)).toHaveCSS("height", "38px");
          }
          const header = await page.locator(".repo-header").boundingBox();
          expect(header.height).toBeLessThanOrEqual(60);
          const actions = await page.locator(".repo-actions").boundingBox();
          const toggle = await page.locator(".repo-toggle").boundingBox();
          expect(actions.y + actions.height).toBeLessThanOrEqual(toggle.y + toggle.height);
        }
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
          await expect(rows.nth(index).getByRole("button")).toHaveCount([3, 3, 2, 3][index]);
        }
        expect((await page.locator(".repo-read").boundingBox()).x).toBeCloseTo(read.x);
        expect((await page.locator(".repo-done").boundingBox()).x).toBeCloseTo(done.x);
        await expect(rows.nth(1).locator(".mark-read")).toBeDisabled();
        await expect(rows.nth(3).locator(".copilot-action")).toBeDisabled();
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
