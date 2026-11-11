import { octicons } from "./octicons.mjs";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const actionIcons = { read: "read", done: "check", copilot: "copilot" };
const subjectTypeIcons = {
  Release: "tag",
  Commit: "git-commit",
  RepositoryAdvisory: "shield-lock",
  RepositoryVulnerabilityAlert: "shield-lock",
  RepositoryDependabotAlertsThread: "shield-lock",
  RepositoryInvitation: "mail",
  WorkflowRun: "workflow",
  AgentSessionThread: "agent",
};
const subjectIcons = {
  Issue: {
    unknown: "issue-opened",
    open: "issue-opened",
    closed: "issue-closed",
    not_planned: "skip",
    duplicate: "skip",
  },
  PullRequest: {
    unknown: "git-pull-request",
    open: "git-pull-request",
    draft: "git-pull-request-draft",
    closed: "git-pull-request-closed",
    merged: "git-merge",
    merge_queued: "git-merge-queue",
  },
  Discussion: {
    unknown: "comment-discussion",
    open: "comment-discussion",
    answered: "check-circle",
    closed: "discussion-closed",
    duplicate: "discussion-duplicate",
    outdated: "discussion-outdated",
  },
  CheckSuite: {
    unknown: "checklist",
    success: "check",
    failure: "x",
    queued: "clock",
    in_progress: "clock",
    waiting: "clock",
    requested: "clock",
    pending: "clock",
    neutral: "dash",
    cancelled: "circle-slash",
    skipped: "skip",
    timed_out: "x",
    action_required: "report",
    startup_failure: "x",
    stale: "clock",
  },
};
const subjectLabels = {
  open: "Open", closed: "Closed", not_planned: "Closed (not planned)", duplicate: "Closed (duplicate)", draft: "Draft", merged: "Merged",
  answered: "Answered", outdated: "Closed (outdated)",
  merge_queued: "In merge queue", success: "Passing", failure: "Failed", queued: "Queued", in_progress: "In progress",
  waiting: "Waiting", requested: "Requested", pending: "Pending", neutral: "Neutral", cancelled: "Cancelled",
  skipped: "Skipped", timed_out: "Timed out", action_required: "Action required", startup_failure: "Startup failure", stale: "Stale",
};

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setControlText(control, text) {
  // Replacing an unchanged button label during a pointer press cancels its click in WebKit.
  if (control.textContent !== text) control.textContent = text;
}

export function actionIcon(action) {
  return svgIcon(actionIcons[action], 18);
}

export function setIcon(svg, name) {
  const icon = octicons[name];
  svg.setAttribute("viewBox", `0 0 ${icon.width} 16`);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  for (const [index, d] of icon.paths.entries()) {
    let path = svg.children[index];
    if (!path) {
      path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.append(path);
    }
    if (path.getAttribute("d") !== d) path.setAttribute("d", d);
  }
  while (svg.children.length > icon.paths.length) svg.children[svg.children.length - 1].remove();
}

function svgIcon(name, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    width: String(size), height: String(size), "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value);
  setIcon(svg, name);
  return svg;
}

export function subjectMetadata(item, field = element("span")) {
  const type = item.type.replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Notification";
  const labelText = item.number ? `${type} #${item.number}` : type;
  if (!field.children.length) {
    const icon = element("span", "subject-icon");
    icon.setAttribute("role", "img");
    icon.append(svgIcon("bell", 16));
    field.append(icon, element("span", "notification-type"));
  }
  const [icon, label] = field.children;
  setControlText(label, labelText);
  field.dataset.subjectType = item.type;
  if (!Object.hasOwn(subjectIcons, item.type)) {
    field.className = "notification-subject";
    setIcon(icon.children[0], Object.hasOwn(subjectTypeIcons, item.type) ? subjectTypeIcons[item.type] : "bell");
    icon.dataset.description = type;
    delete icon.dataset.checkedAt;
    updateSubjectDescription(icon);
    return field;
  }
  const status = Object.hasOwn(subjectIcons[item.type], item.subjectState) ? item.subjectState : "unknown";
  const linkLoading = item.subjectLinkLoading === true;
  const loading = linkLoading || item.subjectLoading === true && status === "unknown" && !item.subjectStateError;
  field.className = `notification-subject subject-${loading ? "loading" : status.replaceAll("_", "-")}`;
  setIcon(icon.children[0], loading ? "sync" : subjectIcons[item.type][status]);
  const stateLabel = subjectLabels[status] ?? (linkLoading ? "Loading run destination" : item.subjectStateError ? "Status unavailable" : loading ? "Loading status" : "Status not loaded yet");
  const description = `${type}: ${stateLabel}${linkLoading && status !== "unknown" ? ". Loading run destination" : ""}${item.subjectStateSource === "notification"
    ? ". Reported by this notification; may not reflect a later rerun." : ""}${item.subjectStateStale
    ? ". Cached result; refresh failed" : ""}${item.subjectStateError ? `. ${item.subjectStateError}` : ""}${item.subjectLinkSource === "inferred"
    ? ". Run link inferred from workflow, branch, result, attempt and timing; not confirmed by GitHub." : ""}${item.subjectLinkTarget === "job"
    ? ". Opens the only failed job's log viewer." : ""}${item.subjectLinkError ? `. ${item.subjectLinkError}` : ""}`;
  icon.dataset.description = description;
  if (Number.isFinite(item.subjectCheckedAt) && item.subjectCheckedAt >= 0) icon.dataset.checkedAt = String(item.subjectCheckedAt);
  else delete icon.dataset.checkedAt;
  updateSubjectDescription(icon);
  return field;
}

export function relativeTime(date) {
  const seconds = Math.round(((typeof date === "number" ? date : Date.parse(date)) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  for (const [unit, divisor] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= divisor) return relative.format(Math.trunc(seconds / divisor), unit);
  }
}

export function updateSubjectDescription(icon) {
  const age = icon.dataset.checkedAt === undefined ? "" :
    `${icon.dataset.description.endsWith(".") ? " " : ". "}Checked ${relativeTime(Math.min(Date.now(), Number(icon.dataset.checkedAt)))}`;
  const description = icon.dataset.description + age;
  icon.setAttribute("aria-label", description);
}
