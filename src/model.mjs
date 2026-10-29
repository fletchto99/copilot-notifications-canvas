export const TRIAGE_CONSENT_VERSION = 1;

export class InboxError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const attentionFilters = [
  { value: "all", label: "All", reasons: [] },
  { value: "review_requested", label: "Review requested", reasons: ["review_requested"] },
  { value: "mentioned", label: "Mentioned", reasons: ["mention", "team_mention"] },
  { value: "assigned", label: "Assigned", reasons: ["assign"] },
  { value: "participating", label: "Participating", reasons: ["author", "comment"] },
];

export const filterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["unread"] },
    query: { type: "string", maxLength: 200 },
    attention: { type: "string", enum: attentionFilters.map(filter => filter.value) },
  },
};

export const emptySchema = { type: "object", properties: {}, additionalProperties: false };

export function validateFilters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["mode", "query", "attention"].includes(key)) ||
      (input.mode !== undefined && input.mode !== "unread") ||
      (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 200)) ||
      (input.attention !== undefined && !attentionFilters.some(filter => filter.value === input.attention))) {
    throw new InboxError("invalid_filters", "Only unread notifications are supported. Search must be at most 200 characters. Choose a supported attention filter.", 400);
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
  const fallback = { url: "https://github.com/notifications", label: "Open GitHub inbox", direct: false, number: null };
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
  if (match) return {
    url: `${base}/${route[1]}/${match[1]}`, label: "Open on GitHub", direct: true,
    number: ["Issue", "PullRequest"].includes(subject.type) ? match[1] : null,
  };

  // Release IDs are not tags; check-suite IDs are not Actions run IDs.
  if (subject.type === "Release") {
    return { url: `${base}/releases`, label: "Open repository releases", direct: false, number: null };
  }
  if (subject.type === "CheckSuite") {
    return { url: `${base}/actions`, label: "Open repository Actions", direct: false, number: null };
  }
  return fallback;
}

export function notificationTitle(thread, fallback = "") {
  const title = thread.title || fallback;
  return thread.number ? `#${thread.number}${title ? ` ${title}` : ""}` : title;
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
  for (const item of orderedThreads(threads)) {
    if (!item.unread) continue;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(item.updatedAt)).map(({ type, value }) => [type, value]));
    const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
    let group = groups.get(date);
    if (!group) {
      group = { key: `date:${parts.year}-${Number(parts.month)}-${Number(parts.day)}`, date, timeZone, label: dateLabel(date), unread: 0, items: [] };
      groups.set(date, group);
    }
    group.items.push(item);
    group.unread++;
  }
  return [...groups.values()];
}

function searchThreads(threads, query) {
  const search = query.trim().toLocaleLowerCase();
  return orderedThreads(threads).filter(thread => thread.unread &&
    (!search || `${notificationTitle(thread)}\n${thread.repository}`.toLocaleLowerCase().includes(search)));
}

export function attentionCounts(threads) {
  const unread = orderedThreads(threads).filter(thread => thread.unread);
  return Object.fromEntries(attentionFilters.map(({ value, reasons }) => [
    value, value === "all" ? unread.length : unread.filter(thread => reasons.includes(thread.reason)).length,
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
    group.unread++;
  }
  return [...groups.values()].sort((a, b) => a.repository.localeCompare(b.repository));
}
