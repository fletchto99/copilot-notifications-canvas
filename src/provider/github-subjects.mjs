import { authorshipTypes, InboxError, notificationLink, reportedWorkflow } from "../shared/model.mjs";

const RUN_MATCH_WINDOW_MS = 2 * 60_000;
const RUN_SEARCH_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const FAILED_CHECK_STATES = ["failure", "timed_out", "startup_failure"];
export const SECONDARY_LIMIT = /secondary(?: rate)? limit|abuse detection/i;

export function subjectEndpoint(item, target) {
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

export function workflowRunSearch(item, target) {
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

export function subjectKey(item, target) {
  return subjectEndpoint(item, target) ?? workflowRunSearch(item, target)?.key;
}

export function workflowRunURL(run, repository, target, attempt) {
  const url = `${target.webOrigin}/${repository}/actions/runs/${run.id}`;
  if (!(typeof run.id === "string" || Number.isSafeInteger(run.id)) || !/^[1-9]\d*$/.test(String(run.id)) ||
      run.html_url !== url || attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
    throw new InboxError("run_results_unavailable", "GitHub did not provide an unambiguous workflow run for this check suite.");
  }
  return attempt === undefined ? url : `${url}/attempts/${attempt}`;
}

export function checkRunLink(body, endpoint, target) {
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

export function inferredRunLink(body, search, target, link) {
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

export function failedJobLink(body, search, target, link) {
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

export function runSnapshot(run, inferred = false, jobs) {
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

export function rateLimitError(graphql = false) {
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

export function mergeQueueState(body, secondaryLimit = false) {
  checkGraphQLRateLimit(body, secondaryLimit);
  const state = body?.data?.repository?.pullRequest?.isInMergeQueue;
  if (body?.errors || typeof state !== "boolean") {
    throw new InboxError("merge_queue_unavailable", "Merge queue status is unavailable. Check repository access and organization SSO.");
  }
  return state;
}

export function discussionState(body, secondaryLimit) {
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

export function subjectState(body, type) {
  if (type === "Viewer") {
    const id = userId(body);
    if (!id) throw new InboxError("viewer_unavailable", "GitHub did not provide the signed-in account's ID. Authorship is unavailable.");
    return id;
  }
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

function userId(user) {
  const id = user?.id;
  return (typeof id === "string" || Number.isSafeInteger(id)) && /^[1-9]\d{0,19}$/.test(String(id)) ? String(id) : null;
}

export function subjectAuthorship(body, type) {
  if (!authorshipTypes.includes(type)) return undefined;
  if (type === "Discussion") {
    const mine = body?.data?.repository?.discussion?.viewerDidAuthor;
    return typeof mine === "boolean" ? { mine } : { error: "GitHub did not provide discussion authorship." };
  }
  const authorId = userId(body?.user);
  return authorId ? { authorId } : { error: "GitHub did not provide this item's author ID." };
}

export function copilotDetails(body, kind, endpoint) {
  const invalid = () => new InboxError("copilot_context", "GitHub did not provide verified context for this Copilot action.");
  if (kind === "viewer") {
    if (!Number.isSafeInteger(body?.id) || body.id < 1) throw invalid();
    return { id: body.id };
  }
  if (kind === "issue") {
    subjectState(body, "Issue");
    if (body.pull_request) throw invalid();
    return { state: body.state };
  }
  if (kind === "commit") {
    const match = /^\/repos\/([^/]+\/[^/]+)\/commits\/([a-f0-9]{7,40})$/.exec(endpoint);
    if (!match || typeof body?.sha !== "string" || !/^[a-f0-9]{40}$/.test(body.sha) ||
        !body.sha.startsWith(match[2]) || body.html_url !== `https://github.com/${match[1]}/commit/${body.sha}`) throw invalid();
    return { sha: body.sha, url: body.html_url };
  }
  if (kind === "pull") {
    subjectState(body, "PullRequest");
    if (!Number.isSafeInteger(body.user?.id) || body.user.id < 1 || !/^[a-f0-9]{40}$/.test(body.head?.sha)) throw invalid();
    return { authorId: body.user.id, state: body.state, merged: body.merged, sha: body.head.sha };
  }
  if (kind === "release") {
    const match = /^\/repos\/([^/]+\/[^/]+)\/releases\/([1-9]\d*)$/.exec(endpoint);
    if (!match || !Number.isSafeInteger(body?.id) || String(body.id) !== match[2] ||
        body.draft !== false || typeof body.tag_name !== "string" || !body.tag_name ||
        /[\s\p{Cc}\\]/u.test(body.tag_name) ||
        typeof body.html_url !== "string" || body.html_url.length > 2048 || /[\s\\]/u.test(body.html_url)) throw invalid();
    const prefix = `/${match[1]}/releases/tag/`;
    let url;
    let tag;
    try {
      url = new URL(body.html_url);
      tag = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      throw invalid();
    }
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(prefix) || tag !== body.tag_name) throw invalid();
    return { releaseId: match[2], url: url.href };
  }
  const match = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/.exec(endpoint);
  if (!match || String(body?.id) !== match[2] || body.repository?.full_name?.toLowerCase() !== match[1].toLowerCase() ||
      body.html_url !== `https://github.com/${match[1]}/actions/runs/${match[2]}` ||
      !/^[a-f0-9]{40}$/.test(body.head_sha) || !Number.isSafeInteger(body.run_attempt) || body.run_attempt < 1 ||
      match[3] !== undefined && String(body.run_attempt) !== match[3] ||
      !FAILED_CHECK_STATES.includes(subjectState(body, "CheckSuite"))) throw invalid();
  return { runId: match[2], sha: body.head_sha, attempt: body.run_attempt, url: `${body.html_url}/attempts/${body.run_attempt}` };
}
