import { thread, workflowRun } from "./fixtures.mjs";

export const readmeTime = Date.parse("2026-01-10T12:00:00Z");
export const readmeContext = {
  viewport: { width: 735, height: 1000 },
  deviceScaleFactor: 2,
  locale: "en-US",
  timezoneId: "UTC",
  colorScheme: "dark",
  reducedMotion: "reduce",
  forcedColors: "none",
  serviceWorkers: "block",
};
export const readmePreferences = {
  matchGitHubInbox: true,
  groupBy: "repo",
  darkMode: true,
  hideEmptyTabs: true,
  keyboardShortcuts: true,
  copilotIntegration: true,
  confirmCopilotActions: true,
  autoOpen: false,
  desktopNotifications: false,
};
export const readmeRepositories = ["example/atlas", "example/design-system", "example/cli"];
export const readmeSubjectLabels = [
  "Pull Request: In merge queue", "Issue: Open", "Release", "Pull Request: Merged",
  "Pull Request: Draft", "Discussion: Closed", "Issue: Closed", "Check Suite: Failed",
  "Repository Dependabot Alerts Thread", "Discussion: Answered",
];

export function readmeRows() {
  const row = (id, repository, title, type, path, minutesAgo, reason, details = {}) => thread(id, {
    repository: { full_name: repository },
    subject: { title, type, url: path ? `https://api.github.com/repos/${repository}/${path}` : null },
    updated_at: new Date(readmeTime - minutesAgo * 60_000).toISOString(),
    reason,
    ...details,
  });
  return [
    row("1", "example/atlas", "Add keyboard shortcuts to the command menu", "PullRequest", "pulls/248", 4,
      "review_requested", { mergeQueued: true, subjectDetails: { state: "open", merged: false, draft: false } }),
    row("2", "example/atlas", "Keep search filters when navigating back", "Issue", "issues/241", 18,
      "mention", { authoredByViewer: true, subjectDetails: { state: "open" } }),
    row("3", "example/atlas", "v1.2.0", "Release", null, 30, "subscribed"),
    row("4", "example/atlas", "Improve empty states across the dashboard", "PullRequest", "pulls/237", 42,
      "comment", { unread: false, subjectDetails: { state: "closed", merged: true, draft: false } }),
    row("5", "example/design-system", "Add a compact variant for notification badges", "PullRequest", "pulls/86", 60,
      "team_mention", { subjectDetails: { state: "open", merged: false, draft: true, user: { id: 7 } } }),
    row("6", "example/design-system", "Resolve the notification badge design", "Discussion", "discussions/85", 120,
      "assign", { authoredByViewer: true, subjectDetails: { closed: true, isAnswered: false, stateReason: "RESOLVED" } }),
    row("7", "example/design-system", "Document focus styles for interactive cards", "Issue", "issues/79", 180,
      "author", { unread: false, authoredByViewer: true, subjectDetails: { state: "closed", state_reason: "completed" } }),
    row("8", "example/cli", "CI / Node.js 24 tests failed on main", "CheckSuite", "check-suites/310", 240,
      "ci_activity", {
        subjectDetails: { status: "completed", conclusion: "failure" },
        workflowRunResults: { total_count: 1, workflow_runs: [workflowRun({
          id: 3100, check_suite_id: 310, html_url: "https://github.com/example/cli/actions/runs/3100",
          repository: { full_name: "example/cli" }, head_sha: "a".repeat(40),
        })] },
      }),
    row("9", "example/cli", "Update the dependency used by the command runner", "RepositoryDependabotAlertsThread",
      null, 300, "security_alert"),
    row("10", "example/cli", "Configuration question answered in the quickstart", "Discussion", "discussions/64", 1440,
      "subscribed", { unread: false, subjectDetails: { closed: false, isAnswered: true, stateReason: null } }),
  ];
}
