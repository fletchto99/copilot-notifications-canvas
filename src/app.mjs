import { apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle } from "./model.mjs";

const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const hasCapability = /^[a-f0-9]{64}$/.test(token);
const collapsed = new Set();
const attentionTabs = new Map();
const rowViews = new Map();
const groupViews = new Map();
const tooltipAnchorsByControl = new WeakMap();
let pointerInteraction = false;
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
let state;
let renderedSnapshotVersion = 0;
let listKey;
let busy = false;
let stopped = false;
let intersecting = true;
let timer;
let tooltipTimer;
let overlayFrame;
let subjectSelectionFrame;
let lastSubjectSelection;
let subjectSelectionVersion = 0;
let subjectSelectionPending = false;
let subjectSelectionError = "";
let subjectSelectionRetryAt = 0;
let refreshStatusKey;
let searchTimer;
let searchComposing = false;
let searchFocusRequested = false;
let searchEnterHeld = false;
let pendingFilters;
let inFlightAttention;
let pendingRefresh = false;
let refreshing = false;
let pollPromise;
const requestControllers = new Set();
let connectionError = "";
let preferences;
let settingsBusy = false;
let settingsError = "";
let pendingSettings;
let soundOptionsKey;
let developmentSettingsKey;
let releaseState;
let updatesBusy = false;
let updateError = "";
let copyFeedbackTimer;
let copyAttempt = 0;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeAttributes = ["data-theme-tone", "data-color-mode"];
const marking = new Map();
let actionError = "";
let batchBusy = 0;
const batchRequests = new Map();
const batchViews = new Map();
const batchFocusKeys = new Map();
const batchControlItems = new WeakMap();
let primaryBatchView;
let shortcutReturnFocus;
let copilotOperation;
let copilotReturnFocus;
let copilotRequestPending = false;
let copilotDialogKey;
let copilotAwaitingResult = false;
let skipCopilotConfirmation = false;
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
    duplicate: `${issueOutline}m-13-1 3 3 5-5`,
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
const tooltipControls = [
  ["open-inbox", "inbox-control"],
  ["force-refresh", "refresh-control"],
  ["shortcuts-toggle", "shortcuts-control"],
  ["settings-toggle", "settings-toggle"],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setControlText(control, text) {
  // Replacing an unchanged button label during a pointer press cancels its click in WebKit.
  if (control.textContent !== text) control.textContent = text;
}

function actionIcon(action) {
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

function subjectMetadata(item, field = element("span")) {
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

function relativeTime(date) {
  const seconds = Math.round(((typeof date === "number" ? date : Date.parse(date)) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  for (const [unit, divisor] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= divisor) return relative.format(Math.trunc(seconds / divisor), unit);
  }
}

function updateSubjectDescription(icon) {
  const age = icon.dataset.checkedAt === undefined ? "" :
    `${icon.dataset.description.endsWith(".") ? " " : ". "}Checked ${relativeTime(Math.min(Date.now(), Number(icon.dataset.checkedAt)))}`;
  const description = icon.dataset.description + age;
  icon.setAttribute("aria-label", description);
}

function expandedSubjectSelection() {
  if (!state || !visible()) return;
  const items = state.groups.flatMap(group => group.items).sort((a, b) => a.apiPosition - b.apiPosition);
  const positions = new Map(items.map((item, index) => [item.id, index]));
  return JSON.stringify({
    selectionKey: state.selectionKey,
    positions: displayGroups().filter(group => !collapsed.has(group.key))
      .flatMap(group => group.items.map(item => positions.get(item.id))),
  });
}

function scheduleSubjectSelectionSync() {
  if (!hasCapability || !visible() || !state || connectionError || subjectSelectionPending ||
      Date.now() < subjectSelectionRetryAt || subjectSelectionFrame !== undefined ||
      expandedSubjectSelection() === lastSubjectSelection) return;
  subjectSelectionFrame = requestAnimationFrame(() => {
    subjectSelectionFrame = undefined;
    if (!visible() || subjectSelectionPending || busy || batchBusy || marking.size || pendingFilters || pollPromise) return;
    if (expandedSubjectSelection() !== lastSubjectSelection) void syncSubjectSelection();
  });
}

async function syncSubjectSelection() {
  const selection = expandedSubjectSelection();
  const { selectionKey, positions } = JSON.parse(selection);
  const version = subjectSelectionVersion = Math.max(subjectSelectionVersion, state.subjectSelectionVersion ?? 0) + 1;
  subjectSelectionPending = true;
  lastSubjectSelection = undefined;
  let refreshNeeded = false;
  try {
    for (let offset = 0; ; offset += 100) {
      if (expandedSubjectSelection() !== selection) return;
      const complete = offset + 100 >= positions.length;
      const result = await api("subjects", { version, selectionKey, offset, positions: positions.slice(offset, offset + 100), complete });
      if (!Number.isSafeInteger(result?.version) || result.version < 0 ||
          !["stale", complete ? "complete" : "pending"].includes(result.status) ||
          result.status !== "stale" && result.version !== version) {
        throw new Error("The provider returned an invalid status selection response.");
      }
      subjectSelectionVersion = Math.max(subjectSelectionVersion, result.version);
      if (result.status === "stale") {
        refreshNeeded = true;
        return;
      }
      if (complete) break;
    }
    lastSubjectSelection = selection;
    subjectSelectionError = "";
    refreshNeeded = true;
  } catch (error) {
    if (!visible() && error.name === "AbortError") return;
    subjectSelectionError = `Notification status loading paused. ${error.name === "AbortError"
      ? "The status selection request timed out." : error.message || "The status selection request failed."} Retrying automatically.`;
    subjectSelectionRetryAt = Date.now() + 5000;
  } finally {
    subjectSelectionPending = false;
    render();
    if (refreshNeeded) {
      await pollPromise;
      void update();
    }
  }
}

async function api(path, input) {
  const controller = new AbortController();
  requestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const groupBy = path === "settings" ? input?.groupBy ?? preferences?.groupBy : preferences?.groupBy;
    const timeZone = groupBy === "date" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
    if (groupBy === "date" && (typeof timeZone !== "string" || !timeZone)) {
      throw new Error("Date grouping requires a supported browser time zone. Choose another grouping in Settings.");
    }
    const response = await fetch(`/api/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input === undefined ? {} : { "Content-Type": "application/json" }),
        ...(groupBy ? { "X-Notification-Group-By": groupBy } : {}),
        ...(timeZone ? { "X-Notification-Time-Zone": timeZone } : {}),
        "X-Notification-Subjects": "manual",
        ...(path === "state" ? { "X-Notification-Acknowledged-Version": String(renderedSnapshotVersion) } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `Canvas returned HTTP ${response.status}.`);
    return result;
  } finally {
    clearTimeout(timeout);
    requestControllers.delete(controller);
  }
}

function renderTheme() {
  const theme = preferences?.darkMode === true ? "dark" : preferences?.darkMode === false ? "light" : "system";
  const mode = [document.documentElement, document.body]
    .flatMap(node => themeAttributes.map(attribute => node.getAttribute(attribute)))
    .find(value => value === "dark" || value === "light");
  const colorScheme = theme === "system" ? mode ?? (systemTheme.matches ? "dark" : "light") : theme;
  document.documentElement.style.colorScheme = colorScheme;
  if (theme === "system" && mode) {
    delete document.documentElement.dataset.notificationTheme;
  } else {
    document.documentElement.dataset.notificationTheme = colorScheme;
  }
  $("theme").value = theme;
}

function renderNotificationView() {
  const unreadOnly = state?.filters.mode === "unread";
  $("show-notifications").value = unreadOnly || preferences?.matchGitHubInbox === false ? "unread" : "all";
  $("show-notifications").disabled = settingsBusy || !preferences || unreadOnly ||
    busy || state?.status === "loading" || batchBusy || batchLocked() || marking.size > 0;
}

function renderSettingsError() {
  const message = settingsError || state?.settingsError?.message || "";
  $("settings-error").textContent = message;
  $("settings-error").hidden = !message;
}

function renderSettings() {
  renderNotificationView();
  $("theme").disabled = settingsBusy || !preferences;
  renderTheme();
  $("group-by").disabled = settingsBusy || !preferences;
  $("group-by").value = preferences?.groupBy ?? "repo";
  for (const [id, key] of [
    ["auto-open", "autoOpen"],
    ["desktop-notifications", "desktopNotifications"],
    ["copilot-integration", "copilotIntegration"],
    ["copilot-confirmations", "confirmCopilotActions"],
    ["hide-empty-tabs", "hideEmptyTabs"],
    ["keyboard-shortcuts", "keyboardShortcuts"],
  ]) {
    if (preferences) {
      $(id).setAttribute("aria-checked", String(key === "copilotIntegration" ? copilotEnabled() :
        key === "confirmCopilotActions" ? copilotConfirmations() : Boolean(preferences[key])));
    }
    $(id).disabled = settingsBusy || !preferences ||
      (id === "copilot-confirmations" && !copilotEnabled()) ||
      (id === "desktop-notifications" && !preferences.desktopStatus?.supported);
  }
  const select = $("desktop-sound");
  select.disabled = settingsBusy || !preferences?.desktopNotifications || !preferences?.desktopStatus?.supported;
  if (preferences) {
    const choices = [...(preferences.desktopStatus?.sounds ?? [])];
    if (!choices.some(choice => choice.value === preferences.desktopSound)) {
      choices.push({ value: preferences.desktopSound, label: `Unavailable on this platform: ${preferences.desktopSound}` });
    }
    const key = JSON.stringify(choices);
    if (key !== soundOptionsKey) {
      const fragment = document.createDocumentFragment();
      for (const choice of choices) {
        const option = element("option", "", choice.label);
        option.value = choice.value;
        fragment.append(option);
      }
      select.replaceChildren(fragment);
      soundOptionsKey = key;
    }
    select.value = preferences.desktopSound;
    const status = preferences.desktopStatus;
    $("desktop-status").textContent = !status?.supported || status.state === "error"
      ? status?.message || "Desktop notifications are unavailable."
      : "";
    $("desktop-status").hidden = !$("desktop-status").textContent;
  }
  const api = preferences?.developmentApi;
  $("development-settings").hidden = !api;
  if (api) {
    if (developmentSettingsKey !== api.savedBaseUrl) {
      $("development-api").value = api.savedBaseUrl === "https://api.github.com" ? "github" : "custom";
      $("development-api-url").value = api.savedBaseUrl === "https://api.github.com" ? "" : api.savedBaseUrl;
      developmentSettingsKey = api.savedBaseUrl;
    }
    $("development-api").disabled = settingsBusy;
    $("development-api-url").disabled = settingsBusy || $("development-api").value !== "custom";
    $("development-api-custom").hidden = $("development-api").value !== "custom";
    $("development-api-save").disabled = settingsBusy;
    $("development-api-active").textContent = `Active API: ${api.baseUrl}`;
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    $("development-api-shortcut").textContent = /^mac/i.test(platform) ? "\u2318+K" : "Ctrl+K";
    $("development-api-reload").hidden = !api.requiresReload;
  }
  renderSettingsError();
  positionSettings();
}

async function settingsRequest(input, quiet = false, path = "settings") {
  if (!visible()) return;
  const active = document.activeElement;
  // Settings must not restore a row action's focus while that action is pending.
  const previousFocus = $("settings").contains(active) ? active?.closest("select") ?? active : null;
  if (settingsBusy) {
    if (input && !pendingSettings) {
      pendingSettings = { input, path, focus: previousFocus };
      renderSettings();
    }
    return;
  }
  // WebKit can retain a picker's option focus through disabling and re-enabling its select.
  if (input && previousFocus && previousFocus !== active) previousFocus.focus({ preventScroll: true });
  let refreshInbox = false;
  settingsBusy = true;
  if (!quiet) {
    settingsError = "";
    renderSettings();
    $("settings-status").textContent = input ? "" : "Loading...";
    $("settings-status").hidden = !$("settings-status").textContent;
  }
  try {
    if (input && ["copilotIntegration", "confirmCopilotActions"].some(key => Object.hasOwn(input, key))) await pollPromise;
    preferences = await api(path, input);
    settingsError = "";
    if (state) {
      state.settingsError = null;
      state.copilotIntegration = preferences.copilotIntegration;
      state.confirmCopilotActions = preferences.confirmCopilotActions;
    }
    render();
    refreshInbox = input && Object.hasOwn(input, "matchGitHubInbox");
    $("settings-status").textContent = "";
  } catch (error) {
    $("settings-status").textContent = `${error.message || "Settings request failed."} Close and reopen Settings to retry.`;
    settingsError = $("settings-status").textContent;
  } finally {
    settingsBusy = false;
    $("settings-status").hidden = !$("settings-status").textContent;
    renderSettings();
    restoreFocus(previousFocus);
    if (pendingSettings && visible()) {
      const next = pendingSettings;
      pendingSettings = undefined;
      restoreFocus(next.focus);
      void settingsRequest(next.input, false, next.path);
    }
    if (refreshInbox) void update("refresh", {});
    else if (input && ["copilotIntegration", "confirmCopilotActions"].some(key => Object.hasOwn(input, key))) void update();
  }
}

function renderUpdates(updates = releaseState) {
  $("check-updates").disabled = !hasCapability;
  $("check-updates").setAttribute("aria-busy", String(updatesBusy || Boolean(updates?.checking)));
  if (!updates) {
    const message = updateError || (updatesBusy ? "Checking..." : "");
    $("update-status").textContent = message ? ` - ${message}` : "";
    $("update-status").hidden = !message;
    return;
  }
  if (releaseState?.currentVersion !== updates.currentVersion ||
      releaseState?.latestVersion !== updates.latestVersion ||
      releaseState?.status !== updates.status || releaseState?.prompt !== updates.prompt) {
    copyAttempt++;
    resetCopyFeedback();
  }
  releaseState = updates;
  $("installed-version").textContent = `Notifications Canvas v${updates.currentVersion}`;
  const messages = {
    unchecked: "",
    no_release: "No stable release yet.",
    current: "Up to date",
    ahead: "Newer than the latest release.",
    available: `Update available: v${updates.latestVersion}.`,
  };
  const retry = updates.error && Date.now() < updates.canCheckAt
    ? ` Retry after ${new Date(updates.canCheckAt).toLocaleTimeString()}.` : "";
  const message = updateError || (updatesBusy || updates.checking ? "Checking..." :
    updates.error ? `${updates.error}${retry}` : messages[updates.status]);
  $("update-status").textContent = message ? ` - ${message}` : "";
  $("update-status").hidden = !message;
  const available = updates.status === "available";
  $("update-banner").hidden = !available;
  if (!available) {
    setUpdateDetails(false);
    return;
  }
  $("update-title").textContent = `Update available \u00b7 v${updates.latestVersion}`;
  $("update-current-version").textContent = `Currently v${updates.currentVersion}`;
  $("update-stale").hidden = !updates.error;
  $("update-stale").textContent = updates.error ? "Last known release; the latest check failed." : "";
  $("release-notes").href = updates.releaseUrl;
  $("update-instructions").href = updates.instructionsUrl;
  if ($("update-prompt").value !== updates.prompt) {
    $("update-prompt").value = updates.prompt;
  }
}

function setUpdateDetails(open) {
  const details = $("update-prompt-details");
  const toggle = $("update-details-toggle");
  if (!open && document.hasFocus() && details.contains(document.activeElement)) toggle.focus();
  details.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

function resetCopyFeedback() {
  clearTimeout(copyFeedbackTimer);
  $("copy-update").textContent = "Copy update prompt";
  $("copy-status").textContent = "";
}

async function checkUpdates() {
  if (!visible() || updatesBusy) return;
  updatesBusy = true;
  updateError = "";
  renderUpdates();
  try {
    renderUpdates(await api("updates", {}));
  } catch (error) {
    updateError = error.message || "Could not check for updates. Try again.";
  } finally {
    updatesBusy = false;
    renderUpdates();
  }
}

async function copyUpdatePrompt() {
  if (!visible() || releaseState?.status !== "available" || !releaseState.prompt) return;
  const attempt = ++copyAttempt;
  const prompt = releaseState.prompt;
  resetCopyFeedback();
  try {
    await navigator.clipboard.writeText(prompt);
    if (attempt !== copyAttempt || !visible() || releaseState?.status !== "available" || releaseState.prompt !== prompt) return;
    resetCopyFeedback();
    $("copy-update").textContent = "Copied";
    $("copy-status").textContent = "Paste into Copilot to review and run.";
    copyFeedbackTimer = setTimeout(() => {
      $("copy-update").textContent = "Copy update prompt";
    }, 4000);
  } catch {
    if (attempt !== copyAttempt || !visible() || releaseState?.status !== "available" || releaseState.prompt !== prompt) return;
    resetCopyFeedback();
    setUpdateDetails(true);
    if (document.hasFocus()) {
      $("update-prompt").focus();
      $("update-prompt").select();
    }
    $("copy-status").textContent = "Clipboard unavailable. Copy the selected prompt and paste it into Copilot.";
  }
}

function positionSettings() {
  if (!$("settings").open) return;
  const panel = $("settings-panel");
  const { top, bottom } = $("settings-toggle").getBoundingClientRect();
  const height = window.innerHeight;
  if (bottom <= 0 || top >= height) return closeSettings();
  // Reserve an 8px button gap and an 8px viewport margin.
  const below = Math.max(0, height - bottom - 16);
  const above = Math.max(0, top - 16);
  const preferred = Math.min(height * 0.6, panel.scrollHeight + 2);
  const useAbove = below < preferred && above > below;
  panel.dataset.placement = useAbove ? "above" : "below";
  panel.style.maxHeight = `${Math.min(height * 0.6, useAbove ? above : below)}px`;
}

function closeSettings(focus = false) {
  $("settings").open = false;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  $("settings-toggle").dataset.tooltipDismissed = "true";
  if (focus && document.hasFocus()) $("settings-toggle").focus();
}

async function markThread(id, action, focusRow = false) {
  if (!visible() || busy || lockedThreads().has(id) || pendingFilters) return;
  const key = `${focusRow ? "thread" : action}:${id}`;
  const operation = { id, action, focusRow, key, previousFocus: document.activeElement,
    order: displayGroups().filter(group => !focusRow || !collapsed.has(group.key)).flatMap(group => group.items.map(item => item.id)),
    token: null, completed: false, knownTokens: new Set(state.batches.map(batch => batch.token)), error: "" };
  dismissTooltips();
  marking.set(id, operation);
  renderControls();
  schedule();
  actionError = "";
  try {
    await pollPromise;
    if (operation.completed) return;
    if (!visible()) {
      if (marking.get(id) === operation) marking.delete(id);
      return;
    }
    const snapshot = await api(action, { id });
    if (operation.completed) return;
    if (typeof snapshot.rowActionToken !== "string" || !/^[a-f0-9-]{36}$/.test(snapshot.rowActionToken)) {
      throw new Error("The provider returned an invalid notification action acknowledgement.");
    }
    operation.token = snapshot.rowActionToken;
    acceptState(snapshot);
    if (state.batches.some(batch => batch.token === operation.token && batchRunning(batch))) await update();
  } catch (error) {
    if (operation.completed) return;
    operation.error = `Could not confirm the notification action (${action}). ${error.message || "Try again."}`;
    operation.recoveryVersion = state.snapshotVersion;
    try {
      acceptState(await api("state"));
    } catch {
      operation.error += " Could not reconnect. Reopen this panel to inspect its current state.";
    }
  } finally {
    render();
    if (!operation.completed && !marking.has(id)) {
      restoreFocus(operation.previousFocus, focusKey(rowFocusKey(operation)) ?? $("search"));
    }
    void flushPendingUpdates();
    schedule();
  }
}

function rowFocusKey({ id, action, focusRow, key, order }) {
  const items = displayGroups().filter(group => !focusRow || !collapsed.has(group.key)).flatMap(group => group.items);
  const retained = items.find(item => item.id === id);
  if (retained && (action !== "read" || retained.unread)) return key;
  if (retained && !focusRow) return `done:${id}`;
  const index = order.indexOf(id);
  const next = order.slice(index + 1).find(id => items.some(item => item.id === id)) ??
    (retained ? id : order.slice(0, index).reverse().find(id => items.some(item => item.id === id)));
  return next ? `${focusRow ? "thread" : action}:${next}` : null;
}

function reconcileRows() {
  const completed = [];
  for (const [id, operation] of marking) {
    const batch = state.batches.find(batch => operation.token ? batch.token === operation.token :
      batch.scope === "thread" && batch.threadId === id && batch.action === operation.action && !operation.knownTokens.has(batch.token));
    if (batch) {
      operation.token = batch.token;
      operation.error = "";
      if (batchRunning(batch)) continue;
    } else if (!operation.token) {
      if (!operation.error || state.snapshotVersion <= operation.recoveryVersion) continue;
      actionError = operation.error;
    }
    marking.delete(id);
    operation.completed = true;
    completed.push(operation);
  }
  return completed;
}

function visible() {
  return hasCapability && !stopped && !document.hidden && intersecting;
}

function batchLocked() {
  return (state?.batches ?? []).some(batchRunning);
}

function batchRunning(batch) {
  return batch.status === "running";
}

function groupForBatch(batch) {
  if (batch.scope === "thread") return;
  if (batch.scope === "date") {
    return [...groupViews.values()].find(view => view.date === batch.date && view.timeZone === batch.timeZone);
  }
  return groupViews.get(batch.scope === "repository" ? `repo:${batch.repository}` : "shown");
}

function batchProgress(batch) {
  return `${batch.inFlight ? "Marking" : "Queued"} ${batch.succeeded}/${batch.total} as ${batch.action}...`;
}

function groupFocus(origin) {
  const entry = [...groupViews].find(([, view]) => view.readKey === origin || view.doneKey === origin);
  return entry ? focusKey(entry[0]) : undefined;
}

function lockedThreads() {
  return new Set([
    ...(state?.lockedThreadIds ?? []), ...marking.keys(),
    ...[...batchRequests.values()].flatMap(request => request.ids),
  ]);
}

function acceptState(snapshot) {
  // Concurrent action responses can arrive after a newer view has already rendered.
  if (!state || snapshot.snapshotVersion >= state.snapshotVersion) state = snapshot;
}

function requestsPaused() {
  return (state?.retryAt ?? 0) > Date.now();
}

function focusKey(key) {
  return [...document.querySelectorAll("[data-focus-key]")]
    .find(node => node.dataset.focusKey === key);
}

function visibleRowLinks() {
  return [...rowViews.values()].map(view => view.link).filter(link => !link.closest(".repo-items")?.hidden);
}

function focusSearchResult() {
  if (!searchFocusRequested || busy || pollPromise ||
      pendingFilters || searchComposing || !state || ["idle", "loading"].includes(state.status)) return;
  searchFocusRequested = false;
  if (!visible() || !document.hasFocus() || document.activeElement !== $("search") ||
      $("search").disabled || $("search").value !== state.filters.query) return;
  const link = visibleRowLinks()[0];
  if (!link) return;
  suppressHover();
  link.focus({ preventScroll: true });
  link.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function openShortcuts() {
  if ($("shortcuts-dialog").open) return;
  shortcutReturnFocus = document.activeElement;
  closeSettings();
  dismissTooltips();
  $("shortcuts-dialog").showModal();
}

function handleShortcut(event) {
  if (!visible() || !document.hasFocus() || !preferences?.keyboardShortcuts || event.defaultPrevented ||
      event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey ||
      $("settings").open || $("shortcuts-dialog").open || $("copilot-dialog").open ||
      event.target?.closest("input, textarea, select, [contenteditable], [role=textbox]")) return;
  if (event.key === "?") {
    event.preventDefault();
    if (!event.repeat) openShortcuts();
    return;
  }
  if (event.key === "/") {
    if (!$("search").disabled) {
      event.preventDefault();
      $("search").focus();
    }
    return;
  }
  const links = visibleRowLinks();
  const index = links.findIndex(link => link.dataset.threadId === document.activeElement?.dataset.threadId);
  if (!event.shiftKey && ["j", "k"].includes(event.key)) {
    if (!links.length) return;
    event.preventDefault();
    const next = index < 0 ? (event.key === "j" ? 0 : links.length - 1) :
      Math.max(0, Math.min(links.length - 1, index + (event.key === "j" ? 1 : -1)));
    suppressHover();
    links[next].focus({ preventScroll: true });
    links[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const action = event.key === "i" && !event.shiftKey ? "read" : event.key === "E" && event.shiftKey ? "done" : null;
  if (!action || index < 0) return;
  event.preventDefault();
  if (event.repeat) return;
  const id = links[index].dataset.threadId;
  const button = focusKey(`${action}:${id}`);
  if (button && !button.disabled) return markThread(id, action, true);
}

function restoreFocus(previous, preferred) {
  if (!visible() || !document.hasFocus() || !previous || (!previous.id && !previous.dataset?.focusKey)) return;
  const current = document.activeElement;
  const key = previous.dataset?.focusKey;
  if (current && current !== previous && current !== document.body && current !== document.documentElement &&
      !(key && current.dataset?.focusKey === key)) return;
  let target = preferred ?? (key ? focusKey(key) : $(previous.id));
  if ((!target || target.dataset.alreadyRead === "true") && key?.startsWith("read:")) target = focusKey(`done:${key.slice(5)}`);
  for (let node = target; node; node = node.parentNode) {
    if (node.hidden) {
      target = null;
      break;
    }
  }
  const previousTooltip = tooltipAnchorsByControl.get(previous);
  const keyboardTooltip = previousTooltip?.dataset.tooltipKeyboard === "true";
  const dismissedTooltip = previousTooltip?.dataset.tooltipDismissed === "true";
  const destination = target && !target.disabled ? target : $("search");
  destination.focus({ preventScroll: true });
  if (previousTooltip) {
    setTooltipKeyboard(destination, keyboardTooltip);
    const anchor = tooltipAnchorsByControl.get(destination);
    if (anchor && dismissedTooltip) anchor.dataset.tooltipDismissed = "true";
  }
}

async function batchRequest(action, input, ids = [], returnFocusKey) {
  const requestKey = input.token ?? returnFocusKey;
  if (!visible() || busy || batchRequests.has(requestKey)) return;
  const retryBatch = action === "retry" ? state.batches.find(batch => batch.token === input.token) : undefined;
  if (action === "retry") ids = retryBatch?.retryableThreadIds ?? [];
  const locked = lockedThreads();
  if (["start", "retry"].includes(action) && (pendingFilters || ids.some(id => locked.has(id)))) return;
  batchRequests.set(requestKey, { ids, action: action === "start" ? input.action ?? "read" : retryBatch?.action });
  batchBusy++;
  let failed = false;
  const previousFocus = document.activeElement;
  const origin = returnFocusKey ?? batchFocusKeys.get(input.token);
  dismissTooltips();
  renderControls();
  renderBatch();
  try {
    await pollPromise;
    if (!visible()) return;
    const snapshot = await api(`batch/${action}`, input);
    if (["start", "retry"].includes(action)) {
      const operationToken = snapshot.batch?.token;
      if (operationToken) batchFocusKeys.set(operationToken, origin);
    }
    acceptState(snapshot);
    actionError = "";
    if (["start", "retry"].includes(action) && batchLocked()) await update();
  } catch (error) {
    failed = true;
    actionError = error.message || "The notification action failed. Try again.";
    try {
      acceptState(await api("state"));
    } catch {
      actionError += " Could not reconnect. Reopen this panel to inspect its current progress.";
    }
  } finally {
    batchRequests.delete(requestKey);
    batchBusy--;
    render();
    if (visible() && !failed) {
      const target = focusKey(origin);
      restoreFocus(previousFocus, target && target.dataset.count !== "0" ? target : groupFocus(origin) ?? $("search"));
    } else {
      restoreFocus(previousFocus, action === "start" ? focusKey(origin) : undefined);
    }
    void flushPendingUpdates();
    schedule();
  }
}

function createBatchView(primary) {
  if (primary && primaryBatchView) return primaryBatchView;
  const view = {};
  for (const [part, tag] of [
    ["progress", "section"], ["title", "h2"], ["counts", "p"], ["error", "p"],
    ["buttons", "div"], ["retry", "button"], ["dismiss", "button"],
  ]) {
    view[part] = primary ? $(`batch-${part}`) : element(tag, `batch-${part}`);
  }
  view.primary = primary;
  view.progress.tabIndex = -1;
  view.error.setAttribute("role", "alert");
  if (!primary) {
    view.buttons.append(view.retry, view.dismiss);
    view.progress.append(view.title, view.counts, view.error, view.buttons);
    $("additional-batches").append(view.progress);
  }
  for (const [part, action, text] of [
    ["retry", "retry", "Retry remaining"],
    ["dismiss", "dismiss", "Dismiss result"],
  ]) {
    view[part].type = "button";
    view[part].dataset.batchControl = action;
    setControlText(view[part], text);
    view[part].addEventListener("click", () => batchRequest(action, { token: view.token }));
  }
  if (primary) primaryBatchView = view;
  return view;
}

function renderBatch() {
  if (!primaryBatchView) $("batch-progress").hidden = true;
  const previousFocus = document.activeElement;
  const batches = state?.batches ?? [];
  const results = batches.filter(batch => batch.scope !== "thread" && !batchRunning(batch));
  for (const [token, view] of batchViews) {
    if (results.some(batch => batch.token === token)) continue;
    const hadFocus = view.progress.contains(previousFocus);
    view.progress.hidden = true;
    for (const part of ["title", "counts", "error"]) view[part].textContent = "";
    if (!view.primary) view.progress.remove();
    batchViews.delete(token);
    if (hadFocus) restoreFocus(previousFocus, groupFocus(batchFocusKeys.get(token)) ?? $("search"));
    batchFocusKeys.delete(token);
  }
  for (const batch of results) {
    let view = batchViews.get(batch.token);
    if (!view) {
      view = createBatchView(![...batchViews.values()].some(view => view.primary));
      view.token = batch.token;
      for (const part of ["progress", "retry", "dismiss"]) {
        view[part].dataset.focusKey = `batch:${batch.token}:${part}`;
      }
      batchViews.set(batch.token, view);
    }
    const parent = groupForBatch(batch)?.results ?? $("additional-batches");
    if (view.progress.parentNode !== parent) parent.append(view.progress);
    renderBatchView(batch, view);
  }
  for (const token of batchFocusKeys.keys()) {
    if (!batches.some(batch => batch.token === token)) batchFocusKeys.delete(token);
  }
}

function renderBatchView(batch, view) {
  const previousFocus = document.activeElement;
  const controls = [view.retry, view.dismiss];
  const remaining = batch.failed + batch.notAttempted;
  view.progress.hidden = false;
  view.progress.className = "batch-progress";
  const target = batch.scope === "shown" ? "Shown notifications" : batch.scope === "date" ? dateLabel(batch.date) : batch.repository;
  view.progress.setAttribute("aria-label", `Notification operation: ${target}`);
  view.title.textContent = `${target}: Some notifications remain to mark as ${batch.action}`;
  view.counts.hidden = false;
  view.counts.textContent = `${batch.succeeded} succeeded / ${batch.failed} failed / ${batch.skipped} skipped / ${batch.notAttempted} not attempted (${batch.total} selected)`;
  const retryTime = batch.retryAt > Date.now() ? ` Retry after ${new Date(batch.retryAt).toLocaleTimeString()}.` : "";
  const detail = batch.error?.message ?? (batch.skipped ? "Skipped notifications changed or are no longer eligible in the loaded inbox. Review their current state separately." : "");
  view.error.hidden = !detail;
  view.error.textContent = detail + retryTime;
  const pending = batchRequests.has(batch.token);
  view.buttons.hidden = false;
  view.retry.hidden = remaining === 0;
  setControlText(view.retry, `Retry remaining (${remaining})`);
  const locked = lockedThreads();
  view.retry.disabled = pending || busy || Boolean(pendingFilters) || batch.retryAt > Date.now() ||
    batch.retryableThreadIds.some(id => locked.has(id));
  view.dismiss.hidden = false;
  view.dismiss.disabled = pending || busy;
  if (controls.includes(previousFocus) && previousFocus.hidden) restoreFocus(previousFocus, view.progress);
}

function schedule() {
  clearTimeout(timer);
  if (visible()) timer = setTimeout(tick, batchBusy || marking.size || batchLocked() || copilotWorking() ||
    state?.subjectsLoading && !connectionError ? 1000 : 5000);
}

async function performUpdate(path, input) {
  renderControls();
  try {
    acceptState(await api(path, input));
    connectionError = "";
    if (path === "refresh") actionError = "";
    return true;
  } catch (error) {
    if (!visible() && error.name === "AbortError") return false;
    connectionError = error.name === "AbortError"
      ? "The canvas request timed out. This view retries automatically while visible; reopen it if it stays disconnected."
      : error.message || "The local canvas disconnected. Reopen it to reconnect.";
    if (path !== "state" && visible()) {
      try {
        acceptState(await api("state"));
      } catch {
        connectionError = "The local canvas disconnected. Reopen it to reconnect.";
      }
    }
    return false;
  }
}

function update(path = "state", input) {
  if (path === "filters") {
    pendingFilters = { ...pendingFilters, ...input };
    return flushPendingUpdates();
  }
  if (path !== "state") return blockingUpdate(path, input);
  if (pollPromise) return pollPromise;
  if (busy || !visible()) return Promise.resolve();
  pollPromise = performUpdate(path, input).finally(() => {
    pollPromise = undefined;
    render();
    void flushPendingUpdates();
    schedule();
  });
  return pollPromise;
}

async function blockingUpdate(path, input) {
  if (busy || !visible() || (path !== "filters" && (batchBusy || marking.size || batchLocked()))) return;
  const previousFocus = document.activeElement;
  let succeeded = false;
  busy = true;
  refreshing = path === "refresh";
  inFlightAttention = path === "filters" ? input.attention : undefined;
  renderControls();
  try {
    await pollPromise;
    if (path === "filters" && searchComposing) return;
    if (path === "filters" && pendingFilters) {
      input = { ...input, ...pendingFilters };
      inFlightAttention = input.attention;
      pendingFilters = undefined;
      clearTimeout(searchTimer);
    }
    if (visible()) succeeded = await performUpdate(path, input);
  } finally {
    busy = false;
    refreshing = false;
    inFlightAttention = undefined;
    if (!succeeded && path === "filters") {
      pendingFilters = { ...input, ...pendingFilters };
      searchFocusRequested = false;
    }
    render();
    restoreFocus(previousFocus);
    if (succeeded || path !== "filters" || refreshEligible()) void flushPendingUpdates();
    schedule();
  }
}

async function flushPendingUpdates() {
  if (busy || !visible()) return;
  if (refreshEligible()) {
    pendingRefresh = false;
    return blockingUpdate("refresh", { force: true });
  }
  if (searchComposing) return;
  if (!pendingFilters) return focusSearchResult();
  const input = pendingFilters;
  pendingFilters = undefined;
  clearTimeout(searchTimer);
  if (Object.entries(input).some(([key, value]) => value !== state?.filters[key])) {
    await blockingUpdate("filters", input);
  } else {
    renderControls();
    focusSearchResult();
  }
}

function refreshEligible() {
  return pendingRefresh && !requestsPaused() && !batchBusy && !marking.size && !batchLocked();
}

async function tick() {
  if (!visible() || busy) return;
  if ($("settings").open) void settingsRequest(undefined, true);
  if (marking.size || batchLocked() || batchBusy) return update();
  if (pendingRefresh && !requestsPaused()) return flushPendingUpdates();
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderRefreshStatus(updateAge = false) {
  const fetchedAt = state?.lastFetchedAt ?? null;
  const paused = requestsPaused();
  const progress = pendingRefresh ? "Refresh queued. " : refreshing ? "Refreshing. " : "";
  const pause = paused ? `GitHub requests paused. Retry after ${new Date(state.retryAt).toLocaleTimeString()}.` : "";
  $("retry-status").hidden = !paused;
  if ($("retry-status").textContent !== pause) $("retry-status").textContent = pause;
  for (const id of ["force-refresh", "empty-refresh"]) {
    $(id).setAttribute("aria-disabled", String(paused));
    $(id).setAttribute("aria-busy", String(!paused && (pendingRefresh || refreshing)));
  }
  const key = `${fetchedAt}:${progress}:${pause}`;
  if (!updateAge && key === refreshStatusKey) return;
  refreshStatusKey = key;
  const seconds = fetchedAt === null ? null : Math.floor(Math.max(0, Date.now() - fetchedAt) / 1000);
  const updated = seconds === null ? "Not updated yet" : `Last updated ${seconds} second${seconds === 1 ? "" : "s"} ago`;
  $("refresh-tooltip-text").textContent = (paused ? `${pause} ` : progress) + updated;
}

function positionTooltip(anchor) {
  const tooltip = anchor.querySelectorAll(".tooltip")[0];
  anchor.dataset.tooltipPlacement = anchor.getBoundingClientRect().top < tooltip.getBoundingClientRect().height + 8
    ? "below" : "above";
}

function tooltipAnchors() {
  return [...tooltipControls.map(([, id]) => $(id)), ...$("groups").querySelectorAll(".tooltip-anchor")];
}

function positionOverlays() {
  positionSettings();
  for (const anchor of tooltipAnchors()) {
    if (!anchor.dataset.tooltipDismissed && (anchor.dataset.tooltipKeyboard === "true" && anchor.contains(document.activeElement) || anchor.matches(":hover"))) {
      positionTooltip(anchor);
    }
  }
}

function bindTooltip(control, anchor) {
  tooltipAnchorsByControl.set(control, anchor);
  const show = () => {
    delete anchor.dataset.tooltipDismissed;
    if (anchor.id === "refresh-control") renderRefreshStatus(true);
    positionTooltip(anchor);
  };
  control.addEventListener("pointerenter", show);
  anchor.addEventListener("pointerenter", show);
  control.addEventListener("focus", () => {
    setTooltipKeyboard(control, !pointerInteraction && control.matches(":focus-visible"));
    show();
  });
  control.addEventListener("keydown", event => {
    if (event.key === "Escape") return;
    setTooltipKeyboard(control, true);
    show();
  });
}

function setTooltipKeyboard(control, keyboard) {
  const anchor = tooltipAnchorsByControl.get(control);
  if (anchor) anchor.dataset.tooltipKeyboard = String(keyboard);
}

function dismissTooltips() {
  for (const anchor of tooltipAnchors()) anchor.dataset.tooltipDismissed = "true";
}

function suppressHover() {
  document.documentElement.dataset.pointerHoverSuppressed = "true";
  dismissTooltips();
}

function tickTooltip() {
  clearTimeout(tooltipTimer);
  if (!visible()) return;
  renderRefreshStatus(true);
  for (const icon of $("groups").querySelectorAll(".subject-icon")) updateSubjectDescription(icon);
  tooltipTimer = setTimeout(tickTooltip, 15_000);
}

function renderControls() {
  const loading = busy || state?.status === "loading" || marking.size > 0 || batchBusy || batchLocked();
  const actionsBlocked = busy || state?.status === "loading" || Boolean(pendingFilters);
  const locked = lockedThreads();
  const waiting = state && Date.now() < state.nextRefreshAt;
  const pendingRows = new Map();
  for (const { ids, action } of batchRequests.values()) {
    for (const id of ids) pendingRows.set(id, action);
  }
  for (const batch of state?.batches ?? []) {
    if (batchRunning(batch)) {
      for (const id of batch.remainingThreadIds) pendingRows.set(id, batch.action);
    }
  }
  renderRefreshStatus();
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const [key, view] of groupViews) {
    const batches = (state?.batches ?? []).filter(batch => batchRunning(batch) && groupForBatch(batch) === view);
    const starting = [...batchRequests.keys()].filter(request => request === view.readKey || request === view.doneKey);
    const progress = batches.map(batchProgress);
    if (!batches.length && starting.length) {
      progress.push(`Queued to mark as ${starting[0] === view.readKey ? "read" : "done"}...`);
    }
    view.status.hidden = !progress.length;
    setControlText(view.status, progress.join(" "));
    view.status.dataset.groupKey = key;
  }
  for (const button of $("groups").querySelectorAll("button")) {
    if (button.dataset.copilot) continue;
    const alreadyRead = button.dataset.alreadyRead === "true";
    if (!button.dataset.disclosure && !button.dataset.batchControl) {
      const blocked = actionsBlocked || locked.has(button.dataset.threadId) ||
      (batchControlItems.get(button) ?? []).some(id => locked.has(id)) ||
      button.dataset.count === "0" || alreadyRead;
      if (button.dataset.batchAction) {
        button.disabled = false;
        button.setAttribute("aria-disabled", String(blocked));
      } else {
        button.disabled = blocked;
      }
    }
    if (button.dataset.threadId) {
      const write = state?.threadWrites.find(write => write.id === button.dataset.threadId && write.action === button.dataset.action);
      const pending = !alreadyRead && (write || marking.get(button.dataset.threadId)?.action === button.dataset.action ||
        pendingRows.get(button.dataset.threadId) === button.dataset.action);
      button.setAttribute("aria-busy", String(Boolean(pending)));
      button.dataset.writeState = pending ? write?.inFlight ? "active" : "queued" : "idle";
      const label = alreadyRead ? "Already read" : `${pending ? write?.inFlight ? "Marking" : "Queued to mark" : "Mark"} as ${button.dataset.action}`;
      button.parentNode.querySelectorAll(".tooltip-content")[0].textContent = label;
    }
    if (button.dataset.batchAction) {
      const batch = state?.batches.find(batch => batchRunning(batch) && batch.action === button.dataset.batchAction && batch.scope === button.dataset.batchScope &&
        (batch.scope === "date"
          ? batch.date === button.dataset.batchDate && batch.timeZone === button.dataset.batchTimeZone
          : batch.scope === "shown" || batch.repository === button.dataset.repository));
      const starting = batchRequests.has(button.dataset.focusKey);
      const progress = batch ? batchProgress(batch) : starting ? `Queued to mark as ${button.dataset.batchAction}...` : null;
      const destination = button.dataset.batchDate ? ` on ${dateLabel(button.dataset.batchDate)}` :
        button.dataset.repository ? ` in ${button.dataset.repository}` : "";
      const label = `Mark ${button.dataset.count} as ${button.dataset.batchAction}`;
      button.parentNode.querySelectorAll(".tooltip-content")[0].textContent = progress ?? label;
      button.setAttribute("aria-label", progress ? `${progress}${destination}` :
        `${label}${destination}; ${button.dataset.count} shown, loaded notifications`);
      button.setAttribute("aria-busy", String(Boolean(batch || starting)));
      button.dataset.writeState = batch?.inFlight ? "active" : batch || starting ? "queued" : "idle";
    }
  }
  $("search").disabled = false;
  for (const tab of attentionTabs.values()) tab.disabled = !hasCapability;
  for (const batch of state?.batches ?? []) {
    const view = batchViews.get(batch.token);
    if (view) renderBatchView(batch, view);
  }
  $("groups").setAttribute("aria-busy", String(busy || state?.status === "loading"));
  renderNotificationView();
  $("shortcuts-control").hidden = preferences?.keyboardShortcuts === false;
  for (const [control, keys] of [
    [$("groups"), "j k"], [$("search"), "/"], [$("shortcuts-toggle"), "?"],
    ...[...$("groups").querySelectorAll("button")].filter(button => button.dataset.action)
      .map(button => [button, button.dataset.action === "read" ? "i" : "Shift+e"]),
  ]) {
    if (preferences?.keyboardShortcuts && control.dataset.alreadyRead !== "true") control.setAttribute("aria-keyshortcuts", keys);
    else control.removeAttribute("aria-keyshortcuts");
  }
}

function displayGroups() {
  const groups = state?.groups ?? [];
  const groupBy = preferences?.groupBy ?? "repo";
  if (groupBy === "repo") {
    return groups.map(group => ({ ...group, key: `repo:${group.repository}`, label: group.repository }));
  }
  const items = groups.flatMap(group => group.items).sort((a, b) => a.apiPosition - b.apiPosition);
  if (groupBy === "none") return items.length ? [{
    key: "shown", label: "All notifications", unread: items.filter(item => item.unread).length, items, selectionKey: state.selectionKey,
  }] : [];
  return groupThreadsByDate(items, Intl.DateTimeFormat().resolvedOptions().timeZone)
    .map(group => ({ ...group, selectionKey: state.selectionKey }));
}

function createBatchControls({ repository, date, timeZone, selectionKey, items, count, unread, tooltipPrefix }) {
  const scope = date ? "date" : repository ? "repository" : "shown";
  const key = repository ?? (date ? `date:${date}` : "shown");
  const name = repository ?? (date ? dateLabel(date) : "shown notifications");
  const destination = date ? ` on ${name}` : repository ? ` in ${repository}` : "";
  const target = date ? { scope: "date", date, timeZone } : repository ? { repository } : { scope: "shown" };
  const ids = items.map(item => item.id);
  const locked = lockedThreads();
  const controls = element("div", "repo-actions");
  const read = element("button", "icon-button repo-read");
  const done = element("button", "icon-button repo-done");
  read.dataset.focusKey = `bulk:${key}`;
  done.dataset.focusKey = `bulk-done:${key}`;
  for (const [button, action] of [[read, "read"], [done, "done"]]) {
    batchControlItems.set(button, ids);
    const selected = action === "read" ? unread : count;
    const anchor = element("div", "tooltip-anchor");
    const tooltip = element("span", "tooltip");
    tooltip.id = `${tooltipPrefix}-${action}-tooltip`;
    tooltip.setAttribute("role", "tooltip");
    tooltip.append(element("span", "tooltip-content", `Mark ${selected} as ${action}`));
    button.type = "button";
    if (repository) button.dataset.repository = repository;
    if (date) {
      button.dataset.batchDate = date;
      button.dataset.batchTimeZone = timeZone;
    }
    button.dataset.count = String(selected);
    button.dataset.batchScope = scope;
    button.dataset.batchAction = action;
    button.setAttribute("aria-label", `Mark ${selected} as ${action}${destination}; ${selected} shown, loaded notifications`);
    button.setAttribute("aria-describedby", tooltip.id);
    button.setAttribute("aria-disabled", String(!selected || busy || ids.some(id => locked.has(id)) || Boolean(pendingFilters)));
    button.append(actionIcon(action));
    bindTooltip(button, anchor);
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      // WebKit pointer clicks can blur the button before this handler.
      button.focus();
      return batchRequest("start", { ...target, selectionKey, action }, ids, button.dataset.focusKey);
    });
    anchor.append(button, tooltip);
    controls.append(anchor);
  }
  return controls;
}

function renderRowSubject(view, item) {
  const copilot = copilotEnabled() ? item.copilot : null;
  const working = copilotWorking();
  const key = JSON.stringify([item, Boolean(copilot), working, copilotOperation?.id]);
  if (key === view.key) return;
  view.key = key;
  const loading = item.subjectLinkLoading === true;
  if (loading) {
    view.link.removeAttribute("href");
    view.link.setAttribute("role", "link");
    view.link.setAttribute("aria-disabled", "true");
    view.link.setAttribute("aria-busy", "true");
  } else {
    view.link.href = item.url;
    for (const attribute of ["role", "aria-disabled", "aria-busy"]) view.link.removeAttribute(attribute);
  }
  view.destination.hidden = loading || item.direct && item.subjectLinkSource !== "inferred" && item.subjectLinkTarget !== "job";
  view.destination.textContent = view.destination.hidden ? "" : item.label;
  view.subject = subjectMetadata(item, view.subject);
  if (view.copilot) {
    if (copilot && !view.copilot.button) {
      const { anchor } = view.copilot;
      const button = element("button", "icon-button copilot-action");
      const tooltip = element("span", "tooltip");
      const tooltipContent = element("span", "tooltip-content");
      tooltip.id = `row-copilot-${item.id}-tooltip`;
      tooltip.setAttribute("role", "tooltip");
      tooltip.append(tooltipContent);
      button.type = "button";
      button.dataset.focusKey = `copilot:${item.id}`;
      button.dataset.threadId = item.id;
      button.dataset.copilot = "true";
      button.setAttribute("aria-describedby", tooltip.id);
      button.append(actionIcon("copilot"));
      bindTooltip(button, anchor);
      button.addEventListener("click", () => {
        if (!button.disabled) openCopilot(item.id, button);
      });
      anchor.append(button, tooltip);
      view.copilot.button = button;
      view.copilot.tooltip = tooltipContent;
    }
    const wasFocused = view.copilot.button === document.activeElement;
    view.copilot.anchor.hidden = !copilot;
    if (!view.copilot.button) return;
    const pending = working && copilotOperation?.id === item.id;
    view.copilot.button.disabled = !copilot?.enabled || working;
    view.copilot.button.setAttribute("aria-busy", String(pending));
    view.copilot.button.setAttribute("aria-label", `${item.copilot?.label ?? "Work with Copilot"}: ${notificationTitle(item, "Untitled notification")}`);
    setControlText(view.copilot.tooltip, pending ? "Opening Copilot..." :
      item.copilot?.reason || item.copilot?.label || "Work with Copilot");
    if (!copilot && wasFocused) restoreFocus(view.copilot.button, view.link);
  }
}

function copilotEnabled() {
  return state?.copilotIntegration ?? preferences?.copilotIntegration ?? true;
}

function copilotConfirmations() {
  return state?.confirmCopilotActions ?? preferences?.confirmCopilotActions ?? true;
}

function copilotWorking() {
  return copilotRequestPending || ["preparing", "starting"].includes(copilotOperation?.status);
}

function copilotRememberInput() {
  return skipCopilotConfirmation ? { skipConfirmation: true } : {};
}

function renderCopilot() {
  const operation = !copilotEnabled() && copilotOperation?.status === "ready"
    ? { id: copilotOperation.id, status: "error", message: "Copilot integration is off. Enable it in Settings to start a handoff." }
    : copilotOperation;
  const dialog = $("copilot-dialog");
  const working = copilotWorking();
  if (copilotAwaitingResult && ["ready", "error"].includes(operation?.status) && !dialog.open && visible()) {
    dialog.showModal();
    $("copilot-close").focus();
  }
  if (["started", "opened"].includes(operation?.status)) {
    copilotAwaitingResult = false;
    if (!copilotConfirmations() && dialog.open) dialog.close();
  }
  $("copilot-feedback").hidden = !working || dialog.open;
  $("copilot-feedback").textContent = working ? "Opening Copilot..." : "";
  if (!dialog.open || !operation) return;
  if (["ready", "error"].includes(operation.status)) copilotAwaitingResult = false;
  const actionFocused = document.activeElement === $("copilot-start") ||
    document.activeElement === $("copilot-skip-confirmation") || $("copilot-sessions").contains(document.activeElement);
  $("copilot-title").textContent = operation.label ?? "Work with Copilot";
  const inferred = operation.inferred
    ? "This run was matched from notification metadata, not linked by GitHub. Confirm the run and attempt below. " : "";
  $("copilot-status").textContent = operation.message ?? inferred + (operation.status === "preparing" ? "Checking the selected item and available sessions..." :
    operation.status === "starting" ? "Opening Copilot. Check the app for any permission or repository trust requests." :
      operation.sessions?.length ? "A matching session already exists. Opening it will not send instructions or interrupt its work." :
        "Copilot will summarize this item first, then investigate read-only. Implementation and GitHub changes require your approval.");
  $("copilot-status").setAttribute("role", operation.status === "error" ? "alert" : "status");
  $("copilot-reference").textContent = operation.url ?? "";
  $("copilot-reference").hidden = !operation.url;
  $("copilot-clone").hidden = !operation.needsClone || Boolean(operation.sessions?.length);
  $("copilot-clone").textContent = operation.canClone
    ? `This repository is not configured in Copilot. Continuing will clone ${operation.repository} to this computer and may use significant disk space.`
    : "Add this repository in Copilot first, then reopen this action.";
  const key = JSON.stringify([operation.status, operation.token, operation.sessions]);
  if (key !== copilotDialogKey) {
    copilotDialogKey = key;
    skipCopilotConfirmation = false;
    $("copilot-skip-confirmation").setAttribute("aria-checked", "false");
    const buttons = document.createDocumentFragment();
    if (operation.status === "ready") {
      for (const session of operation.sessions) {
        const button = element("button", "", `Open existing session: ${session.name}`);
        button.type = "button";
        button.addEventListener("click", () => requestCopilot({
          id: operation.id, token: operation.token, sessionId: session.id,
          ...copilotRememberInput(),
        }));
        buttons.append(button);
      }
    }
    $("copilot-sessions").replaceChildren(buttons);
  }
  for (const button of $("copilot-sessions").querySelectorAll("button")) button.disabled = working;
  $("copilot-remember").hidden = operation.status !== "ready" || !operation.canRemember || !operation.confirmCopilotActions;
  $("copilot-skip-confirmation").disabled = working;
  const start = $("copilot-start");
  start.hidden = operation.status !== "ready" || Boolean(operation.sessions?.length) || operation.needsClone && !operation.canClone;
  start.disabled = working;
  setControlText(start, operation.needsClone ? "Clone repository and start" : "Start session");
  setControlText($("copilot-close"), working ? "Close" : operation.status === "ready" ? "Cancel" : "Close");
  if (actionFocused && working) $("copilot-close").focus({ preventScroll: true });
}

async function requestCopilot(input) {
  if (copilotRequestPending || !copilotEnabled()) return;
  const previous = copilotOperation;
  copilotAwaitingResult = true;
  copilotRequestPending = true;
  copilotOperation = { id: input.id, status: input.token ? "starting" : "preparing" };
  render();
  try {
    copilotOperation = await api("copilot", input);
    if (state) state.copilotOperation = copilotOperation;
    await pollPromise;
    void update();
  } catch (error) {
    copilotOperation = { id: input.id, status: "error", message: `${error.message || "The Copilot request failed."} Check Copilot before retrying; a session may already have been created.` };
    if (state) state.copilotOperation = copilotOperation;
  } finally {
    copilotRequestPending = false;
    if (previous?.id !== input.id) copilotDialogKey = undefined;
    render();
    schedule();
  }
}

function openCopilot(id, button) {
  button.focus({ preventScroll: true });
  copilotReturnFocus = button.dataset.focusKey;
  closeSettings();
  dismissTooltips();
  const direct = !copilotConfirmations();
  if (!direct) {
    $("copilot-dialog").showModal();
    $("copilot-close").focus();
  }
  if (["preparing", "starting"].includes(state?.copilotOperation?.status)) {
    copilotOperation = state.copilotOperation;
    renderCopilot();
    return;
  }
  void requestCopilot({ id, ...(direct ? { direct: true } : {}) });
}

function renderGroups(groups, fallbackFocusKey, completedRows = []) {
  const locked = lockedThreads();
  $("collapse").hidden = !groups.length;
  setControlText($("collapse"), groups.some(group => !collapsed.has(group.key)) ? "Collapse all" : "Expand all");
  // Subject hydration must not replace links or buttons during a pointer press.
  const key = JSON.stringify(groups.map(group => ({
    ...group, items: group.items.map(item => [
      item.id, item.repository, item.title, item.type, item.number, item.reason,
      item.unread, item.updatedAt, item.apiPosition,
    ]),
  })));
  if (key === listKey) {
    for (const group of groups) {
      for (const item of group.items) renderRowSubject(rowViews.get(item.id), item);
    }
    return;
  }
  listKey = key;
  rowViews.clear();
  groupViews.clear();
  const previousFocus = document.activeElement;
  const focused = previousFocus?.dataset.focusKey;
  const dismissedTooltips = new Set([...$("groups").querySelectorAll("[data-focus-key]")]
    .filter(control => tooltipAnchorsByControl.get(control)?.dataset.tooltipDismissed === "true")
    .map(control => control.dataset.focusKey));
  const fragment = document.createDocumentFragment();
  for (const [index, group] of groups.entries()) {
    const rows = element("div", "repo-items");
    const section = element("section", "repo-group");
    const header = element("div", "repo-header");
    const status = element("p", "group-progress sr-only");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    const results = element("div", "group-results");
    const actionKey = group.repository ?? (group.date ? `date:${group.date}` : "shown");
    groupViews.set(group.key, {
      status, results, date: group.date, timeZone: group.timeZone,
      readKey: `bulk:${actionKey}`, doneKey: `bulk-done:${actionKey}`,
    });
    rows.id = `group-items-${index}`;
    rows.hidden = collapsed.has(group.key);
    const disclosure = element("button", "repo-toggle");
    disclosure.type = "button";
    disclosure.dataset.disclosure = "true";
    disclosure.dataset.focusKey = group.key;
    disclosure.setAttribute("aria-controls", rows.id);
    disclosure.setAttribute("aria-expanded", String(!rows.hidden));
    disclosure.append(element("span", "repo-name", group.label),
      element("span", "repo-count", `${group.items.length} total \u00b7 ${group.unread} unread`));
    disclosure.addEventListener("click", () => {
      rows.hidden = !rows.hidden;
      if (rows.hidden) collapsed.add(group.key);
      else collapsed.delete(group.key);
      disclosure.setAttribute("aria-expanded", String(!rows.hidden));
      setControlText($("collapse"), groups.some(item => !collapsed.has(item.key)) ? "Collapse all" : "Expand all");
      scheduleSubjectSelectionSync();
    });
    header.append(disclosure, createBatchControls({
      repository: group.repository, date: group.date, timeZone: group.timeZone,
      selectionKey: group.selectionKey, items: group.items, count: group.items.length, unread: group.unread, tooltipPrefix: `group-${index}`,
    }));
    header.append(status, results);
    section.append(header, rows);
    fragment.append(section);
    for (const item of group.items) {
      const row = element("article", `row ${item.unread ? "unread" : "read"}`);
      const dot = element("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      const content = element("div", "row-content");
      const title = element("span", "title", item.title || "(Untitled notification)");
      const link = element("a", "row-link");
      const view = { link, destination: element("span", "sr-only") };
      renderRowSubject(view, item);
      rowViews.set(item.id, view);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", event => {
        if (link.getAttribute("aria-disabled") === "true") return event.preventDefault();
        suppressHover();
      });
      link.addEventListener("auxclick", event => {
        if (event.button === 1) {
          if (link.getAttribute("aria-disabled") === "true") return event.preventDefault();
          suppressHover();
        }
      });
      // WebKit's default Tab navigation can skip links without an explicit tab stop.
      link.tabIndex = 0;
      link.dataset.focusKey = `thread:${item.id}`;
      link.dataset.threadId = item.id;
      content.append(title);
      content.append(element("span", "sr-only", item.unread ? "Unread" : "Read"));
      content.append(view.destination);
      const metadata = element("div", "metadata");
      const time = element("time", "", relativeTime(item.updatedAt));
      time.dateTime = item.updatedAt;
      time.title = new Date(item.updatedAt).toLocaleString();
      time.setAttribute("aria-label", time.title);
      const fields = [
        ...(group.repository ? [] : [element("span", "repository", item.repository)]),
        view.subject,
        element("span", "", item.reason.replaceAll("_", " ")),
        time,
      ];
      for (const [index, field] of fields.entries()) {
        const part = element("span", "metadata-item");
        part.append(field);
        if (index < fields.length - 1) {
          const separator = element("span", "metadata-separator", "\u00b7");
          separator.setAttribute("aria-hidden", "true");
          part.append(separator);
        }
        metadata.append(part);
      }
      content.append(metadata);
      const actions = element("div", "row-actions");
      if (Object.hasOwn(item, "copilot")) {
        const anchor = element("div", "tooltip-anchor");
        actions.append(anchor);
        view.copilot = { anchor };
        view.key = undefined;
        renderRowSubject(view, item);
      }
      for (const action of ["read", "done"]) {
        const alreadyRead = action === "read" && !item.unread;
        const label = alreadyRead ? "Already read" : `Mark as ${action}`;
        const anchor = element("div", "tooltip-anchor");
        const button = element("button", `icon-button mark-${action}`);
        const tooltip = element("span", "tooltip");
        tooltip.id = `row-${action}-${item.id}-tooltip`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.append(element("span", "tooltip-content", label));
        button.type = "button";
        button.dataset.focusKey = `${action}:${item.id}`;
        button.dataset.threadId = item.id;
        button.dataset.action = action;
        if (alreadyRead) button.dataset.alreadyRead = "true";
        button.disabled = alreadyRead || busy || locked.has(item.id) || Boolean(pendingFilters);
        button.setAttribute("aria-label", `${label}: ${notificationTitle(item, "Untitled notification")}`);
        button.setAttribute("aria-describedby", tooltip.id);
        button.setAttribute("aria-busy", String(!alreadyRead && marking.get(item.id)?.action === action));
        button.append(actionIcon(action));
        bindTooltip(button, anchor);
        button.addEventListener("click", () => {
          if (!button.disabled) return markThread(item.id, action);
        });
        anchor.append(button, tooltip);
        actions.append(anchor);
      }
      link.append(dot, content);
      row.append(link, actions);
      rows.append(row);
    }
  }
  $("groups").replaceChildren(fragment);
  renderBatch();
  for (const control of $("groups").querySelectorAll("[data-focus-key]")) {
    const anchor = tooltipAnchorsByControl.get(control);
    if (anchor && dismissedTooltips.has(control.dataset.focusKey)) anchor.dataset.tooltipDismissed = "true";
  }
  if (focused) {
    const pending = [...marking.values(), ...completedRows].find(operation =>
      operation.key === focused || operation.previousFocus?.dataset.focusKey === focused);
    let target = focusKey(pending ? rowFocusKey(pending) : focused) ?? focusKey(fallbackFocusKey);
    if (target?.dataset.count === "0") target = groupFocus(focused);
    // Pending actions restore focus once their replacement controls are enabled.
    if (!target?.disabled || target.dataset.alreadyRead === "true") restoreFocus(previousFocus, target);
  }
}

function render(fallbackFocusKey) {
  document.documentElement.dataset.copilotIntegration = String(copilotEnabled());
  if (!copilotRequestPending && state?.copilotOperation) copilotOperation = state.copilotOperation;
  renderCopilot();
  const completedRows = state ? reconcileRows() : [];
  renderSettingsError();
  renderUpdates(state?.updates);
  const development = state?.development;
  $("development-build").hidden = !development;
  $("development-build").textContent = development ? `dev (v${development.version}) ${development.branch}` : "";
  const activeAPI = state || preferences ? apiTarget(state?.developmentApiBaseUrl ?? preferences?.developmentApi?.baseUrl) : null;
  const inboxLink = $("open-inbox");
  if (activeAPI) inboxLink.href = `${activeAPI.webOrigin}/notifications`;
  else inboxLink.removeAttribute("href");
  inboxLink.setAttribute("aria-disabled", String(!activeAPI));
  inboxLink.tabIndex = activeAPI ? 0 : -1;
  $("development-api-notice").hidden = !activeAPI?.custom;
  $("development-api-notice").textContent = activeAPI?.custom
    ? `Development API: ${activeAPI.baseUrl}. Read/done actions affect this API, which may share production data. Desktop alerts are disabled.`
    : "";
  renderControls();
  const rowError = state?.batches.filter(batch => batch.scope === "thread" && !batchRunning(batch) && batch.status !== "completed")
    .map(batch => `Could not mark the notification as ${batch.action}. ${batch.error?.message ??
      "The notification changed before it could be updated. Review its current state and try again."}`).join(" ");
  const pendingRowError = [...marking.values()].map(operation => operation.error).filter(Boolean).join(" ");
  const error = actionError || rowError || pendingRowError || state?.error?.message || connectionError;
  const loading = state?.status === "idle" || state?.status === "loading";
  const filtered = Boolean(state?.filters.query || (state && state.filters.attention !== "all"));
  const cleared = Boolean(state && !state.loaded && state.hasMore);
  const caughtUp = Boolean(state && !error && !loading && !filtered && !state.groups.length && !cleared);
  const attention = state?.filters.attention ?? "all";
  const requestedAttention = pendingFilters?.attention ?? inFlightAttention;
  let focusedTab = [...attentionTabs.values()].find(tab => tab === document.activeElement);
  let tabsChanged = false;
  for (const { value, label } of attentionFilters) {
    const tab = attentionTabs.get(value);
    const text = state ? `${label} (${state.attentionCounts[value]})` : label;
    const selected = String(value === attention);
    const hidden = Boolean(preferences?.hideEmptyTabs && state?.attentionCounts[value] === 0 &&
      value !== "all" && value !== attention && value !== requestedAttention);
    if (tab.textContent !== text || tab.getAttribute("aria-selected") !== selected || tab.hidden !== hidden) tabsChanged = true;
    setControlText(tab, text);
    tab.setAttribute("aria-selected", selected);
    tab.hidden = hidden;
  }
  if (focusedTab?.hidden) {
    focusedTab = attentionTabs.get(requestedAttention ?? attention);
    if (document.hasFocus()) focusedTab.focus({ preventScroll: true });
  }
  for (const [value, tab] of attentionTabs) {
    tab.tabIndex = !tab.hidden && (focusedTab ? tab === focusedTab : value === attention) ? 0 : -1;
  }
  renderAttentionOverflow();
  if (focusedTab && tabsChanged) revealAttentionTab(focusedTab);
  const panel = $("attention-panel");
  const movePanelFocus = panel.tabIndex === 0 && document.activeElement === panel;
  panel.setAttribute("aria-labelledby", `attention-${attention}`);
  panel.tabIndex = state?.groups.length ? -1 : 0;
  $("empty-symbol").hidden = caughtUp;
  $("count").hidden = caughtUp;
  $("notice").hidden = !error && !subjectSelectionError;
  $("notice").textContent = error ? `${state?.loaded ? "Showing previously loaded notifications. " : ""}${error}` : subjectSelectionError;
  if (!state) {
    if (error) {
      $("empty-title").textContent = "Your inbox is unavailable";
      $("empty-description").textContent = "This view retries automatically while visible. Reopen the canvas if it stays disconnected.";
    }
    return;
  }
  if (document.activeElement !== $("search") && pendingFilters?.query === undefined) $("search").value = state.filters.query;
  $("count").textContent = `${state.loaded} total \u00b7 ${state.unread} unread${filtered ? ` \u00b7 ${state.matching} matching` : ""}`;
  $("more").hidden = !state.hasMore;
  setControlText($("more"), "Load more (up to 50)");
  $("more").title = state.needsRefresh ? "Refresh notifications before loading more." : "";
  const groupBy = preferences?.groupBy ?? "repo";
  $("groups").setAttribute("aria-label", groupBy === "repo" ? "Notifications by repository" :
    groupBy === "date" ? "Notifications by date" : "Notifications in GitHub order");
  renderGroups(displayGroups(), fallbackFocusKey, completedRows);
  scheduleSubjectSelectionSync();
  renderControls();
  for (const operation of completedRows) {
    const key = rowFocusKey(operation);
    restoreFocus(operation.previousFocus, focusKey(key) ?? $("search"));
    if (operation.focusRow && document.activeElement?.dataset.focusKey === key) {
      document.activeElement.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  if (state.groups.length && movePanelFocus) {
    restoreFocus(panel, $("groups").querySelectorAll(".repo-toggle")[0]);
  }
  for (const time of document.querySelectorAll("time")) time.textContent = relativeTime(time.dateTime);
  $("empty").hidden = Boolean(state.groups.length);
  $("empty-title").textContent = error ? "Your inbox is unavailable" :
    loading ? "Loading your inbox" :
    filtered ? "No matches in loaded notifications" :
    cleared ? "Loaded notifications cleared" : "All caught up \u{1F389}";
  const moreHelp = state.hasMore ? state.needsRefresh
    ? " Refresh to check for more notifications." : " Load more to search older notifications." : "";
  $("empty-description").textContent = error ? "Resolve the message above. This view retries automatically while visible when the retry time arrives." :
    loading ? "Using your existing GitHub CLI sign-in." :
    attention !== "all" ? `Try another attention filter or search.${moreHelp}` :
    state.filters.query ? `Try another title, number or repository.${moreHelp}` :
    cleared ? state.needsRefresh ? "Refresh to check for remaining notifications." : "Load more to continue through your notifications." :
    groupBy === "repo" ? "New notifications will appear here, grouped by repository." :
    groupBy === "date" ? "New notifications will appear here, grouped by date." :
    "New notifications will appear here in GitHub inbox order.";
  $("empty-refresh").hidden = !cleared || !state.needsRefresh || Boolean(error) || loading;
  renderBatch();
  positionSettings();
  renderedSnapshotVersion = state.snapshotVersion;
}

function revealAttentionTab(tab) {
  const strip = $("attention-tabs");
  const viewport = strip.getBoundingClientRect();
  const bounds = tab.getBoundingClientRect();
  if (bounds.left < viewport.left) {
    strip.scrollBy({ left: Math.floor(bounds.left - viewport.left) });
  } else if (bounds.right > viewport.right) {
    strip.scrollBy({ left: Math.ceil(bounds.right - viewport.right) });
  }
}

function renderAttentionOverflow() {
  const tabs = $("attention-tabs");
  const previous = $("attention-previous");
  const next = $("attention-next");
  const focused = document.activeElement;
  // Measure against the full strip so the arrows cannot keep themselves visible.
  const overflow = tabs.scrollWidth > $("attention-navigation").clientWidth + 1;
  previous.hidden = next.hidden = !overflow;
  // aria-disabled keeps keyboard focus on an arrow when scrolling reaches an end.
  previous.setAttribute("aria-disabled", String(!overflow || tabs.scrollLeft <= 1));
  next.setAttribute("aria-disabled", String(!overflow || tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft <= 1));
  if (!overflow && document.hasFocus() && (focused === previous || focused === next)) {
    attentionTabs.get(state?.filters.attention ?? "all").focus({ preventScroll: true });
  }
}

for (const [id, direction] of [["attention-previous", -1], ["attention-next", 1]]) {
  $(id).addEventListener("click", () => {
    if ($(id).hidden || $(id).getAttribute("aria-disabled") === "true") return;
    const tabs = $("attention-tabs");
    tabs.scrollBy({ left: direction * tabs.clientWidth * 0.8 });
    renderAttentionOverflow();
  });
}
$("attention-tabs").addEventListener("scroll", renderAttentionOverflow, { passive: true });

function activateAttention(value) {
  for (const [key, tab] of attentionTabs) tab.tabIndex = key === value ? 0 : -1;
  attentionTabs.get(value).scrollIntoView({ block: "nearest", inline: "nearest" });
  return update("filters", { attention: value });
}

for (const filter of attentionFilters) {
  const tab = element("button", "attention-tab", filter.label);
  tab.id = `attention-${filter.value}`;
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", "attention-panel");
  tab.setAttribute("aria-selected", String(filter.value === "all"));
  tab.tabIndex = filter.value === "all" ? 0 : -1;
  tab.disabled = !hasCapability;
  tab.addEventListener("click", () => {
    if (!tab.disabled && !tab.hidden) return activateAttention(filter.value);
  });
  tab.addEventListener("keydown", event => {
    if (tab.disabled || tab.hidden) return;
    const visibleFilters = attentionFilters.filter(filter => !attentionTabs.get(filter.value).hidden);
    const index = visibleFilters.indexOf(filter);
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % visibleFilters.length;
    else if (event.key === "ArrowLeft") next = (index + visibleFilters.length - 1) % visibleFilters.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visibleFilters.length - 1;
    else return;
    event.preventDefault();
    const nextFilter = visibleFilters[next];
    attentionTabs.get(nextFilter.value).focus();
    return activateAttention(nextFilter.value);
  });
  attentionTabs.set(filter.value, tab);
  $("attention-tabs").append(tab);
}

$("settings").addEventListener("toggle", () => {
  const open = $("settings").open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    positionSettings();
    void settingsRequest();
  }
});
$("settings-toggle").addEventListener("click", () => {
  $("settings-toggle").dataset.tooltipDismissed = "true";
});
$("development-api").addEventListener("change", renderSettings);
$("development-api-save").addEventListener("click", () => {
  if (preferences?.developmentApi && !$("development-api-save").disabled) {
    const baseUrl = $("development-api").value === "github" ? "https://api.github.com" : $("development-api-url").value;
    void settingsRequest({ baseUrl }, false, "development");
  }
});
$("auto-open").addEventListener("click", () => {
  if (preferences) void settingsRequest({ autoOpen: !preferences.autoOpen });
});
$("show-notifications").addEventListener("change", () => {
  if (preferences && !$("show-notifications").disabled) {
    const views = { all: true, unread: false };
    void settingsRequest({ matchGitHubInbox: views[$("show-notifications").value] });
  }
});
$("desktop-notifications").addEventListener("click", () => {
  if (preferences && !$("desktop-notifications").disabled) {
    void settingsRequest({ desktopNotifications: !preferences.desktopNotifications });
  }
});
$("desktop-sound").addEventListener("change", () => {
  if (preferences && !$("desktop-sound").disabled) void settingsRequest({ desktopSound: $("desktop-sound").value });
});
$("check-updates").addEventListener("click", checkUpdates);
$("copy-update").addEventListener("click", copyUpdatePrompt);
$("update-details-toggle").addEventListener("click", () => {
  setUpdateDetails($("update-prompt-details").hidden);
});
$("theme").addEventListener("change", () => {
  if (preferences && !$("theme").disabled) {
    const themes = { system: null, dark: true, light: false };
    void settingsRequest({ darkMode: themes[$("theme").value] });
  }
});
$("group-by").addEventListener("change", () => {
  if (preferences && !$("group-by").disabled) void settingsRequest({ groupBy: $("group-by").value });
});
$("copilot-integration").addEventListener("click", () => {
  if (preferences && !$("copilot-integration").disabled) {
    void settingsRequest({ copilotIntegration: !copilotEnabled() });
  }
});
$("copilot-confirmations").addEventListener("click", () => {
  if (preferences && !$("copilot-confirmations").disabled) {
    void settingsRequest({ confirmCopilotActions: !copilotConfirmations() });
  }
});
$("hide-empty-tabs").addEventListener("click", () => {
  if (preferences && !$("hide-empty-tabs").disabled) {
    void settingsRequest({ hideEmptyTabs: !preferences.hideEmptyTabs });
  }
});
$("keyboard-shortcuts").addEventListener("click", () => {
  if (preferences && !$("keyboard-shortcuts").disabled) {
    void settingsRequest({ keyboardShortcuts: !preferences.keyboardShortcuts });
  }
});
$("shortcuts-toggle").addEventListener("click", () => {
  $("shortcuts-toggle").focus();
  openShortcuts();
});
$("shortcuts-close").addEventListener("click", () => $("shortcuts-dialog").close());
$("copilot-close").addEventListener("click", () => $("copilot-dialog").close());
$("copilot-dialog").addEventListener("close", () => {
  copilotAwaitingResult = false;
  const previous = $("copilot-dialog").contains(document.activeElement) ? document.activeElement : $("copilot-close");
  restoreFocus(previous, focusKey(copilotReturnFocus) ?? $("search"));
});
$("copilot-skip-confirmation").addEventListener("click", () => {
  if ($("copilot-skip-confirmation").disabled) return;
  skipCopilotConfirmation = !skipCopilotConfirmation;
  $("copilot-skip-confirmation").setAttribute("aria-checked", String(skipCopilotConfirmation));
});
$("copilot-start").addEventListener("click", () => {
  if (copilotOperation?.status !== "ready") return;
  void requestCopilot({
    id: copilotOperation.id, token: copilotOperation.token, clone: copilotOperation.needsClone,
    ...copilotRememberInput(),
  });
});
$("shortcuts-dialog").addEventListener("close", () => {
  const previous = shortcutReturnFocus;
  const target = previous?.dataset?.focusKey ? focusKey(previous.dataset.focusKey) : $(previous?.id);
  restoreFocus($("shortcuts-close"), target ?? $("search"));
  shortcutReturnFocus = undefined;
});
document.addEventListener("click", event => {
  if ($("settings").open && !$("settings").contains(event.target)) closeSettings();
});
document.addEventListener("focusin", event => {
  if ($("settings").open && !$("settings").contains(event.target)) closeSettings();
});
document.addEventListener("keydown", event => {
  pointerInteraction = false;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter") {
    if (searchEnterHeld && event.repeat) {
      event.preventDefault();
      return;
    }
    if (!event.repeat) searchEnterHeld = false;
  }
  if (event.target === $("search")) {
    if (event.key !== "Enter") searchFocusRequested = false;
    else if (!searchComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
        visible() && document.hasFocus() && !$("search").disabled) {
      event.preventDefault();
      if (event.repeat) return;
      searchEnterHeld = true;
      searchFocusRequested = true;
      return flushPendingUpdates();
    }
  }
  if (event.key === "Enter" && event.repeat && (event.target?.dataset?.action || event.target?.dataset?.batchAction ||
      event.target?.dataset?.batchControl || ["batch-retry", "batch-dismiss"].includes(event.target?.id))) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Escape") return handleShortcut(event);
  if ($("copilot-dialog").open) {
    event.preventDefault();
    $("copilot-dialog").close();
    return;
  }
  if ($("shortcuts-dialog").open) {
    event.preventDefault();
    $("shortcuts-dialog").close();
    return;
  }
  // Let the browser dismiss an open picker before closing its Settings panel.
  if (window.CSS?.supports("selector(select:open)") && document.querySelector("select:open")) return;
  if ($("settings").open) {
    event.preventDefault();
    closeSettings(true);
  }
  dismissTooltips();
});
document.addEventListener("keyup", event => {
  if (event.key === "Enter") searchEnterHeld = false;
});
document.addEventListener("pointerdown", () => {
  searchFocusRequested = false;
  delete document.documentElement.dataset.pointerHoverSuppressed;
  pointerInteraction = true;
  setTooltipKeyboard(document.activeElement, false);
});
document.addEventListener("pointermove", () => {
  delete document.documentElement.dataset.pointerHoverSuppressed;
});
$("open-inbox").addEventListener("click", suppressHover);
$("open-inbox").addEventListener("auxclick", event => {
  if (event.button === 1) suppressHover();
});
window.addEventListener("blur", () => {
  searchFocusRequested = false;
  searchEnterHeld = false;
  suppressHover();
});
window.addEventListener("scroll", positionOverlays, { passive: true });
window.addEventListener("resize", positionOverlays);
$("more").addEventListener("click", () => update("more", {}));
function requestRefresh() {
  if (!visible() || requestsPaused()) return;
  pendingRefresh = true;
  renderControls();
  return flushPendingUpdates();
}
for (const id of ["force-refresh", "empty-refresh"]) $(id).addEventListener("click", requestRefresh);
for (const [control, anchor] of tooltipControls) {
  bindTooltip($(control), $(anchor));
}
function queueSearch() {
  searchFocusRequested = false;
  pendingFilters = { ...pendingFilters, query: $("search").value };
  renderControls();
  clearTimeout(searchTimer);
  if (searchComposing) return;
  searchTimer = setTimeout(() => {
    void flushPendingUpdates();
  }, 250);
}
$("search").addEventListener("compositionstart", () => {
  searchComposing = true;
  queueSearch();
});
$("search").addEventListener("compositionend", () => {
  searchComposing = false;
  queueSearch();
});
$("search").addEventListener("input", event => {
  if (event?.isComposing) searchComposing = true;
  queueSearch();
});
$("search").addEventListener("blur", () => { searchFocusRequested = false; });
$("collapse").addEventListener("click", () => {
  const groups = displayGroups();
  const close = groups.some(group => !collapsed.has(group.key));
  for (const group of groups) {
    if (close) collapsed.add(group.key);
    else collapsed.delete(group.key);
  }
  listKey = undefined;
  renderGroups(groups);
  scheduleSubjectSelectionSync();
  setControlText($("collapse"), close ? "Expand all" : "Collapse all");
});
let wasVisible = visible();
function visibilityChanged() {
  const isVisible = visible();
  if (isVisible && !wasVisible) pendingRefresh = true;
  wasVisible = isVisible;
  clearTimeout(timer);
  tickTooltip();
  if (isVisible) {
    void tick();
    void settingsRequest();
  } else {
    searchFocusRequested = false;
    searchEnterHeld = false;
    copyAttempt++;
    dismissTooltips();
    for (const controller of requestControllers) controller.abort();
    closeSettings();
    if (subjectSelectionFrame !== undefined) cancelAnimationFrame(subjectSelectionFrame);
    subjectSelectionFrame = undefined;
  }
}
document.addEventListener("visibilitychange", visibilityChanged);
const observer = new IntersectionObserver(entries => {
  intersecting = entries[0].isIntersecting;
  visibilityChanged();
});
observer.observe(document.documentElement);
const themeObserver = new MutationObserver(renderTheme);
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributes });
themeObserver.observe(document.body, { attributes: true, attributeFilter: themeAttributes });
const layoutObserver = new ResizeObserver(() => {
  if (stopped || overlayFrame !== undefined) return;
  // Overflow controls and Settings positioning can resize the observed elements.
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = undefined;
    if (stopped) return;
    renderAttentionOverflow();
    positionOverlays();
  });
});
layoutObserver.observe($("attention-navigation"));
for (const tab of attentionTabs.values()) layoutObserver.observe(tab);
layoutObserver.observe($("inbox-header"));
layoutObserver.observe($("settings-panel"));
systemTheme.addEventListener("change", renderTheme);
renderTheme();
window.addEventListener("pagehide", () => {
  stopped = true;
  searchFocusRequested = false;
  searchEnterHeld = false;
  copyAttempt++;
  dismissTooltips();
  clearTimeout(timer);
  clearTimeout(tooltipTimer);
  clearTimeout(searchTimer);
  clearTimeout(copyFeedbackTimer);
  if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
  overlayFrame = undefined;
  if (subjectSelectionFrame !== undefined) cancelAnimationFrame(subjectSelectionFrame);
  subjectSelectionFrame = undefined;
  for (const controller of requestControllers) controller.abort();
  observer.disconnect();
  themeObserver.disconnect();
  layoutObserver.disconnect();
  $("attention-tabs").removeEventListener("scroll", renderAttentionOverflow);
  window.removeEventListener("scroll", positionOverlays);
  window.removeEventListener("resize", positionOverlays);
  systemTheme.removeEventListener("change", renderTheme);
});
if (hasCapability) {
  tickTooltip();
  void tick();
  void settingsRequest();
} else {
  $("notice").hidden = false;
  $("notice").textContent = "Missing canvas capability. Open this canvas from Copilot instead of browsing to its local address.";
  $("empty-title").textContent = "Open from Copilot";
  $("check-updates").disabled = true;
}
