export class InboxError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const DEFAULT_API_BASE_URL = "https://api.github.com";

export function apiTarget(value = DEFAULT_API_BASE_URL) {
  let url;
  try {
    if (typeof value !== "string" || value.length > 2048 ||
        !/^https:\/\/[^\s\\%?#@{}]+$/.test(value) || /\/\.{1,2}(?:\/|$)/.test(value)) throw new Error();
    url = new URL(value);
    if (!url.hostname || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname)) throw new Error();
  } catch {
    throw new InboxError("invalid_api", "Use an HTTPS REST API base URL without credentials, query parameters, fragments, or encoded paths.", 400);
  }
  if (url.hostname.includes(":")) {
    throw new InboxError("invalid_api", "Use a DNS hostname or IPv4 address for the API. GitHub CLI does not support IPv6 literal hosts.", 400);
  }
  const prefix = url.pathname.replace(/\/$/, "");
  const baseUrl = `${url.origin}${prefix}`;
  const custom = baseUrl !== DEFAULT_API_BASE_URL;
  return Object.freeze({
    baseUrl, origin: url.origin, prefix, custom,
    hostname: custom ? url.hostname : "github.com",
    webOrigin: custom ? url.origin : "https://github.com",
  });
}

export const attentionFilters = [
  { value: "all", label: "All", reasons: [] },
  { value: "assigned", label: "Assigned", reasons: ["assign"] },
  { value: "participating", label: "Participating", reasons: [
    "comment", "mention", "author", "team_mention", "assign", "manual",
    "state_change", "invitation", "review_requested", "security_advisory_credit",
  ] },
  { value: "mentioned", label: "Mentioned", reasons: ["mention"] },
  { value: "team_mentioned", label: "Team Mentioned", reasons: ["team_mention"] },
  { value: "review_requested", label: "Review Requested", reasons: ["review_requested"] },
];

export const filterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["inbox", "unread"] },
    query: { type: "string", maxLength: 200 },
    attention: { type: "string", enum: attentionFilters.map(filter => filter.value) },
  },
};

export const emptySchema = { type: "object", properties: {}, additionalProperties: false };

export function validateFilters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["mode", "query", "attention"].includes(key)) ||
      (input.mode !== undefined && !["inbox", "unread"].includes(input.mode)) ||
      (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200)) ||
      (input.attention !== undefined && !attentionFilters.some(filter => filter.value === input.attention))) {
    throw new InboxError("invalid_filters", "Choose inbox or unread notifications. Search must be at most 200 characters. Choose a supported attention filter.", 400);
  }
  return input;
}

function repoName(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    ![".", ".."].includes(value.split("/")[1]);
}

function parsedURL(value, origin) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password &&
      !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

export function reportedWorkflow(title) {
  if (typeof title !== "string") return null;
  const match = /^(.+?) workflow run(?:, Attempt #([1-9]\d*))? (succeeded|failed at startup|failed|cancelled|timed out|skipped) for (.+)$/.exec(title);
  if (!match) return null;
  const [, name, attempt, outcome, ref] = match;
  const branch = ref.endsWith(" branch") ? ref.slice(0, -" branch".length) : null;
  const attemptNumber = Number(attempt ?? 1);
  return {
    name,
    attempt: attemptNumber,
    state: { succeeded: "success", failed: "failure", cancelled: "cancelled",
      "timed out": "timed_out", skipped: "skipped", "failed at startup": "startup_failure" }[outcome],
    // Unknown title formats and search syntax characters must not broaden a fallback search.
    branch: branch && branch.length <= 255 && name.length <= 256 &&
      !/[\p{Cc}"\\]/u.test(name) && !/[\s\p{Cc}"\\]/u.test(branch) &&
      Number.isSafeInteger(attemptNumber) ? branch : null,
  };
}

export function notificationLink(subject, repository, target = apiTarget()) {
  const fallback = { url: `${target.webOrigin}/notifications`, label: "Open GitHub inbox", direct: false, number: null };
  if (!repoName(repository)) return fallback;
  const base = `${target.webOrigin}/${repository}`;
  const api = parsedURL(subject.url, target.origin);
  const prefix = `${target.prefix}/repos/${repository}/`;
  const path = api?.pathname.startsWith(prefix) ? api.pathname.slice(prefix.length) : "";
  const routes = {
    Issue: [/^issues\/([1-9]\d*)$/, "issues"],
    PullRequest: [/^pulls\/([1-9]\d*)$/, "pull"],
    Commit: [/^commits\/([a-fA-F0-9]{7,64})$/, "commit"],
    Discussion: [/^discussions\/([1-9]\d*)$/, "discussions"],
  };
  const route = Object.hasOwn(routes, subject.type) ? routes[subject.type] : undefined;
  const match = route && path.match(route[0]);
  if (match) return {
    url: `${base}/${route[1]}/${match[1]}`, label: "Open on GitHub", direct: true,
    number: ["Issue", "PullRequest"].includes(subject.type) ? match[1] : null,
    ...(subject.type === "Discussion" ? { discussionNumber: match[1] } : {}),
  };

  // Release IDs are not tags; check-suite IDs are not Actions run IDs.
  if (subject.type === "Release") {
    return { url: `${base}/releases`, label: "Open repository releases", direct: false, number: null };
  }
  if (subject.type === "CheckSuite") {
    const runId = path.match(/^actions\/runs\/([1-9]\d*)$/)?.[1];
    if (runId) return {
      url: `${base}/actions/runs/${runId}`, label: "Open workflow run results", direct: true, number: null,
      checkSuiteId: null, runId,
    };
    const workflow = reportedWorkflow(subject.title);
    const query = workflow?.branch ? new URLSearchParams({
      query: `workflow:"${workflow.name}" branch:"${workflow.branch}" is:${workflow.state === "startup_failure" ? "failure" : workflow.state}`,
    }) : null;
    return {
      url: `${base}/actions${query ? `?${query}` : ""}`,
      label: query ? "Open filtered repository Actions" : "Open repository Actions", direct: false, number: null,
      checkSuiteId: path.match(/^check-suites\/([1-9]\d*)$/)?.[1] ?? null,
    };
  }
  return fallback;
}

export function notificationTitle(thread, fallback = "") {
  const title = thread.title || fallback;
  return thread.number ? `#${thread.number}${title ? ` ${title}` : ""}` : title;
}

export function normalizeThreads(body, target = apiTarget()) {
  if (!Array.isArray(body)) throw new InboxError("invalid_response", "GitHub returned an invalid notifications list.");
  return body.map(thread => {
    if (!thread || !/^\d+$/.test(thread.id) || typeof thread.id !== "string" ||
        !repoName(thread.repository?.full_name) ||
        typeof thread.subject?.title !== "string" || thread.subject.title.length > 16384 ||
        typeof thread.subject?.type !== "string" || thread.subject.type.length > 128 ||
        typeof thread.reason !== "string" || thread.reason.length > 128 ||
        typeof thread.unread !== "boolean" || typeof thread.updated_at !== "string" ||
        !Number.isFinite(Date.parse(thread.updated_at))) {
      throw new InboxError("invalid_response", "GitHub returned a malformed notification; the previous inbox was kept.");
    }
    return {
      id: thread.id,
      repository: thread.repository.full_name,
      title: thread.subject.title,
      type: thread.subject.type,
      reason: thread.reason,
      unread: thread.unread,
      updatedAt: new Date(thread.updated_at).toISOString(),
      ...notificationLink(thread.subject, thread.repository.full_name, target),
    };
  });
}

export function uniqueThreads(threads, compareFreshness = (a, b) => a.updatedAt.localeCompare(b.updatedAt)) {
  // A newer duplicate replaces the data, not its first-seen API position.
  const unique = new Map();
  for (const thread of threads) {
    const previous = unique.get(thread.id);
    if (!previous || compareFreshness(previous, thread) <= 0) unique.set(thread.id, thread);
  }
  return [...unique.values()];
}

export function orderedThreads(threads) {
  return uniqueThreads(threads).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function dateLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric",
  });
}

export function groupThreadsByDate(threads, timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 128) {
    throw new InboxError("invalid_time_zone", "Choose a supported calendar time zone.", 400);
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch (error) {
    if (error instanceof RangeError) throw new InboxError("invalid_time_zone", "Choose a supported calendar time zone.", 400);
    throw error;
  }
  const groups = new Map();
  for (const item of uniqueThreads(threads)) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(item.updatedAt)).map(({ type, value }) => [type, value]));
    const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
    let group = groups.get(date);
    if (!group) {
      group = { key: `date:${parts.year}-${Number(parts.month)}-${Number(parts.day)}`, date, timeZone, label: dateLabel(date), unread: 0, items: [] };
      groups.set(date, group);
    }
    group.items.push(item);
    group.unread += Number(item.unread);
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function searchThreads(threads, query) {
  const search = query.trim().toLocaleLowerCase();
  return uniqueThreads(threads).filter(thread =>
    !search || `${notificationTitle(thread)}\n${thread.repository}`.toLocaleLowerCase().includes(search));
}

export function attentionCounts(threads) {
  const items = uniqueThreads(threads);
  return Object.fromEntries(attentionFilters.map(({ value, reasons }) => [
    value, value === "all" ? items.length : items.filter(thread => reasons.includes(thread.reason)).length,
  ]));
}

export function groupThreads(threads, { query, attention = "all" }) {
  const groups = new Map();
  const filter = attentionFilters.find(filter => filter.value === attention);
  if (!filter) throw new InboxError("invalid_filters", "Choose a supported attention filter.", 400);
  for (const thread of searchThreads(threads, query)) {
    if (attention !== "all" && !filter.reasons.includes(thread.reason)) continue;
    let group = groups.get(thread.repository);
    if (!group) {
      group = { repository: thread.repository, unread: 0, items: [] };
      groups.set(thread.repository, group);
    }
    group.items.push(thread);
    group.unread += Number(thread.unread);
  }
  return [...groups.values()];
}
