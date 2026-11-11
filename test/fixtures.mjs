export function thread(id = "1", overrides = {}) {
  return {
    id,
    unread: true,
    reason: "review_requested",
    updated_at: "2026-01-10T12:00:00Z",
    repository: { full_name: "example/widgets" },
    subject: { title: `Synthetic notification ${id}`, type: "PullRequest", url: "https://api.github.com/repos/example/widgets/pulls/42" },
    ...overrides,
  };
}

export const staticSubjectTypes = [
  "Release", "Commit", "RepositoryAdvisory", "RepositoryVulnerabilityAlert",
  "RepositoryDependabotAlertsThread", "RepositoryInvitation", "WorkflowRun", "AgentSessionThread",
];

export function http(body = [], headers = {}, status = 200) {
  return `HTTP/2.0 ${status} Synthetic\r\n${Object.entries({ "content-type": "application/json", ...headers }).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${status === 304 ? "" : JSON.stringify(body)}`;
}

export function retrySelection(inbox, input) {
  const batch = inbox.batch.snapshots().find(batch => batch.token === input.token);
  return { ...input, selectionKey: batch?.retrySelectionKey };
}

export function workflowRun(overrides = {}) {
  return {
    id: 123, name: "Synthetic build", head_branch: "main", run_attempt: 1,
    status: "completed", conclusion: "failure",
    created_at: "2026-01-10T11:58:00Z", updated_at: "2026-01-10T11:59:39Z",
    html_url: "https://github.com/example/widgets/actions/runs/123",
    ...overrides,
  };
}

export function workflowJob(overrides = {}) {
  return {
    id: 456, run_id: 123, run_attempt: 1, status: "completed", conclusion: "failure",
    html_url: "https://github.com/example/widgets/actions/runs/123/job/456",
    ...overrides,
  };
}

export const next = '<https://api.github.com/notifications?all=false&per_page=50&page=2>; rel="next"';
export const inboxNext = next.replace("all=false", "all=true&is_done=false");
