import { execFile } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { apiTarget, DEFAULT_API_BASE_URL, InboxError, normalizeThreads, notificationLink, reportedWorkflow } from "./model.mjs";

export const POLL_MS = 60_000;
export const RETRY_MS = 120_000;
export const SUBJECT_POLL_MS = 5 * 60_000;
export const WRITE_CONCURRENCY = 10;
const API_ORIGIN = DEFAULT_API_BASE_URL;
const MERGE_QUEUE_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}";
const DISCUSSION_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){closed isAnswered stateReason}}}";
const RUN_MATCH_WINDOW_MS = 2 * 60_000;
const RUN_SEARCH_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const FAILED_CHECK_STATES = ["failure", "timed_out", "startup_failure"];
const SUBJECT_CONCURRENCY = 20;
const SECONDARY_LIMIT = /secondary(?: rate)? limit|abuse detection/i;

function subjectEndpoint(item, target) {
  const checkSuite = item.type === "CheckSuite";
  const discussion = item.type === "Discussion";
  const id = checkSuite ? item.runId ?? item.checkSuiteId : discussion ? item.discussionNumber : item.number;
  if (!["Issue", "PullRequest", "CheckSuite", "Discussion"].includes(item.type) || !id || discussion && target.custom) return null;
  const resource = checkSuite ? item.runId ? "actions/runs" : "check-suites" :
    discussion ? "discussions" : item.type === "Issue" ? "issues" : "pulls";
  const endpoint = `/repos/${item.repository}/${resource}/${id}`;
  const link = notificationLink({ type: item.type, url: `${target.baseUrl}${endpoint}` }, item.repository, target);
  return (checkSuite ? link.runId ?? link.checkSuiteId : discussion ? link.discussionNumber : link.number) === id ? endpoint : null;
}

function workflowRunSearch(item, target) {
  if (item.type !== "CheckSuite" || item.runId || item.checkSuiteId) return null;
  const workflow = reportedWorkflow(item.title);
  const time = Date.parse(item.updatedAt);
  if (!workflow?.branch || !Number.isFinite(time)) return null;
  const base = `/repos/${item.repository}/actions/runs`;
  if (notificationLink({ type: "CheckSuite", url: `${target.baseUrl}${base}/1` }, item.repository, target).runId !== "1") return null;
  const since = time - RUN_SEARCH_LOOKBACK_MS;
  const until = time + RUN_MATCH_WINDOW_MS;
  if (!Number.isFinite(new Date(since).getTime()) || !Number.isFinite(new Date(until).getTime())) return null;
  const query = new URLSearchParams({
    branch: workflow.branch, created: `${new Date(since).toISOString()}..${new Date(until).toISOString()}`, per_page: "100",
  });
  const path = `${base}?${query}`;
  return { ...workflow, path, time, since, until, repository: item.repository,
    key: JSON.stringify([path, workflow.name, workflow.attempt, workflow.state]) };
}

function subjectKey(item, target) {
  return subjectEndpoint(item, target) ?? workflowRunSearch(item, target)?.key;
}

function workflowRunURL(run, repository, target, attempt) {
  const url = `${target.webOrigin}/${repository}/actions/runs/${run.id}`;
  if (!(typeof run.id === "string" || Number.isSafeInteger(run.id)) || !/^[1-9]\d*$/.test(String(run.id)) ||
      run.html_url !== url || attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
    throw new InboxError("run_results_unavailable", "GitHub did not provide an unambiguous workflow run for this check suite.");
  }
  return attempt === undefined ? url : `${url}/attempts/${attempt}`;
}

function checkRunLink(body, endpoint, target) {
  const match = /^\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/check-suites\/([1-9]\d*)$/.exec(endpoint);
  const invalid = () => new InboxError("run_results_unavailable", "GitHub did not provide an unambiguous workflow run for this check suite.");
  if (!match || !Array.isArray(body?.workflow_runs)) throw invalid();
  if (body.total_count === 0 && body.workflow_runs.length === 0) return null;
  const run = body.workflow_runs[0];
  if (body.total_count !== 1 || body.workflow_runs.length !== 1 || !run ||
      !(typeof run.check_suite_id === "string" || Number.isSafeInteger(run.check_suite_id)) ||
      String(run.check_suite_id) !== match[3]) throw invalid();
  return workflowRunURL(run, `${match[1]}/${match[2]}`, target, run.run_attempt);
}

function inferredRunLink(body, search, target, link) {
  const invalid = () => new InboxError("run_match_unavailable",
    "GitHub did not provide a complete, valid set of workflow runs for matching. Use filtered Actions instead.");
  if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.workflow_runs) ||
      body.total_count > 100 || body.workflow_runs.length !== body.total_count || /rel="next"/.test(link ?? "")) throw invalid();
  const candidates = [];
  for (const run of body.workflow_runs) {
    if (!run || !(typeof run.name === "string" || run.name === null) ||
        !(typeof run.head_branch === "string" || run.head_branch === null)) throw invalid();
    if (run.name !== search.name || run.head_branch !== search.branch) continue;
    const updated = typeof run.updated_at === "string" ? Date.parse(run.updated_at) : NaN;
    const created = typeof run.created_at === "string" ? Date.parse(run.created_at) : NaN;
    if (!Number.isFinite(updated) || !Number.isFinite(created) || created > updated ||
        created < search.since || created > search.until) throw invalid();
    if (Math.abs(updated - search.time) <= RUN_MATCH_WINDOW_MS) candidates.push(run);
  }
  // A conflicting nearby run is ambiguous even if its result or attempt differs.
  if (candidates.length !== 1) return null;
  const run = candidates[0];
  if (run.status !== "completed" || run.conclusion !== search.state || run.run_attempt !== search.attempt) return null;
  return workflowRunURL(run, search.repository, target, search.attempt);
}

function failedJobLink(body, search, target, link) {
  const invalid = () => new InboxError("job_logs_unavailable",
    "GitHub did not provide a complete, valid job list for this run. Open the run summary instead.");
  if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.jobs) ||
      body.total_count > 100 || body.jobs.length !== body.total_count || /rel="next"/.test(link ?? "")) throw invalid();
  const ids = new Set();
  const failed = [];
  let pending = false;
  for (const job of body.jobs) {
    if (!job || !(typeof job.id === "string" || Number.isSafeInteger(job.id)) || !/^[1-9]\d*$/.test(String(job.id)) ||
        !(typeof job.run_id === "string" || Number.isSafeInteger(job.run_id)) || String(job.run_id) !== search.runId ||
        !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 ||
        search.attempt && String(job.run_attempt) !== search.attempt || ids.has(String(job.id))) throw invalid();
    ids.add(String(job.id));
    const state = subjectState(job, "CheckSuite");
    pending ||= job.status !== "completed";
    if (FAILED_CHECK_STATES.includes(state)) failed.push(job);
  }
  if (pending || failed.length !== 1) return null;
  const job = failed[0];
  const url = `${target.webOrigin}/${search.repository}/actions/runs/${search.runId}/job/${job.id}`;
  if (job.html_url !== url) throw invalid();
  return url;
}

function runSnapshot(run, inferred = false, jobs) {
  return {
    ...(run?.state ? {
      url: jobs?.state ?? run.state,
      subjectRunUrl: jobs?.state && jobs.runUrl ? jobs.runUrl : run.state,
      label: jobs?.state ? inferred ? "Open failed job logs for inferred workflow run" : "Open failed job logs"
        : inferred ? "Open inferred workflow run results" : "Open workflow run results",
      direct: true,
      ...(inferred ? { subjectLinkSource: "inferred" } : {}),
      ...(jobs?.state ? { subjectLinkTarget: "job" } : {}),
    } : {}),
    ...(run?.error ? { subjectLinkError: `Run results link unavailable. ${run.error.message}` } : {}),
    ...(jobs?.error ? { subjectLinkError: `Job logs link unavailable. ${jobs.error.message}` } : {}),
  };
}

function rateLimitError(graphql = false) {
  return new InboxError(graphql ? "graphql_rate_limited" : "rate_limited", graphql
    ? "GitHub GraphQL rate limit reached. Discussion and merge queue checks are paused; inbox requests remain available."
    : "GitHub rate limit reached. Requests are paused; wait for the retry time.", 429);
}

function checkGraphQLRateLimit(body, secondaryLimit) {
  if (Array.isArray(body?.errors)) {
    const secondary = secondaryLimit || body.errors.some(error => typeof error?.message === "string" && SECONDARY_LIMIT.test(error.message));
    if (secondary || body.errors.some(error => error?.type === "RATE_LIMITED")) throw rateLimitError(!secondary);
  }
}

function mergeQueueState(body, secondaryLimit = false) {
  checkGraphQLRateLimit(body, secondaryLimit);
  const state = body?.data?.repository?.pullRequest?.isInMergeQueue;
  if (body?.errors || typeof state !== "boolean") {
    throw new InboxError("merge_queue_unavailable", "Merge queue status is unavailable. Check repository access and organization SSO.");
  }
  return state;
}

function discussionState(body, secondaryLimit) {
  checkGraphQLRateLimit(body, secondaryLimit);
  const discussion = body?.data?.repository?.discussion;
  if (body?.errors || typeof discussion?.closed !== "boolean" ||
      !(typeof discussion.isAnswered === "boolean" || discussion.isAnswered === null) ||
      ![null, "RESOLVED", "DUPLICATE", "OUTDATED", "REOPENED"].includes(discussion.stateReason) ||
      discussion.closed && discussion.stateReason === "REOPENED" ||
      !discussion.closed && ![null, "REOPENED"].includes(discussion.stateReason)) {
    throw new InboxError("discussion_unavailable", "Discussion status is unavailable. Check repository access and organization SSO.");
  }
  if (!discussion.closed) return discussion.isAnswered ? "answered" : "open";
  return discussion.stateReason === "DUPLICATE" ? "duplicate" : discussion.stateReason === "OUTDATED" ? "outdated" : "closed";
}

function subjectState(body, type) {
  if (type === "CheckSuite") {
    if (!["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(body?.status) ||
        body.status === "completed" && !["success", "failure", "neutral", "cancelled", "skipped",
          "timed_out", "action_required", "startup_failure", "stale"].includes(body.conclusion)) {
      throw new InboxError("invalid_response", "GitHub did not provide a supported check suite status or result.");
    }
    return body.status === "completed" ? body.conclusion : body.status;
  }
  if (!body || !["open", "closed"].includes(body.state) ||
      (type === "PullRequest" && (typeof body.merged !== "boolean" || typeof body.draft !== "boolean" ||
        body.merged && body.state !== "closed"))) {
    throw new InboxError("invalid_response", "GitHub returned an invalid issue or pull request status.");
  }
  if (type === "PullRequest") return body.merged ? "merged" : body.state === "closed" ? "closed" : body.draft ? "draft" : "open";
  return body.state === "closed" && ["not_planned", "duplicate"].includes(body.state_reason) ? body.state_reason : body.state;
}

function copilotDetails(body, kind, endpoint) {
  const invalid = () => new InboxError("copilot_context", "GitHub did not provide verified context for this Copilot action.");
  if (kind === "viewer") {
    if (!Number.isSafeInteger(body?.id) || body.id < 1) throw invalid();
    return { id: body.id };
  }
  if (kind === "pull") {
    subjectState(body, "PullRequest");
    if (!Number.isSafeInteger(body.user?.id) || body.user.id < 1 || !/^[a-f0-9]{40}$/.test(body.head?.sha)) throw invalid();
    return { authorId: body.user.id, state: body.state, merged: body.merged, sha: body.head.sha };
  }
  const match = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/.exec(endpoint);
  if (!match || String(body?.id) !== match[2] || body.repository?.full_name?.toLowerCase() !== match[1].toLowerCase() ||
      body.html_url !== `https://github.com/${match[1]}/actions/runs/${match[2]}` ||
      !/^[a-f0-9]{40}$/.test(body.head_sha) || !Number.isSafeInteger(body.run_attempt) || body.run_attempt < 1 ||
      match[3] !== undefined && String(body.run_attempt) !== match[3] ||
      !FAILED_CHECK_STATES.includes(subjectState(body, "CheckSuite"))) throw invalid();
  return { runId: match[2], sha: body.head_sha, attempt: body.run_attempt, url: `${body.html_url}/attempts/${body.run_attempt}` };
}

export function firstPage({ mode = "unread", matchGitHubInbox = true } = {}) {
  const inbox = mode === "inbox" && matchGitHubInbox;
  return `/notifications?all=${inbox ? "true&is_done=false" : "false"}&per_page=50&page=1`;
}

function endpointURL(endpoint, target = apiTarget()) {
  let url;
  try {
    url = new URL(endpoint, target.origin);
  } catch {
    throw new InboxError("invalid_pagination", "GitHub returned an invalid pagination link.");
  }
  const keys = [...url.searchParams.keys()];
  const all = url.searchParams.get("all");
  const done = url.searchParams.get("is_done");
  if (url.origin !== target.origin || url.username || url.password || url.hash ||
      url.pathname !== `${target.prefix}/notifications` || keys.length !== (done === null ? 3 : 4) ||
      new Set(keys).size !== keys.length ||
      !keys.every(key => ["all", "is_done", "per_page", "page"].includes(key)) ||
      !(all === "false" && done === null || all === "true" && done === "false") ||
      url.searchParams.get("per_page") !== "50" ||
      !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "") ||
      !Number.isSafeInteger(Number(url.searchParams.get("page")))) {
    throw new InboxError("invalid_pagination", "GitHub returned an unsafe or unsupported pagination link.");
  }
  url.searchParams.sort();
  return url;
}

export function nextPage(header, currentEndpoint, target = apiTarget()) {
  if (!header) return null;
  const links = header.split(",");
  const next = links.filter(link => /;\s*rel="next"(?:\s*;|\s*$)/.test(link));
  if (!next.length) {
    if (links.some(link => !/^\s*<[^>]+>;\s*rel="(?:prev|first|last)"\s*$/.test(link))) {
      throw new InboxError("invalid_pagination", "GitHub returned an unreadable pagination header.");
    }
    return null;
  }
  const match = next.length === 1 && next[0].match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
  if (!match) throw new InboxError("invalid_pagination", "GitHub returned an unreadable next-page link.");
  const url = endpointURL(match[1], target);
  const current = endpointURL(currentEndpoint);
  if (url.searchParams.get("all") !== current.searchParams.get("all") ||
      url.searchParams.get("is_done") !== current.searchParams.get("is_done") ||
      Number(url.searchParams.get("page")) !== Number(current.searchParams.get("page")) + 1) {
    throw new InboxError("invalid_pagination", "GitHub returned an inconsistent next-page link.");
  }
  return `/notifications${url.search}`;
}

export function parseResponse(stdout) {
  if (typeof stdout !== "string") throw new InboxError("invalid_response", "No HTTP response from GitHub CLI.");
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) throw new InboxError("invalid_response", "GitHub CLI returned an unreadable HTTP response.");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})(?:\s|$)/.exec(lines.shift());
  if (!status) throw new InboxError("invalid_response", "GitHub CLI returned an unreadable HTTP status.");
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new InboxError("invalid_response", "GitHub CLI returned malformed HTTP headers.");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const text = stdout.slice(separator.index + separator[0].length);
  return { status: Number(status[1]), headers, text };
}

export function runGh(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    delete env.GH_DEBUG;
    delete env.DEBUG;
    execFile("gh", args, { env, signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (signal?.aborted) return reject(new InboxError("closed", "The canvas was closed.", 410));
        if (error.code === "ENOENT") {
          return reject(new InboxError("gh_missing", "Install GitHub CLI (gh), then restart the Copilot app.", 503));
        }
        if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new InboxError("gh_timeout", "GitHub CLI timed out or exceeded its response limit. Try again.", 504));
        }
        // gh exits nonzero on HTTP errors, but --include still supplies status and headers.
        if (/^HTTP\/[\d.]+\s+\d{3}/.test(stdout)) return resolve(stdout);
        if (/gh auth login|not logged|GH_TOKEN|authentication/i.test(stderr)) {
          const custom = args.includes("--hostname") && args[args.indexOf("--hostname") + 1] !== "github.com";
          return reject(new InboxError("authentication", custom
            ? "Sign in to the selected API host with gh auth login --hostname <host>. This view retries automatically while visible."
            : "Sign in with gh auth login --hostname github.com. This view retries automatically while visible.", 401));
        }
        reject(new InboxError("gh_failed", "GitHub CLI could not reach GitHub. Check your connection and gh auth status.", 502));
      });
  });
}

function seconds(value) {
  return /^\d+$/.test(value ?? "") ? Number(value) * 1000 : 0;
}

async function waitForWork(pending, signal) {
  if (!signal) return pending;
  let aborted;
  const interrupted = new Promise((resolve, reject) => {
    aborted = () => reject(new InboxError("closed", "The canvas was closed.", 410));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export class GitHubClient {
  constructor({ run = runGh, now = Date.now, sleep = wait, apiBaseUrl = API_ORIGIN, beforeRequest } = {}) {
    this.target = apiTarget(apiBaseUrl);
    this.run = run;
    this.now = now;
    this.beforeRequest = beforeRequest;
    this.cache = new Map();
    this.subjectCache = new Map();
    this.copilotCache = new Map();
    this.mergeQueueCache = new Map();
    this.checkRunCache = new Map();
    this.jobCache = new Map();
    this.subjectLinksReady = new Set();
    this.subjectWorkers = new Set();
    this.subjectWaiters = new Set();
    this.subjectRefreshes = new Set();
    this.subjectRequests = new Map();
    this.subjectInvalidations = new Map();
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.pageQueue = this.queue;
    this.writeWorkers = new Set();
    this.writeWaiters = new Set();
    this.blockedUntil = 0;
    // Only server retry/rate-limit delays may be inherited by another client.
    this.serverBlockedUntil = 0;
    this.graphqlBlockedUntil = 0;
    this.graphqlLastError = null;
    this.failures = new Map();
    this.lastError = null;
    this.sleep = sleep;
    this.pendingThreads = new Set();
    this.threadWrites = new Map();
    this.threadReservations = new Map();
    this.threadListeners = new Set();
    this.revision = 0;
  }

  subjectSnapshot(item) {
    if (!["Issue", "PullRequest", "CheckSuite", "Discussion"].includes(item.type)) return {};
    const endpoint = subjectEndpoint(item, this.target);
    const cached = this.subjectCache.get(endpoint);
    const jobSearch = this.#jobSearch(item);
    const jobs = jobSearch?.eligible ? this.jobCache.get(jobSearch.endpoint) : null;
    if (item.type === "CheckSuite" && !endpoint) {
      const state = reportedWorkflow(item.title)?.state;
      if (state) return {
        subjectState: state, subjectStateError: null, subjectStateSource: "notification",
        ...runSnapshot(this.checkRunCache.get(workflowRunSearch(item, this.target)?.key), true, jobs),
      };
    }
    const queue = item.type === "PullRequest" && cached?.state === "open" ? this.mergeQueueCache.get(endpoint) : null;
    const queueError = item.type === "PullRequest" && cached?.state === "open" && this.target.custom
      ? "Merge queue status is unavailable for custom development APIs." : queue?.error?.message ??
        (this.now() < this.graphqlBlockedUntil && item.type === "PullRequest" && cached?.state === "open"
          ? this.graphqlLastError?.message : undefined);
    const discussionError = item.type === "Discussion" ? this.target.custom
      ? "Discussion status is unavailable for custom development APIs."
      : this.now() < this.graphqlBlockedUntil ? this.graphqlLastError?.message : undefined : undefined;
    const checkedAt = cached?.checkedAt;
    const queueCheckedAt = typeof queue?.state === "boolean" ? queue.checkedAt : undefined;
    const run = item.type === "CheckSuite" ? item.runId && endpoint ? { state: cached?.runUrl ?? item.url } : this.checkRunCache.get(endpoint) : null;
    return {
      subjectState: queue?.state === true ? "merge_queued" : cached?.state ?? null,
      ...(cached?.authorId && this.copilotCache.get("/user")?.state?.id ? {
        viewerIsAuthor: cached.authorId === this.copilotCache.get("/user").state.id,
      } : {}),
      subjectStateError: cached?.error?.message ?? queueError ?? discussionError ?? (endpoint ? null : "GitHub did not provide a supported link for this item's status."),
      ...(checkedAt !== undefined ? {
        subjectCheckedAt: queueCheckedAt === undefined ? checkedAt : Math.min(checkedAt, queueCheckedAt),
        subjectStateStale: Boolean(cached.error || queue?.error && queueCheckedAt !== undefined),
      } : {}),
      ...runSnapshot(run, false, jobs),
    };
  }

  copilotContext(kind, item, signal) {
    const run = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/
      .exec(item?.subjectRunUrl ?? item?.url ?? "");
    const link = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)(?:\/(job|attempts)\/([1-9]\d*))?$/
      .exec(item?.url ?? "");
    const matchingRun = run && link && run[1] === item.repository && link[1] === run[1] && link[2] === run[2] &&
      (link[3] !== "attempts" || link[4] === run[3]) && (link[3] !== "job" || run[3] !== undefined);
    const endpoint = kind === "viewer" ? "/user" : ["pull", "queue"].includes(kind) && item?.type === "PullRequest"
      ? subjectEndpoint(item, this.target) : kind === "run" && matchingRun
        ? `/repos/${run[1]}/actions/runs/${run[2]}${run[3] ? `/attempts/${run[3]}` : ""}` : null;
    if (this.target.custom || !endpoint) throw new InboxError("copilot_context", "Use a confirmed github.com item for this Copilot action.", 400);
    if (kind === "queue") {
      return this.#refreshSubject(endpoint, item, signal, "queue", () => true).then(() => {
        const result = this.mergeQueueCache.get(endpoint);
        if (result?.error) throw new InboxError(result.error.code, result.error.message);
        if (typeof result?.state !== "boolean" || !(result.nextRefreshAt > this.now())) {
          throw this.graphqlLastError ?? new InboxError("copilot_context", "GitHub could not verify merge queue membership. Retry when queue status is available.");
        }
        return result.state;
      });
    }
    return this.request(endpoint, signal, "GET", { subjectType: "Copilot", copilot: kind, force: kind === "pull" }).then(result => {
      if (result.error) throw new InboxError(result.error.code, result.error.message);
      return result.state;
    }).catch(error => {
      if (error instanceof InboxError && error.code !== "closed") {
        const cached = this.copilotCache.get(endpoint);
        const now = this.now();
        this.copilotCache.set(endpoint, { error: { code: error.code, message: error.message },
          nextRefreshAt: cached?.error && cached.nextRefreshAt > now
            ? Math.max(cached.nextRefreshAt, error.retryAt ?? 0, this.blockedUntil)
            : Math.max(error.retryAt ?? 0, this.blockedUntil, now + RETRY_MS) });
      }
      throw error;
    });
  }

  #jobSearch(item) {
    if (item.type !== "CheckSuite") return null;
    const endpoint = subjectEndpoint(item, this.target);
    const inferred = !endpoint;
    const state = inferred ? { state: reportedWorkflow(item.title)?.state } : this.subjectCache.get(endpoint);
    const run = item.runId && endpoint ? { state: state?.runUrl ?? item.url } :
      this.checkRunCache.get(endpoint ?? workflowRunSearch(item, this.target)?.key);
    const base = `${this.target.webOrigin}/${item.repository}/actions/runs/`;
    const match = run?.state?.startsWith(base) && /^([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/.exec(run.state.slice(base.length));
    if (!match) return null;
    const [, runId, attempt] = match;
    return {
      repository: item.repository, runId, attempt,
      endpoint: `/repos/${item.repository}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ""}/jobs?${attempt ? "" : "filter=latest&"}per_page=100`,
      eligible: !state?.error && !run.error && FAILED_CHECK_STATES.includes(state?.state),
    };
  }

  subjectLinkPending(item) {
    if (item.type !== "CheckSuite") return false;
    const key = subjectKey(item, this.target);
    if (!key || this.subjectLinksReady.has(key)) return false;
    const endpoint = subjectEndpoint(item, this.target);
    const jobs = this.#jobSearch(item);
    if ((!endpoint || this.subjectCache.has(endpoint)) &&
        (item.runId || this.checkRunCache.has(key)) &&
        (!jobs?.eligible || this.jobCache.has(jobs.endpoint))) {
      this.subjectLinksReady.add(key);
      return false;
    }
    return this.now() >= this.blockedUntil;
  }

  invalidateSubjects(items) {
    for (const item of items) {
      const key = subjectKey(item, this.target);
      if (key) this.subjectInvalidations.set(key, (this.subjectInvalidations.get(key) ?? 0) + 1);
      for (const cache of [this.subjectCache, this.mergeQueueCache, this.checkRunCache]) {
        const cached = cache.get(key);
        if (cached && !cached.error) cached.nextRefreshAt = 0;
      }
      const jobKey = this.#jobSearch(item)?.endpoint;
      if (jobKey) this.subjectInvalidations.set(jobKey, (this.subjectInvalidations.get(jobKey) ?? 0) + 1);
      const jobs = this.jobCache.get(jobKey);
      if (jobs && !jobs.error) jobs.nextRefreshAt = 0;
    }
  }

  subjectsNeedRefresh(items) {
    const now = this.now();
    if (now < this.blockedUntil) return false;
    const due = (cache, endpoint, item) => {
      const cached = cache.get(endpoint);
      return !cached || now >= cached.nextRefreshAt ||
        !cached.error && item.updatedAt > (cached.updatedAt ?? "");
    };
    return items.some(item => {
      if (item.type === "Discussion" && now < this.graphqlBlockedUntil) return false;
      const endpoint = subjectEndpoint(item, this.target);
      const jobs = this.#jobSearch(item);
      if (jobs?.eligible && due(this.jobCache, jobs.endpoint, item)) return true;
      if (!endpoint) {
        const search = workflowRunSearch(item, this.target);
        return search && due(this.checkRunCache, search.key, item);
      }
      return endpoint && (due(this.subjectCache, endpoint, item) ||
        item.type === "PullRequest" && !this.target.custom && now >= this.graphqlBlockedUntil &&
        !this.subjectCache.get(endpoint).error && this.subjectCache.get(endpoint).state === "open" &&
        due(this.mergeQueueCache, endpoint, item) ||
        item.type === "CheckSuite" && item.checkSuiteId && due(this.checkRunCache, endpoint, item));
    });
  }

  async refreshSubjects(items, signal) {
    let previousItems;
    let subjects;
    let selectedKeys;
    let failed = false;
    let failure;
    const processed = new Set();
    const updateSelection = () => {
      const currentItems = typeof items === "function" ? items() : items;
      if (currentItems !== previousItems) {
        previousItems = currentItems;
        subjects = new Map();
        selectedKeys = new Set();
        for (const item of currentItems) {
          const endpoint = subjectKey(item, this.target);
          if (endpoint) selectedKeys.add(endpoint);
          if (endpoint && !processed.has(endpoint) && (!subjects.has(endpoint) || item.updatedAt > subjects.get(endpoint).updatedAt)) {
            subjects.set(endpoint, item);
          }
        }
      }
    };
    const nextSubject = () => {
      updateSelection();
      const next = subjects.entries().next().value;
      if (!next) return null;
      const [endpoint, item] = next;
      subjects.delete(endpoint);
      processed.add(endpoint);
      return [endpoint, item];
    };
    const worker = async () => {
      try {
        while (!failed) {
          const worked = await this.#withRequestSlot(async () => {
            await waitForWork(this.queue, signal);
            if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
            if (failed) return false;
            const next = nextSubject();
            if (!next) return false;
            const [endpoint, item] = next;
            const selected = () => {
              updateSelection();
              return !failed && selectedKeys.has(endpoint);
            };
            let completed = true;
            for (const kind of subjectEndpoint(item, this.target) ? ["state", "queue", "run", "jobs"] : ["match", "jobs"]) {
              if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
              if (!selected()) {
                completed = false;
                break;
              }
              if (kind === "queue" && (item.type !== "PullRequest" || this.subjectCache.get(endpoint).error ||
                  this.subjectCache.get(endpoint).state !== "open" || this.target.custom || this.now() < this.graphqlBlockedUntil)) continue;
              if (kind === "run" && (item.type !== "CheckSuite" || !item.checkSuiteId)) continue;
              if (kind === "jobs" && !this.#jobSearch(item)?.eligible) continue;
              if (await this.#refreshSubject(endpoint, item, signal, kind, selected) === false) {
                completed = false;
                break;
              }
            }
            if (!completed) {
              // Release the reservation only after in-flight work finishes; re-expansion can resume skipped phases.
              processed.delete(endpoint);
              previousItems = undefined;
            }
            return true;
          }, signal, this.subjectWorkers, this.subjectWaiters, SUBJECT_CONCURRENCY);
          if (!worked) return;
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    const workers = new Set();
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const wake = () => {
      try {
        if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
        if (!failed) {
          updateSelection();
          const count = Math.min(SUBJECT_CONCURRENCY - workers.size, subjects.size);
          for (let index = 0; index < count; index++) {
            const pending = worker().catch(error => {
              failed = true;
              failure ??= error;
            }).finally(() => {
              workers.delete(pending);
              wake();
            });
            workers.add(pending);
          }
        }
      } catch (error) {
        failed = true;
        failure ??= error;
      }
      if (!workers.size) finish();
    };
    if (typeof items === "function") this.subjectRefreshes.add(wake);
    try {
      wake();
      await finished;
      if (failure) throw failure;
    } finally {
      this.subjectRefreshes.delete(wake);
    }
  }

  wakeSubjects() {
    for (const wake of this.subjectRefreshes) wake();
  }

  #withRequestSlot(work, signal, workers, waiters, concurrency) {
    return new Promise((resolve, reject) => {
      const aborted = () => {
        waiters.delete(start);
        reject(new InboxError("closed", "The canvas was closed.", 410));
      };
      const start = () => {
        waiters.delete(start);
        signal?.removeEventListener("abort", aborted);
        if (signal?.aborted) return aborted();
        const pending = work();
        const settled = pending.catch(() => {}).finally(() => {
          workers.delete(settled);
          waiters.values().next().value?.();
        });
        workers.add(settled);
        pending.then(resolve, reject);
      };
      if (signal?.aborted) return aborted();
      if (workers.size < concurrency && !waiters.size) start();
      else {
        waiters.add(start);
        signal?.addEventListener("abort", aborted, { once: true });
      }
    });
  }

  async #refreshSubject(endpoint, item, signal, kind, selected) {
    const mergeQueue = kind === "queue";
    const checkRun = kind === "run";
    const runMatch = kind === "match" ? workflowRunSearch(item, this.target) : null;
    const runJobs = kind === "jobs" ? this.#jobSearch(item) : null;
    if (kind === "jobs") {
      if (!runJobs?.eligible) return;
      endpoint = runJobs.endpoint;
    }
    const cache = runJobs ? this.jobCache : checkRun || runMatch ? this.checkRunCache : mergeQueue ? this.mergeQueueCache : this.subjectCache;
    const key = `${kind} ${endpoint}`;
    // Serialize the same lookup across panels; distinct subjects share the bounded pool.
    const previous = this.subjectRequests.get(key) ?? Promise.resolve();
    let started = false;
    const pending = previous.catch(() => {}).then(async () => {
      await waitForWork(this.queue, signal);
      if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (!selected()) return false;
      if ((mergeQueue || item.type === "Discussion") && this.now() < this.graphqlBlockedUntil) return;
      const cached = cache.get(endpoint);
      const invalidationKey = runJobs ? endpoint : subjectKey(item, this.target);
      const generation = this.subjectInvalidations.get(invalidationKey) ?? 0;
      try {
        started = true;
        const result = await this.request(endpoint, signal, "GET", {
          subjectType: item.type, mergeQueue, checkRun, runMatch, runJobs, force: item.updatedAt > (cached?.updatedAt ?? ""),
          allowCachedDuringBackoff: item.type === "CheckSuite",
        });
        cache.set(endpoint, {
          ...result, updatedAt: cached?.updatedAt > item.updatedAt ? cached.updatedAt : item.updatedAt,
          ...(!result.error && generation !== (this.subjectInvalidations.get(invalidationKey) ?? 0) ? { nextRefreshAt: 0 } : {}),
        });
      } catch (error) {
        if (!(error instanceof InboxError) || error.code === "closed") throw error;
        if (error.code === "graphql_rate_limited" && error.requestDeferred) return;
        cache.set(endpoint, {
          state: runMatch || runJobs ? null : cached?.state ?? null, checkedAt: cached?.checkedAt,
          ...(cached?.runUrl ? { runUrl: cached.runUrl } : {}),
          error: { code: error.code, message: error.message },
          nextRefreshAt: Math.max(this.blockedUntil, error.retryAt ?? 0, this.now() + RETRY_MS),
        });
      }
    }).finally(() => {
      if (this.subjectRequests.get(key) === pending) this.subjectRequests.delete(key);
    });
    this.subjectRequests.set(key, pending);
    try {
      return await waitForWork(pending, signal);
    } catch (error) {
      // Keep the slot occupied until an already-dispatched request has stopped.
      if (started) await pending;
      throw error;
    }
  }

  page(endpoint, signal, { force = false, minSequence = 0, allowCachedDuringBackoff = false } = {}) {
    const url = endpointURL(endpoint);
    const path = `${url.pathname}${url.search}`;
    const pending = this.queue.then(() => this.request(path, signal, "GET", { force, minSequence, allowCachedDuringBackoff }));
    this.pageQueue = this.queue = pending.catch(() => {});
    return pending.then(async page => {
      if (page.sequence >= minSequence) return page;
      // A scan needs a newer response, but waiting must not hold the request queue.
      try {
        await this.sleep(Math.max(0, page.nextRefreshAt - this.now()), undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
        throw error;
      }
      return this.page(endpoint, signal, { force, minSequence, allowCachedDuringBackoff });
    });
  }

  reserveThreads(ids) {
    if (ids.some(id => this.pendingThreads.has(id) || this.threadReservations.has(id))) {
      throw new InboxError("busy", "A selected notification is already being updated in another operation.", 409);
    }
    const owner = Symbol("notification batch");
    for (const id of ids) this.threadReservations.set(id, owner);
    return owner;
  }

  releaseThreads(owner) {
    for (const [id, reservedBy] of this.threadReservations) {
      if (reservedBy === owner) this.threadReservations.delete(id);
    }
  }

  markRead(id, signal, options) {
    return this.#markThread(id, signal, "PATCH", options);
  }

  markDone(id, signal, options) {
    return this.#markThread(id, signal, "DELETE", options);
  }

  #markThread(id, signal, method, { owner, beforeWrite, onWriteError, queueSignal = signal } = {}) {
    if (typeof id !== "string" || !/^[1-9]\d{0,63}$/.test(id)) {
      throw new InboxError("invalid_thread", "Use a valid notification thread ID.", 400);
    }
    if (this.pendingThreads.has(id)) throw new InboxError("busy", "This notification is already being updated.", 409);
    if (this.threadReservations.has(id) && this.threadReservations.get(id) !== owner) {
      throw new InboxError("busy", "This notification belongs to an active batch.", 409);
    }
    this.pendingThreads.add(id);
    const write = { id, action: method === "DELETE" ? "done" : "read", inFlight: false };
    this.threadWrites.set(id, write);
    // Pages are barriers: writes may overlap each other, never an inbox response.
    const pending = waitForWork(this.pageQueue, queueSignal).then(() => this.#withRequestSlot(async () => {
      try {
        if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
        await this.request(`/notifications/threads/${id}`, signal, method, { beforeWrite: () => {
          if (queueSignal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
          beforeWrite?.();
          write.inFlight = true;
        } });
        this.revision++;
        const action = method === "DELETE" ? "done" : "read";
        for (const [endpoint, page] of this.cache) {
          const query = endpointURL(endpoint).searchParams;
          const retain = query.get("all") === "true" && action === "read";
          this.cache.set(endpoint, {
            ...page,
            items: page.items.flatMap(item => item.id !== id ? [item] : retain ? [{ ...item, unread: false }] : []),
            etag: undefined,
            modified: undefined,
            invalidated: true,
          });
        }
        for (const listener of this.threadListeners) listener(id, action);
      } catch (error) {
        // Stop the batch's queued work before this slot can dispatch its next item.
        onWriteError?.(error);
        throw error;
      }
    }, queueSignal, this.writeWorkers, this.writeWaiters, WRITE_CONCURRENCY)).finally(() => {
      this.pendingThreads.delete(id);
      this.threadWrites.delete(id);
    });
    this.queue = Promise.all([this.queue, pending.catch(() => {})]).then(() => {});
    return pending;
  }

  async request(endpoint, signal, method = "GET", { force = false, minSequence = 0, allowCachedDuringBackoff = false, subjectType, mergeQueue = false, checkRun = false, runMatch = null, runJobs = null, beforeWrite, copilot } = {}) {
    if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    const discussion = subjectType === "Discussion";
    const graphql = mergeQueue || discussion;
    let now = this.now();
    const cache = copilot ? this.copilotCache : runJobs ? this.jobCache : checkRun || runMatch ? this.checkRunCache : mergeQueue ? this.mergeQueueCache : subjectType ? this.subjectCache : this.cache;
    const cached = method === "GET" ? cache.get(endpoint) : undefined;
    if (cached?.error && now < cached.nextRefreshAt) return cached;
    if (allowCachedDuringBackoff && !force && cached && !cached.invalidated &&
        (subjectType || cached.sequence >= minSequence) && now < cached.nextRefreshAt) return cached;
    if (this.beforeRequest) {
      await this.beforeRequest();
      if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      now = this.now();
    }
    if (now < this.blockedUntil) {
      const cause = this.lastError ?? rateLimitError();
      const error = new InboxError(cause.code, cause.message, cause.status);
      error.retryAt = this.blockedUntil;
      error.requestDeferred = true;
      throw error;
    }
    if (graphql && now < this.graphqlBlockedUntil) {
      const cause = this.graphqlLastError ?? rateLimitError(true);
      const error = new InboxError(cause.code, cause.message, cause.status);
      error.retryAt = this.graphqlBlockedUntil;
      error.requestDeferred = true;
      throw error;
    }
    if (!force && cached && !cached.invalidated && now < cached.nextRefreshAt) return cached;
    const requestKey = `${checkRun || runMatch ? "RUN" : graphql ? "GRAPHQL" : method} ${endpoint}`;
    const previousError = this.lastError;
    const clearFailure = () => {
      this.failures.delete(requestKey);
      if (!subjectType && this.lastError === previousError) this.lastError = null;
      if (graphql && this.now() >= this.graphqlBlockedUntil) this.graphqlLastError = null;
    };
    const args = ["api", "--hostname", this.target.hostname, "--method", graphql ? "POST" : method, "--include",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (graphql) {
      const match = /^\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(pulls|discussions)\/([1-9]\d*)$/.exec(endpoint);
      if (this.target.custom || !match || match[3] !== (discussion ? "discussions" : "pulls") || Number(match[4]) > 2147483647) {
        throw new InboxError(discussion ? "discussion_unavailable" : "merge_queue_unavailable", discussion
          ? "Discussion status is unavailable for this API or discussion number."
          : "Merge queue status is unavailable for this API or pull request number.");
      }
      // gh groups fields into GraphQL variables only for this exact endpoint, without a leading slash.
      args.push("-f", `query=${discussion ? DISCUSSION_QUERY : MERGE_QUEUE_QUERY}`, "-f", `owner=${match[1]}`, "-f", `name=${match[2]}`, "-F", `number=${match[4]}`, "graphql");
    } else {
      if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
      else if (cached?.modified) args.push("-H", `If-Modified-Since: ${cached.modified}`);
      let path = runMatch ? runMatch.path : endpoint;
      if (checkRun) {
        const match = /^(\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/check-suites\/([1-9]\d*)$/.exec(endpoint);
        if (!match) throw new InboxError("run_results_unavailable", "Use a supported check suite to find workflow run results.", 400);
        path = `${match[1]}/actions/runs?check_suite_id=${match[2]}&per_page=2`;
      }
      args.push(this.target.custom ? `${this.target.baseUrl}${path}` : path);
    }
    if (method !== "GET") beforeWrite?.();
    const sequence = method === "GET" && !subjectType ? ++this.sequence : undefined;
    let response;
    try {
      response = parseResponse(await this.run(args, { signal }));
      if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      const { status, headers } = response;
      const fetchedAt = this.now();
      const serverTime = Date.parse(headers.date ?? "");
      const poll = Math.max(subjectType ? SUBJECT_POLL_MS : POLL_MS, seconds(headers["x-poll-interval"]));
      const retryPoll = Math.max(RETRY_MS, poll);
      const reset = seconds(headers["x-ratelimit-reset"]);
      const retry = seconds(headers["retry-after"]) ||
        Math.max(0, Date.parse(headers["retry-after"]) - fetchedAt) || 0;
      const exhausted = headers["x-ratelimit-remaining"] === "0";
      const graphqlPrimary = graphql && exhausted && !retry && status !== 429 && !SECONDARY_LIMIT.test(response.text);
      if (retry) this.serverBlockedUntil = Math.max(this.serverBlockedUntil, fetchedAt + retry);
      if (exhausted) {
        if (graphqlPrimary) {
          this.graphqlBlockedUntil = Math.max(this.graphqlBlockedUntil, reset + 1000, fetchedAt + retryPoll);
          this.graphqlLastError = rateLimitError(true);
        } else {
          this.serverBlockedUntil = Math.max(this.serverBlockedUntil, reset + 1000, fetchedAt + retryPoll);
        }
      }
      this.blockedUntil = Math.max(this.blockedUntil, this.serverBlockedUntil);
      if (status === 429 || (status === 403 && (exhausted || retry ||
          /rate limit|abuse detection|secondary limit/i.test(response.text)))) {
        if (graphqlPrimary) throw rateLimitError(true);
        this.serverBlockedUntil = Math.max(this.serverBlockedUntil, fetchedAt + retry, fetchedAt + retryPoll);
        this.blockedUntil = Math.max(this.blockedUntil, this.serverBlockedUntil);
        throw rateLimitError();
      }
      if (status === 401) throw new InboxError("authentication",
        this.target.custom
          ? "API sign-in expired. Run gh auth login --hostname <host> for the selected development API host. This view retries automatically while visible."
          : "GitHub sign-in expired. Run gh auth login --hostname github.com. This view retries automatically while visible.", 401);
      if (subjectType && (status === 403 || status === 404)) throw new InboxError("subject_unavailable",
        mergeQueue ? "GitHub denied access to merge queue status. Check repository access and organization SSO."
          : runJobs ? "GitHub denied access to job details. Check repository access and organization SSO."
          : checkRun || runMatch ? "GitHub denied access to workflow runs. Check repository access and organization SSO."
          : "GitHub denied access to this item's status. Check repository access and organization SSO.", status);
      if (status === 403 || status === 404) throw new InboxError("permission",
        this.target.custom
          ? "The selected API denied notifications access. Check its URL, network access and gh authentication for that host, including notifications scope. Fine-grained tokens are unsupported."
          : "GitHub denied notifications access. Check gh auth status; grant notifications scope with gh auth refresh --hostname github.com --scopes notifications. Check organization SSO if applicable. Fine-grained tokens are unsupported.", 403);
      if (!(graphql ? [200] : method === "DELETE" ? [204] : method === "PATCH" ? [205, 304] : [200, 304]).includes(status)) throw new InboxError("github_http",
        `GitHub returned HTTP ${status}. Check GitHub status and try again.`, 502);
      if (method !== "GET") {
        clearFailure();
        return;
      }
      if (status === 304 && (!cached || cached.error)) throw new InboxError("invalid_response",
        subjectType ? "GitHub returned 304 without a cached subject status." : "GitHub returned 304 without a cached inbox.");
      let items = cached?.items;
      let next = cached?.next;
      let authorId = status === 304 ? cached?.authorId : undefined;
      let runUrl = status === 304 ? cached?.runUrl : undefined;
      if (status === 200) {
        let body;
        try {
          body = JSON.parse(response.text);
        } catch {
          throw new InboxError("invalid_response", subjectType
            ? "GitHub returned invalid JSON for this item's status." : "GitHub returned invalid JSON; the previous inbox was kept.");
        }
        if (subjectType === "PullRequest" && Number.isSafeInteger(body?.user?.id) && body.user.id > 0) authorId = body.user.id;
        items = copilot ? copilotDetails(body, copilot, endpoint) : runJobs ? failedJobLink(body, runJobs, this.target, headers.link) :
          runMatch ? inferredRunLink(body, runMatch, this.target, headers.link) : checkRun ? checkRunLink(body, endpoint, this.target) :
          mergeQueue ? mergeQueueState(body, retry > 0) : discussion ? discussionState(body, retry > 0) :
          subjectType ? subjectState(body, subjectType) : normalizeThreads(body, this.target);
        const directRun = subjectType === "CheckSuite" && !runJobs && !checkRun && !runMatch
          ? /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)$/.exec(endpoint) : null;
        if (runJobs && items) {
          const job = body.jobs.find(job => job.html_url === items);
          runUrl = `${this.target.webOrigin}/${runJobs.repository}/actions/runs/${runJobs.runId}/attempts/${job.run_attempt}`;
        } else if (directRun && body.run_attempt !== undefined) {
          if (String(body.id) !== directRun[2]) {
            throw new InboxError("run_results_unavailable", "GitHub returned a different workflow run for this notification.");
          }
          runUrl = workflowRunURL(body, directRun[1], this.target, body.run_attempt);
        }
        if (!subjectType) next = nextPage(headers.link, endpoint, this.target);
      }
      if (subjectType) {
        const subject = {
          state: status === 304 ? cached.state : items,
          ...(authorId ? { authorId } : {}),
          ...(runUrl ? { runUrl } : {}),
          checkedAt: fetchedAt,
          nextRefreshAt: Math.max(fetchedAt + poll, this.blockedUntil, graphql ? this.graphqlBlockedUntil : 0),
          etag: headers.etag ?? (status === 304 ? cached.etag : undefined),
          modified: headers["last-modified"] ?? (status === 304 ? cached.modified : undefined),
        };
        cache.set(endpoint, subject);
        clearFailure();
        return subject;
      }
      const invalidated = status === 304 && Boolean(cached?.invalidated);
      const page = {
        sequence,
        invalidated,
        items, next, fetchedAt, nextRefreshAt: Math.max(fetchedAt + poll, this.blockedUntil),
        serverTime: Number.isFinite(serverTime) && serverTime >= 0 ? serverTime : null,
        etag: invalidated ? undefined : headers.etag ?? (status === 304 ? cached?.etag : undefined),
        modified: invalidated ? undefined : headers["last-modified"] ?? (status === 304 ? cached?.modified : undefined),
      };
      this.cache.set(endpoint, page);
      clearFailure();
      return page;
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      if (error.code !== "closed") {
        const failureCount = (this.failures.get(requestKey) ?? 0) + 1;
        this.failures.set(requestKey, failureCount);
        const retryAt = Math.max(
          this.now() + Math.min(30 * 60_000, RETRY_MS * 2 ** Math.min(failureCount - 1, 4)),
          this.now() + seconds(response?.headers["x-poll-interval"]));
        if (subjectType) error.retryAt = retryAt;
        if (error.code === "graphql_rate_limited") {
          this.graphqlBlockedUntil = Math.max(this.graphqlBlockedUntil, retryAt);
          this.graphqlLastError = error;
          error.retryAt = this.graphqlBlockedUntil;
        } else if (!subjectType || ["rate_limited", "authentication"].includes(error.code)) {
          this.blockedUntil = Math.max(this.blockedUntil, retryAt);
          this.lastError = error;
          if (error.code === "rate_limited") this.serverBlockedUntil = Math.max(this.serverBlockedUntil, retryAt);
        }
      }
      throw error;
    }
  }

  clear() {
    this.cache.clear();
    this.subjectCache.clear();
    this.copilotCache.clear();
    this.mergeQueueCache.clear();
    this.checkRunCache.clear();
    this.jobCache.clear();
    this.subjectLinksReady.clear();
    this.subjectInvalidations.clear();
  }
}
