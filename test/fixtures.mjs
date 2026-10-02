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

export function http(body = [], headers = {}, status = 200) {
  return `HTTP/2.0 ${status} Synthetic\r\n${Object.entries({ "content-type": "application/json", ...headers }).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${status === 304 ? "" : JSON.stringify(body)}`;
}

export const next = '<https://api.github.com/notifications?all=false&per_page=50&page=2>; rel="next"';
