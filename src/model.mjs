export class InboxError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const filterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["unread"] },
    query: { type: "string", maxLength: 200 },
  },
};

export const emptySchema = { type: "object", properties: {}, additionalProperties: false };

export function validateFilters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["mode", "query"].includes(key)) ||
      (input.mode !== undefined && input.mode !== "unread") ||
      (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200))) {
    throw new InboxError("invalid_filters", "Only unread notifications are supported. Search must be at most 200 characters.", 400);
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

export function notificationLink(subject, repository) {
  const fallback = { url: "https://github.com/notifications", label: "Open GitHub inbox", direct: false };
  if (!repoName(repository)) return fallback;
  const base = `https://github.com/${repository}`;
  const api = parsedURL(subject.url, "https://api.github.com");
  const prefix = `/repos/${repository}/`;
  const path = api?.pathname.startsWith(prefix) ? api.pathname.slice(prefix.length) : "";
  const routes = {
    Issue: [/^issues\/([1-9]\d*)$/, "issues"],
    PullRequest: [/^pulls\/([1-9]\d*)$/, "pull"],
    Commit: [/^commits\/([a-fA-F0-9]{7,64})$/, "commit"],
    Discussion: [/^discussions\/([1-9]\d*)$/, "discussions"],
  };
  const route = Object.hasOwn(routes, subject.type) ? routes[subject.type] : undefined;
  const match = route && path.match(route[0]);
  if (match) return { url: `${base}/${route[1]}/${match[1]}`, label: "Open on GitHub", direct: true };

  // Release IDs are not tags; check-suite IDs are not Actions run IDs.
  if (subject.type === "Release") {
    return { url: `${base}/releases`, label: "Open repository releases", direct: false };
  }
  if (subject.type === "CheckSuite") {
    return { url: `${base}/actions`, label: "Open repository Actions", direct: false };
  }
  return fallback;
}

export function normalizeThreads(body) {
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
      ...notificationLink(thread.subject, thread.repository.full_name),
    };
  });
}

export function orderedThreads(threads) {
  const unique = new Map();
  for (const thread of threads) {
    const previous = unique.get(thread.id);
    if (!previous || previous.updatedAt <= thread.updatedAt) unique.set(thread.id, thread);
  }
  return [...unique.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function groupThreads(threads, { query }) {
  const groups = new Map();
  const search = query.trim().toLocaleLowerCase();
  for (const thread of orderedThreads(threads)) {
    if (!thread.unread) continue;
    if (search && !`${thread.title}\n${thread.repository}`.toLocaleLowerCase().includes(search)) continue;
    let group = groups.get(thread.repository);
    if (!group) {
      group = { repository: thread.repository, unread: 0, items: [] };
      groups.set(thread.repository, group);
    }
    group.items.push(thread);
    group.unread++;
  }
  return [...groups.values()].sort((a, b) => a.repository.localeCompare(b.repository));
}
