import { createHash, randomUUID } from "node:crypto";
import { InboxError } from "../shared/model.mjs";
import { prepareCommit as prepareGitCommit } from "./checkout.mjs";
import { promptFor } from "./copilot-prompts.mjs";

const labels = {
  issue: "Investigate with Copilot",
  issueSummary: "Summarize with Copilot",
  discussion: "Summarize with Copilot",
  commit: "Summarize commit",
  continue: "Continue with Copilot",
  review: "Review with Copilot",
  summarize: "Summarize Changes",
  release: "Summarize Release Notes",
  ci: "Investigate CI failures with Copilot",
};
const failedChecks = new Set(["failure", "timed_out", "startup_failure"]);
const closedIssueStates = new Set(["closed", "not_planned", "duplicate"]);
const discoveryRetryDelays = [1000, 2000, 5000];
const discoveryStartupWindow = 180_000;
const inactivePull = item => item.type === "PullRequest" && item.subjectState === "merge_queued"
  ? "PR in merge queue" : null;
const integrationDisabled = () => new InboxError("copilot_disabled",
  "Copilot integration is off. Enable it in Settings to start a handoff.", 409);
const changedPull = () => new InboxError("stale_handoff",
  "This pull request's state changed. Open the Copilot action again to review the updated task.", 409);
const changedIssue = () => new InboxError("stale_handoff",
  "This issue's state changed. Open the Copilot action again to review the updated task.", 409);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unavailable = () => new InboxError("copilot_unavailable",
  "Copilot session actions are unavailable in this host. Update the Copilot app and reload extensions.", 503);
const hostFailure = () => new InboxError("copilot_host",
  "Copilot could not complete the handoff. Check the app for permission requests or a session already created before trying again.", 502);

function toolData(result, list = false) {
  if (typeof result !== "string" && result?.resultType !== "success") throw hostFailure();
  const text = typeof result === "string" ? result : result.textResultForLlm;
  let data = typeof result === "object" ? result.structuredContent : undefined;
  if (data === undefined) {
    try {
      data = JSON.parse(list ? text.slice(text.indexOf("\n[") + 1) : text);
    } catch {
      if (list) throw hostFailure();
      if (typeof text !== "string" || /^(?:error|failed|unable)\b/i.test(text)) throw hostFailure();
      return text;
    }
  }
  if (!data || data.error || data.success === false || list && !Array.isArray(data)) throw hostFailure();
  return data;
}

export class CopilotHost {
  constructor(getSession, { log = () => {}, now = Date.now, prepareCommit = prepareGitCommit } = {}) {
    this.getSession = getSession;
    this.log = log;
    this.now = now;
    this.tools = new Set();
    this.discoveryComplete = false;
    this.startupAttempts = 0;
    this.nextCheckAt = 0;
    this.reservations = new Set();
    this.prepareCommit = prepareCommit;
  }

  get initializing() {
    return !this.discoveryComplete && (this.discoveryDeadline === undefined || this.now() < this.discoveryDeadline);
  }

  refresh() {
    this.discoveryDeadline ??= this.now() + discoveryStartupWindow;
    if (this.pending) return this.pending;
    const session = this.getSession();
    if (!session) return Promise.resolve();
    const tools = session.rpc?.tools;
    if (typeof tools?.getCurrentMetadata !== "function" || typeof tools.execute !== "function") {
      this.tools.clear();
      this.discoveryComplete = true;
      return Promise.resolve();
    }
    if (this.now() < this.nextCheckAt) return Promise.resolve();
    this.pending = tools.getCurrentMetadata().then(result => {
      this.tools = new Set((result.tools ?? []).filter(tool => {
        const properties = tool.input_schema?.properties;
        return !tool.mcpServerName && (tool.name !== "create_session" ||
          properties?.detached?.type === "boolean" &&
          properties?.kickoff?.properties?.prompt?.type === "string" &&
          properties?.kickoff?.properties?.mode?.enum?.includes("plan"));
      }).map(tool => tool.name));
    }).catch(() => {
      this.tools.clear();
      this.log("Could not discover Copilot session actions.", { level: "warning" });
    }).finally(() => {
      const now = this.now();
      const remaining = this.discoveryDeadline - now;
      const retryDelay = !this.discoveryComplete && !this.supports() && remaining > 0
        ? Math.min(discoveryRetryDelays[Math.min(this.startupAttempts++, discoveryRetryDelays.length - 1)], remaining) : undefined;
      this.discoveryComplete = retryDelay === undefined;
      this.nextCheckAt = now + (retryDelay ?? 60_000);
      this.pending = undefined;
    });
    return this.pending;
  }

  supports() {
    return ["list_repositories", "list_sessions_and_chats", "navigate_to", "create_session"]
      .every(name => this.tools.has(name));
  }

  async execute(name, args, list = false) {
    if (!this.tools.has(name)) throw unavailable();
    let result;
    try {
      result = await this.getSession().rpc.tools.execute({ name, arguments: args });
    } catch {
      throw hostFailure();
    }
    return toolData(result, list);
  }
}

function sameRepo(left, right) {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function matches(session, target) {
  if (session.type !== "session" || !uuid.test(session.id)) return false;
  if (sameRepo(session.project_repo, target.repository) && session.name === target.name) return true;
  if (["ci", "release", "discussion", "commit"].includes(target.action)) return false;
  const kind = ["issue", "issueSummary"].includes(target.action) ? "issue" : "pr";
  return ["source", "created"].some(prefix =>
    sameRepo(session[`${prefix}_${kind}_repo`] ?? session.project_repo, target.repository) &&
    String(session[`${prefix}_${kind}_number`]) === target.number);
}

function ciSessionName(details) {
  const name = `Investigate CI run ${details.runId} (attempt ${details.attempt})`;
  // Keep valid existing names stable for navigation-only reuse.
  if (name.length <= 40) return name;
  const compact = `CI ${details.runId}/${details.attempt}`;
  return compact.length <= 40 ? compact : `CI ${createHash("sha256").update(details.url).digest("hex").slice(0, 32)}`;
}

async function parallelReads(reads) {
  // Finish sibling reads before releasing the handoff, including on failure.
  const results = await Promise.allSettled(reads);
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

export class CopilotHandoff {
  constructor(inbox, host, { log = () => {}, preferences } = {}) {
    this.inbox = inbox;
    this.host = host;
    this.log = log;
    this.preferences = preferences;
    this.enabled = true;
    this.confirmCopilotActions = true;
    this.state = null;
    this.target = null;
    this.viewerRetryAt = 0;
  }

  get loading() {
    return this.enabled && !this.inbox.client.target.custom && this.host.initializing;
  }

  hydrate(items) {
    if (!this.enabled || this.inbox.client.target.custom || this.hydrating || this.inbox.controller.signal.aborted) return;
    this.hydrating = this.host.refresh().then(async () => {
      if (!this.enabled || !this.host.supports() || !items.some(item => item.type === "PullRequest") ||
          this.inbox.client.now() < this.viewerRetryAt) return;
      try {
        await this.inbox.client.copilotContext("viewer", null, this.inbox.controller.signal);
        this.viewerRetryAt = this.inbox.client.now() + 300_000;
      } catch (error) {
        if (!(error instanceof InboxError)) throw error;
        this.viewerRetryAt = Math.max(error.retryAt ?? 0, this.inbox.client.now() + 120_000);
      }
    }).catch(() => {
      this.log("Could not load Copilot action availability.", { level: "warning" });
    }).finally(() => { this.hydrating = undefined; });
  }

  row(item) {
    if (!this.enabled || this.inbox.client.target.custom) return null;
    let action;
    const number = item.type === "Discussion" ? item.discussionNumber : item.number;
    const numbered = item.direct && Number.isSafeInteger(Number(number)) && Number(number) > 0;
    if (item.type === "Issue" && numbered) action = closedIssueStates.has(item.subjectState) ? "issueSummary" : "issue";
    if (item.type === "Discussion" && numbered) action = "discussion";
    if (item.type === "Commit" && item.direct && /^[a-f0-9]{7,40}$/.test(item.commitRef)) action = "commit";
    if (item.type === "Release") action = "release";
    if (item.type === "PullRequest" && numbered) {
      action = ["closed", "merged"].includes(item.subjectState) ? "summarize" :
        item.viewerIsAuthor ? "continue" : "review";
    }
    if (item.type === "CheckSuite" && failedChecks.has(item.subjectState)) action = "ci";
    if (!action) return null;
    const inactive = inactivePull(item);
    if (inactive) return { label: inactive, enabled: false, reason: inactive };
    if (this.host.initializing) {
      const label = "Waiting on copilot SDK Availability";
      return { label, enabled: false, reason: label, loading: true };
    }
    if (!this.host.supports()) {
      const label = "Copilot tooling unavailable";
      return { label, enabled: false, reason: label };
    }
    if (action === "release" && (!Number.isSafeInteger(Number(item.releaseId)) || Number(item.releaseId) < 1)) {
      return { label: labels.release, enabled: false, reason: "No specific release is linked. Open GitHub to choose a release." };
    }
    const uncertain = action === "ci" && (!item.direct || !item.subjectRunUrl || item.subjectLinkLoading);
    return {
      label: item.type === "PullRequest" && action !== "summarize" && item.viewerIsAuthor === undefined ? "Work with Copilot" : labels[action],
      enabled: !uncertain,
      reason: uncertain ? item.subjectLinkLoading
        ? "Finding the workflow run and job details..."
        : "No unambiguous workflow run is available. Open GitHub to inspect this notification." : "",
    };
  }

  snapshot() {
    return this.state;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.state?.status === "ready") {
      this.state = { id: this.state.id, status: "error", message: integrationDisabled().message };
    }
  }

  setSettings(settings) {
    this.setEnabled(settings.copilotIntegration);
    this.confirmCopilotActions = settings.confirmCopilotActions ?? true;
  }

  async #active(id, direct = false, { pullState, forceQueue = false } = {}) {
    if (this.preferences) this.setSettings(await this.preferences.read());
    if (!this.enabled) throw integrationDisabled();
    const item = this.#item(id);
    // Preparation resolves fresh PR state before deciding whether queue checks apply.
    const state = pullState ?? (this.state?.status === "starting" ? this.target?.pullState : undefined);
    if (item.type === "PullRequest" && state === "open") {
      if (await this.inbox.client.copilotContext("queue", item, this.inbox.controller.signal, { force: forceQueue })) {
        throw new InboxError("copilot_inactive_pr", "Copilot actions are unavailable for merge-queued pull requests.", 409);
      }
      if (this.preferences) this.setSettings(await this.preferences.read());
      if (!this.enabled) throw integrationDisabled();
    }
    if (direct && (this.confirmCopilotActions || this.target?.inferred)) {
      throw new InboxError("copilot_confirmation", "This Copilot action needs confirmation. Open it again to review the details.", 409);
    }
    const current = this.#item(id);
    // A row state already seen before the fresh PR lookup may still be stale.
    if (this.state?.status === "starting" && current.type === "PullRequest" &&
        current.subjectState !== this.target?.observedPullState &&
        ["open", "draft", "closed", "merged"].includes(current.subjectState) &&
        (current.subjectState === "draft" ? "open" : current.subjectState) !== this.target?.pullState) throw changedPull();
    const issueState = current.subjectState === "open" ? "open" : closedIssueStates.has(current.subjectState) ? "closed" : null;
    if (this.state?.status === "starting" && current.type === "Issue" && issueState &&
        current.subjectState !== this.target?.observedIssueState && issueState !== this.target?.issueState) throw changedIssue();
    return current;
  }

  async #remember(input) {
    if (!input.skipConfirmation || !this.confirmCopilotActions) return;
    if (typeof this.preferences?.update !== "function") throw new InboxError("settings_unavailable", "Copilot confirmation preferences are unavailable.", 503);
    this.setSettings(await this.preferences.update({ confirmCopilotActions: false }));
    await this.#active(input.id);
  }

  #item(id) {
    if (this.inbox.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    const item = this.inbox.loadedItems().find(item => item.id === id);
    if (!item) throw new InboxError("unknown_thread", "This notification is no longer loaded. Refresh and try again.", 404);
    const current = { ...item, ...this.inbox.client.subjectSnapshot(item),
      subjectLinkLoading: this.inbox.client.subjectLinkPending(item) };
    if (inactivePull(current)) {
      throw new InboxError("copilot_inactive_pr", "Copilot actions are unavailable for merge-queued pull requests.", 409);
    }
    return current;
  }

  request(input) {
    if (!input || Object.keys(input).some(key => !["id", "token", "sessionId", "startNew", "clone", "direct", "skipConfirmation"].includes(key)) ||
        typeof input.id !== "string" || !/^[1-9]\d{0,63}$/.test(input.id) ||
        input.clone !== undefined && typeof input.clone !== "boolean" ||
        input.direct !== undefined && (typeof input.direct !== "boolean" || input.token !== undefined) ||
        input.skipConfirmation !== undefined && typeof input.skipConfirmation !== "boolean" ||
        input.startNew !== undefined && (input.startNew !== true || input.sessionId !== undefined) ||
        input.sessionId !== undefined && !uuid.test(input.sessionId)) {
      throw new InboxError("invalid_handoff", "Choose one loaded notification and a valid Copilot action.", 400);
    }
    if (!this.enabled) throw integrationDisabled();
    this.#item(input.id);
    if (this.pending) throw new InboxError("copilot_busy", "A Copilot handoff is already running.", 409);
    if (input.token !== undefined) {
      if (this.state?.status !== "ready" || input.token !== this.state.token || input.id !== this.state.id) {
        throw new InboxError("stale_handoff", "This Copilot action has expired or was already submitted. Open it again.", 409);
      }
      if (input.startNew && !this.existing.size) {
        throw new InboxError("invalid_handoff", "Choose a new session from the existing-session confirmation.", 400);
      }
    } else if (input.clone !== undefined || input.sessionId !== undefined || input.startNew !== undefined || input.skipConfirmation !== undefined) {
      throw new InboxError("invalid_handoff", "Prepare the Copilot action before confirming it.", 400);
    }
    const starting = input.token !== undefined;
    this.state = { id: input.id, status: starting ? "starting" : "preparing" };
    this.pending = (starting ? this.#start(input) : this.#prepare(input.id, input.direct)).catch(error => {
      if (!(error instanceof InboxError)) this.log("Unexpected Copilot handoff failure.", { level: "error" });
      this.state = { id: input.id, status: "error", message: error instanceof InboxError ? error.message : hostFailure().message };
    }).finally(() => { this.pending = undefined; });
    return this.snapshot();
  }

  async #sessions(target) {
    const sessions = await this.host.execute("list_sessions_and_chats", {}, true);
    return { all: sessions, matching: sessions.filter(session => matches(session, target)) };
  }

  #ready(target, sessions, configured) {
    this.target = target;
    this.existing = new Set(sessions.map(session => session.id));
    this.state = {
      id: target.id, status: "ready", token: randomUUID(), action: target.action, label: labels[target.action],
      url: target.url, repository: target.repository, needsClone: !configured,
      ...(target.pullState ? { pullState: target.pullState } : {}),
      ...(target.inferred ? { inferred: true } : {}),
      canClone: this.host.tools.has("add_repository"),
      canRemember: typeof this.preferences?.update === "function", confirmCopilotActions: this.confirmCopilotActions,
      sessions: sessions.map(session => ({ id: session.id, name: session.name })),
    };
  }

  async #prepare(id, direct = false) {
    const item = await this.#active(id);
    await this.host.refresh();
    const row = this.row(item);
    if (!row?.enabled) throw new InboxError("copilot_unavailable", row?.reason || "This notification does not support a Copilot action.", 409);
    const signal = this.inbox.controller.signal;
    let action = {
      Issue: "issue", PullRequest: "review", Release: "release", CheckSuite: "ci", Discussion: "discussion", Commit: "commit",
    }[item.type];
    let askForReviewSkill = false;
    let details;
    if (action === "review") {
      const [viewer, pull] = await parallelReads([
        this.inbox.client.copilotContext("viewer", null, signal),
        this.inbox.client.copilotContext("pull", item, signal),
      ]);
      details = pull;
      if (details.state === "closed") action = "summarize";
      else {
        askForReviewSkill = viewer.id !== details.authorId;
        if (viewer.id === details.authorId) action = "continue";
      }
    } else if (action === "ci") {
      details = await this.inbox.client.copilotContext("run", item, signal);
    } else if (action === "release") {
      details = await this.inbox.client.copilotContext("release", item, signal);
    } else if (action === "issue") {
      details = await this.inbox.client.copilotContext("issue", item, signal);
      if (details.state === "closed") action = "issueSummary";
    } else if (action === "commit") {
      details = await this.inbox.client.copilotContext("commit", item, signal);
    }
    const target = {
      id, action, repository: item.repository, number: item.type === "Discussion" ? item.discussionNumber : item.number,
      url: details?.url ?? item.url,
      name: item.type === "Issue" ? `Investigate issue #${item.number}` : `Work on PR #${item.number}`,
      ...(item.type === "PullRequest" ? {
        sha: details.sha, pullState: details.merged ? "merged" : details.state, observedPullState: item.subjectState,
      } : {}),
      ...(item.type === "Issue" ? { issueState: details.state, observedIssueState: item.subjectState } : {}),
      ...(action === "discussion" ? { name: `Summarize discussion #${item.discussionNumber}` } : {}),
      ...(action === "commit" ? { sha: details.sha,
        name: `Commit ${createHash("sha256").update(details.url).digest("hex").slice(0, 32)}` } : {}),
      ...(askForReviewSkill ? { askForReviewSkill: true } : {}),
      ...(action === "release" ? { releaseId: details.releaseId, name: `Summarize release ${details.releaseId}` } : {}),
      ...(action === "ci" ? { sha: details.sha, attempt: details.attempt,
        inferred: item.subjectLinkSource === "inferred",
        name: ciSessionName(details) } : {}),
    };
    const [repositories, { matching }] = await parallelReads([
      this.host.execute("list_repositories", {}, true), this.#sessions(target),
    ]);
    await this.#active(id, false, { pullState: target.pullState });
    const configured = repositories.some(repo => sameRepo(repo.github_repo, target.repository));
    this.#ready(target, matching, configured);
    // A saved opt-out only applies to a fresh row click, never to polling.
    if (direct && !this.confirmCopilotActions && !target.inferred && !matching.length && configured) {
      this.state = { id, status: "starting" };
      await this.#start({ id, direct: true });
    }
  }

  async #verifyContext(target) {
    const kind = target.pullState ? "pull" : target.issueState ? "issue" :
      ["release", "commit"].includes(target.action) ? target.action : null;
    if (!kind) return;
    const details = await this.inbox.client.copilotContext(kind, this.#item(target.id), this.inbox.controller.signal);
    if (target.pullState && (details.merged ? "merged" : details.state) !== target.pullState) throw changedPull();
    if (target.pullState && details.sha !== target.sha) {
      throw new InboxError("stale_handoff", "This pull request's head commit changed. Open the Copilot action again to confirm the updated commit.", 409);
    }
    if (target.issueState && details.state !== target.issueState) throw changedIssue();
    if (target.action === "commit" && details.sha !== target.sha) {
      throw new InboxError("stale_handoff", "The selected commit changed. Open the Copilot action again to confirm the exact commit.", 409);
    }
    if (target.action === "release" && (details.releaseId !== target.releaseId || details.url !== target.url)) {
      throw new InboxError("stale_handoff", "This release changed. Open the Copilot action again to confirm the selected release.", 409);
    }
  }

  async #start(input) {
    await this.#active(input.id, input.direct);
    const target = this.target;
    const key = target.url;
    if (this.host.reservations.has(key)) throw new InboxError("copilot_busy", "This item is already being handed to Copilot in another panel.", 409);
    this.host.reservations.add(key);
    try {
      const progress = message => { this.state = { id: input.id, status: "starting", message }; };
      const [, { all, matching }, configured] = await parallelReads([
        this.#verifyContext(target),
        this.#sessions(target),
        input.sessionId ? null : this.host.execute("list_repositories", {}, true),
      ]);
      await this.#active(input.id, input.direct, { forceQueue: true });
      const sessionId = input.sessionId;
      if (sessionId) {
        if (!this.existing.has(sessionId) ||
            !all.some(session => session.id === sessionId &&
              (sameRepo(session.project_repo, target.repository) || matches(session, target)))) {
          throw new InboxError("stale_handoff", "The selected session is no longer available. Open this action again.", 409);
        }
        await this.#remember(input);
        progress("Opening existing session...");
        await this.host.execute("navigate_to", { id: sessionId });
        this.state = { id: input.id, status: "opened", message: "Opened the existing session without sending instructions or interrupting its work." };
        return;
      }
      let repositories = configured;
      const sameSelection = sessions => sessions.length === this.existing.size &&
        sessions.every(session => this.existing.has(session.id));
      if (input.startNew ? !sameSelection(matching) : matching.length) {
        this.#ready(target, matching, repositories.some(repo => sameRepo(repo.github_repo, target.repository)));
        return;
      }
      if (!repositories.some(repo => sameRepo(repo.github_repo, target.repository))) {
        if (!input.clone) throw new InboxError("copilot_clone", "Confirm repository setup before starting this session.", 409);
        await this.#active(input.id, input.direct);
        await this.#remember(input);
        progress("Setting up repository...");
        await this.host.execute("add_repository", { github_repo: target.repository });
        repositories = await this.host.execute("list_repositories", {}, true);
      }
      const repository = repositories.find(repo => sameRepo(repo.github_repo, target.repository));
      if (!repository || !uuid.test(repository.id)) {
        throw new InboxError("copilot_setup", "Repository setup has not completed. Finish setup in Copilot, then open this action again.", 409);
      }
      await this.#active(input.id, input.direct);
      await this.#remember(input);
      if (target.sha) {
        progress("Preparing checkout...");
        await this.host.prepareCommit(repository, target, {
          signal: this.inbox.controller.signal, beforeFetch: async () => {
            await this.#active(input.id, input.direct);
            progress("Fetching selected commit...");
          },
        });
        await this.#active(input.id, input.direct);
      }
      const latest = await this.#sessions(target);
      await this.#active(input.id, input.direct);
      if (input.startNew ? !sameSelection(latest.matching) : latest.matching.length) {
        this.#ready(target, latest.matching, true);
        return;
      }
      // Setup and inventory waits can outlive the earlier context check.
      await this.#verifyContext(target);
      await this.#active(input.id, input.direct, { forceQueue: true });
      // The host queues the kickoff until ready; startup activity is not a reuse signal.
      progress("Starting session. Check the app for any permission or repository trust requests.");
      const result = await this.host.execute("create_session", {
        project_id: repository.id, name: target.name, workspace_type: "worktree", detached: true,
        ...(target.sha ? { base_branch: target.sha } : {}),
        kickoff: { prompt: promptFor(target), mode: "plan" },
      });
      const text = typeof result === "string" ? result : JSON.stringify(result);
      const ids = new Set([...text.matchAll(/(?:session_id[":\s]+|ghapp:\/\/sessions\/)([a-f0-9-]{36})/gi)].map(match => match[1]));
      const [id] = ids;
      if (ids.size !== 1 || !uuid.test(id) || latest.all.some(session => session.id === id)) throw hostFailure();
      const opened = await this.#sessions(target);
      if (!opened.all.some(session => session.id === id &&
          (sameRepo(session.project_repo, target.repository) || matches(session, target)))) throw hostFailure();
      await this.#active(input.id, input.direct);
      progress("Opening new session...");
      await this.host.execute("navigate_to", { id });
      this.state = { id: input.id, status: "started", message: "Opened a summary-first Copilot session. Read/Done is unchanged." };
    } finally {
      this.host.reservations.delete(key);
    }
  }
}
