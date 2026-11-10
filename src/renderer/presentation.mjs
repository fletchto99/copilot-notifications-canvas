const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/*!
 * Copilot icon: https://github.com/primer/octicons/blob/main/icons/copilot-16.svg
 *
 * MIT License
 *
 * Copyright (c) 2026 GitHub Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const iconPaths = {
  read: "M3 9 12 3l9 6v11H3V9Zm0 0 9 6 9-6M3 20l6-7m12 7-6-7",
  done: "m5 12 4 4L19 6",
  copilot: "M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z",
};
const issueOutline = "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z";
const pullRequestNodes = "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z";
const pendingCheck = `${issueOutline}M12 7v5l3 2`;
const failedCheck = "M6 6 18 18M6 18 18 6";
const bellIcon = "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21a2 2 0 0 0 4 0";
const securityIcon = "M12 3 21 6v6c0 5-9 9-9 9s-9-4-9-9V6l9-3ZM12 8v5m0 4h.01";
const discussionOutline = "M3 4h14v10H8l-5 4V4Zm5 10v4h8l5 3V8h-4";
const subjectTypeIcons = {
  Release: "M3 3h7l11 11-7 7L3 10V3ZM7 7h.01",
  Commit: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 12h5m8 0h5",
  RepositoryAdvisory: securityIcon,
  RepositoryVulnerabilityAlert: securityIcon,
  RepositoryDependabotAlertsThread: securityIcon,
  RepositoryInvitation: "M3 5h18v14H3V5Zm0 0 9 7 9-7",
  WorkflowRun: "M3 3h6v6H3ZM15 15h6v6h-6ZM6 9v9h9M9 6h9v9",
  AgentSessionThread: "M5 7h14v13H5V7ZM12 3v4M2 11v5m20-5v5M9 11v2m6-2v2M9 17h6",
};
const subjectIcons = {
  Issue: {
    unknown: `${issueOutline}M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z`,
    open: `${issueOutline}M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z`,
    closed: `${issueOutline}m-13-1 3 3 5-5`,
    not_planned: `${issueOutline}M6 18 18 6`,
    duplicate: `${issueOutline}M6 18 18 6`,
  },
  PullRequest: {
    unknown: `${pullRequestNodes}M6 7v10M18 17V9a4 4 0 0 0-4-4h-1m3-3-3 3 3 3`,
    open: `${pullRequestNodes}M6 7v10M18 17V9a4 4 0 0 0-4-4h-1m3-3-3 3 3 3`,
    draft: `${pullRequestNodes}M6 7v2m0 3v2m0 2v1M18 17v-2m0-3V9m0-3V5`,
    closed: `${pullRequestNodes}M6 7v10M18 17v-6m-3-8 6 6m0-6-6 6`,
    merged: "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM21 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6 7v10m0-10c0 3 4 5 11 5",
    merge_queued: "M6 11v6M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM21 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6.75 5a.75 .75 0 1 1-1.5 0 .75 .75 0 0 1 1.5 0ZM12.25 8.5a.75 .75 0 1 1-1.5 0 .75 .75 0 0 1 1.5 0Z",
  },
  Discussion: {
    unknown: discussionOutline,
    open: discussionOutline,
    answered: "M3 4h18v13H9l-6 4V4ZM7 10l3 3 6-6",
    closed: `${discussionOutline}M6 9l2 2 5-5`,
    duplicate: `${discussionOutline}M8 11l4-4`,
    outdated: `${discussionOutline}M9 7v3l3 1`,
  },
  CheckSuite: {
    unknown: "M4 3h16v18H4ZM8 8h8M8 12h8M8 16h4",
    success: "m5 12 4 4L19 6",
    failure: failedCheck,
    queued: pendingCheck,
    in_progress: pendingCheck,
    waiting: pendingCheck,
    requested: pendingCheck,
    pending: pendingCheck,
    neutral: "M5 12h14",
    cancelled: `${issueOutline}M6 18 18 6`,
    skipped: "m6 5 9 7-9 7ZM18 5v14",
    timed_out: failedCheck,
    action_required: `${issueOutline}M12 7v6m0 4h.01`,
    startup_failure: failedCheck,
    stale: pendingCheck,
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
  const icon = svgIcon(iconPaths[action], 18);
  if (action === "copilot") {
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("fill", "currentColor");
    icon.setAttribute("stroke", "none");
  }
  return icon;
}

function svgIcon(d, size) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  for (const [name, value] of Object.entries({
    width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value);
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

export function subjectMetadata(item, field = element("span")) {
  const type = item.type.replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Notification";
  const labelText = item.number ? `${type} #${item.number}` : type;
  if (!field.children.length) {
    const icon = element("span", "subject-icon");
    icon.setAttribute("role", "img");
    icon.append(svgIcon("", 16));
    field.append(icon, element("span", "notification-type"));
  }
  const [icon, label] = field.children;
  setControlText(label, labelText);
  field.dataset.subjectType = item.type;
  if (!Object.hasOwn(subjectIcons, item.type)) {
    field.className = "notification-subject";
    icon.querySelectorAll("path")[0].setAttribute("d",
      Object.hasOwn(subjectTypeIcons, item.type) ? subjectTypeIcons[item.type] : bellIcon);
    icon.dataset.description = type;
    delete icon.dataset.checkedAt;
    updateSubjectDescription(icon);
    return field;
  }
  const status = Object.hasOwn(subjectIcons[item.type], item.subjectState) ? item.subjectState : "unknown";
  const linkLoading = item.subjectLinkLoading === true;
  const loading = linkLoading || item.subjectLoading === true && status === "unknown" && !item.subjectStateError;
  field.className = `notification-subject subject-${loading ? "loading" : status.replaceAll("_", "-")}`;
  icon.querySelectorAll("path")[0].setAttribute("d", loading ? "M21 12a9 9 0 1 1-9-9" : subjectIcons[item.type][status]);
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
