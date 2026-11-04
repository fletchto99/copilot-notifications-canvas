import { apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle } from "./model.mjs";

const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const hasCapability = /^[a-f0-9]{64}$/.test(token);
const collapsed = new Set();
const attentionTabs = new Map();
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
let state;
let listKey;
let busy = false;
let stopped = false;
let intersecting = true;
let timer;
let tooltipTimer;
let overlayFrame;
let refreshStatusKey;
let searchTimer;
let pendingFilters;
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
let batchBusy = false;
let batchFocusKey;
const iconPaths = {
  read: "M3 9 12 3l9 6v11H3V9Zm0 0 9 6 9-6M3 20l6-7m12 7-6-7",
  done: "m5 12 4 4L19 6",
};
const tooltipControls = [
  ["open-inbox", "inbox-control"],
  ["force-refresh", "refresh-control"],
  ["settings-toggle", "settings-toggle"],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionIcon(action) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  for (const [name, value] of Object.entries({
    width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value);
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", iconPaths[action]);
  svg.append(path);
  return svg;
}

function relativeTime(date) {
  const seconds = Math.round((Date.parse(date) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  for (const [unit, divisor] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= divisor) return relative.format(Math.trunc(seconds / divisor), unit);
  }
}

async function api(path, input) {
  const controller = new AbortController();
  requestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
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
  if (theme !== "system") {
    document.documentElement.dataset.notificationTheme = theme;
  } else if (mode === "dark" || mode === "light") {
    delete document.documentElement.dataset.notificationTheme;
  } else {
    document.documentElement.dataset.notificationTheme = systemTheme.matches ? "dark" : "light";
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
  ]) {
    if (preferences) {
      $(id).setAttribute("aria-checked", String(Boolean(preferences[key])));
    }
    $(id).disabled = settingsBusy || !preferences ||
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
    $("development-api-reload").hidden = !api.requiresReload;
  }
  renderSettingsError();
  positionSettings();
}

async function settingsRequest(input, quiet = false, path = "settings") {
  if (!visible()) return;
  if (settingsBusy) {
    if (input && !pendingSettings) {
      pendingSettings = { input, path, focus: document.activeElement };
      renderSettings();
    }
    return;
  }
  const previousFocus = document.activeElement;
  let refreshInbox = false;
  settingsBusy = true;
  if (!quiet) {
    settingsError = "";
    renderSettings();
    $("settings-status").textContent = input ? "" : "Loading...";
    $("settings-status").hidden = !$("settings-status").textContent;
  }
  try {
    preferences = await api(path, input);
    settingsError = "";
    if (state) state.settingsError = null;
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
  if (!open && details.contains(document.activeElement)) toggle.focus();
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
    $("update-prompt").focus();
    $("update-prompt").select();
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
  if (focus) $("settings-toggle").focus();
}

async function markThread(id, action) {
  if (!visible() || busy || batchBusy || batchLocked() || marking.size || pendingFilters) return;
  const key = `${action}:${id}`;
  const index = displayGroups().flatMap(group => group.items).findIndex(item => item.id === id);
  const previousFocus = document.activeElement;
  let nextFocusKey = key;
  dismissTooltips();
  marking.set(id, action);
  renderControls();
  actionError = "";
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api(action, { id });
    const remaining = displayGroups().flatMap(group => group.items);
    const next = remaining[Math.min(index, remaining.length - 1)];
    nextFocusKey = remaining.some(item => item.id === id) ? `done:${id}` : next ? `${action}:${next.id}` : null;
  } catch (error) {
    actionError = `Could not mark the notification as ${action}. ${error.message || "Try again."}`;
    try {
      state = await api("state");
    } catch {
      actionError += " Could not reconnect. Reopen this panel to inspect its current state.";
    }
  } finally {
    marking.delete(id);
    render(nextFocusKey);
    restoreFocus(previousFocus, nextFocusKey ? focusKey(nextFocusKey) : $("search"));
    void flushPendingUpdates();
    schedule();
  }
}

function visible() {
  return hasCapability && !stopped && !document.hidden && intersecting;
}

function batchLocked() {
  return ["running", "stopping"].includes(state?.batch?.status);
}

function requestsPaused() {
  return (state?.retryAt ?? 0) > Date.now();
}

function focusKey(key) {
  return [...$("groups").querySelectorAll("[data-focus-key]")]
    .find(node => node.dataset.focusKey === key);
}

function restoreFocus(previous, preferred) {
  if (!visible() || !previous || (!previous.id && !previous.dataset?.focusKey)) return;
  const current = document.activeElement;
  const key = previous.dataset?.focusKey;
  if (current && current !== previous && current !== document.body && current !== document.documentElement &&
      !(key && current.dataset?.focusKey === key)) return;
  let target = preferred ?? (key ? focusKey(key) : $(previous.id));
  if (!target && key?.startsWith("read:")) target = focusKey(`done:${key.slice(5)}`);
  for (let node = target; node; node = node.parentNode) {
    if (node.hidden) {
      target = null;
      break;
    }
  }
  (target && !target.disabled ? target : $("search")).focus({ preventScroll: true });
}

async function batchRequest(action, input) {
  if (!visible() || batchBusy || busy) return;
  if (["start", "retry"].includes(action) && (marking.size || batchLocked() || pendingFilters)) return;
  batchBusy = true;
  let failed = false;
  const previousFocus = document.activeElement;
  dismissTooltips();
  renderControls();
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api(`batch/${action}`, input);
    actionError = "";
  } catch (error) {
    failed = true;
    actionError = error.message || "The notification action failed. Try again.";
    try {
      state = await api("state");
    } catch {
      actionError += " Could not reconnect. Reopen this panel to inspect its current progress.";
    }
  } finally {
    batchBusy = false;
    render();
    if (visible() && !failed) {
      const target = state?.batch?.status === "stopping" ? $("batch-progress") :
        batchLocked() ? $("batch-stop") : focusKey(batchFocusKey) ?? $("search");
      restoreFocus(previousFocus, target);
    } else {
      restoreFocus(previousFocus, action === "start" ? focusKey(batchFocusKey) : undefined);
    }
    void flushPendingUpdates();
    schedule();
  }
}

function renderBatch() {
  const batch = state?.batch;
  const controls = [$("batch-stop"), $("batch-retry"), $("batch-dismiss")];
  const previousFocus = document.activeElement;
  const hadFocus = [...controls, $("batch-progress")].includes(previousFocus);
  $("batch-progress").hidden = !batch;
  if (!batch) {
    for (const id of ["batch-title", "batch-counts", "batch-error"]) $(id).textContent = "";
    if (hadFocus) restoreFocus(previousFocus, focusKey(batchFocusKey) ?? $("search"));
    return;
  }
  const running = ["running", "stopping"].includes(batch.status);
  const cancelled = batch.status === "cancelled" && !batch.error;
  const remaining = batch.failed + batch.notAttempted;
  $("batch-progress").className = running ? "batch-running" : "batch-progress";
  const target = batch.scope === "shown" ? "Shown notifications" : batch.scope === "date" ? dateLabel(batch.date) : batch.repository;
  $("batch-title").textContent = `${target}: ${batch.status === "stopping" ? "Stopping after the current request" :
    running ? `Marking as ${batch.action}...` : cancelled ? "Stopped" : `Some notifications remain to mark as ${batch.action}`}`;
  $("batch-counts").hidden = running;
  $("batch-counts").textContent = running ? "" : cancelled
    ? `${batch.succeeded} marked ${batch.action}, ${remaining} remaining${batch.skipped ? `, ${batch.skipped} skipped` : ""}`
    : `${batch.succeeded} succeeded / ${batch.failed} failed / ${batch.skipped} skipped / ${batch.notAttempted} not attempted (${batch.total} selected)`;
  const retryTime = batch.retryAt > Date.now() ? ` Retry after ${new Date(batch.retryAt).toLocaleTimeString()}.` : "";
  const detail = batch.error?.message ?? (batch.skipped ? "Skipped notifications changed or are no longer eligible in the loaded inbox. Review their current state separately." : "");
  $("batch-error").hidden = !detail;
  $("batch-error").textContent = detail + retryTime;
  $("batch-stop").hidden = !running;
  $("batch-stop").disabled = batchBusy || busy || batch.status === "stopping";
  $("batch-retry").hidden = running || remaining === 0;
  $("batch-retry").textContent = `${cancelled ? "Continue" : "Retry"} remaining (${remaining})`;
  $("batch-retry").disabled = batchBusy || busy || Boolean(pendingFilters) || batch.retryAt > Date.now();
  $("batch-dismiss").hidden = running;
  $("batch-dismiss").disabled = batchBusy || busy;
  if (controls.includes(previousFocus) && previousFocus.hidden) restoreFocus(previousFocus, $("batch-progress"));
}

function schedule() {
  clearTimeout(timer);
  if (visible()) timer = setTimeout(tick, batchLocked() ? 1000 : 5000);
}

async function performUpdate(path, input) {
  renderControls();
  try {
    state = await api(path, input);
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
        state = await api("state");
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
  if (busy || batchBusy || marking.size || !visible()) return Promise.resolve();
  pollPromise = performUpdate(path, input).finally(() => {
    pollPromise = undefined;
    render();
    void flushPendingUpdates();
    schedule();
  });
  return pollPromise;
}

async function blockingUpdate(path, input) {
  if (busy || batchBusy || marking.size || batchLocked() || !visible()) return;
  const previousFocus = document.activeElement;
  let succeeded = false;
  busy = true;
  refreshing = path === "refresh";
  renderControls();
  try {
    await pollPromise;
    if (path === "filters" && pendingFilters) {
      input = { ...input, ...pendingFilters };
      pendingFilters = undefined;
      clearTimeout(searchTimer);
    }
    if (visible()) succeeded = await performUpdate(path, input);
  } finally {
    busy = false;
    refreshing = false;
    if (!succeeded && path === "filters") pendingFilters = { ...input, ...pendingFilters };
    render();
    restoreFocus(previousFocus);
    if (succeeded || path !== "filters" || (pendingRefresh && !requestsPaused())) void flushPendingUpdates();
    schedule();
  }
}

async function flushPendingUpdates() {
  if (busy || batchBusy || marking.size || batchLocked() || !visible()) return;
  if (pendingRefresh && !requestsPaused()) {
    pendingRefresh = false;
    return blockingUpdate("refresh", { force: true });
  }
  if (!pendingFilters) return;
  const input = pendingFilters;
  pendingFilters = undefined;
  clearTimeout(searchTimer);
  if (Object.entries(input).some(([key, value]) => value !== state?.filters[key])) {
    await blockingUpdate("filters", input);
  } else {
    renderControls();
  }
}

async function tick() {
  if (!visible() || busy) return;
  if ($("settings").open) void settingsRequest(undefined, true);
  if (marking.size) return schedule();
  if (batchLocked() || batchBusy) return update();
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
    if (!anchor.dataset.tooltipDismissed && (anchor.contains(document.activeElement) || anchor.matches(":hover"))) {
      positionTooltip(anchor);
    }
  }
}

function bindTooltip(control, anchor) {
  const show = () => {
    delete anchor.dataset.tooltipDismissed;
    if (anchor.id === "refresh-control") renderRefreshStatus(true);
    positionTooltip(anchor);
  };
  control.addEventListener("pointerenter", show);
  control.addEventListener("focus", show);
}

function dismissTooltips() {
  for (const anchor of tooltipAnchors()) anchor.dataset.tooltipDismissed = "true";
}

function tickTooltip() {
  clearTimeout(tooltipTimer);
  if (!visible()) return;
  renderRefreshStatus(true);
  tooltipTimer = setTimeout(tickTooltip, 15_000);
}

function renderControls() {
  const loading = busy || state?.status === "loading" || marking.size > 0 || batchBusy || batchLocked();
  const actionsBlocked = loading || Boolean(pendingFilters);
  const waiting = state && Date.now() < state.nextRefreshAt;
  renderRefreshStatus();
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const button of $("groups").querySelectorAll("button")) {
    if (!button.dataset.disclosure) button.disabled = actionsBlocked || marking.has(button.dataset.threadId) ||
      button.dataset.count === "0";
    if (button.dataset.threadId) {
      button.setAttribute("aria-busy", String(marking.get(button.dataset.threadId) === button.dataset.action));
    }
    if (button.dataset.batchAction) {
      const batch = batchLocked() && state.batch.action === button.dataset.batchAction && state.batch.scope === button.dataset.batchScope &&
        (state.batch.scope === "date"
          ? state.batch.date === button.dataset.batchDate && state.batch.timeZone === button.dataset.batchTimeZone
          : state.batch.scope === "shown" || state.batch.repository === button.dataset.repository) ? state.batch : null;
      const progress = batch ? batch.status === "stopping" ? "Stopping..." : `Marking ${batch.succeeded}/${batch.total}...` : null;
      const destination = button.dataset.batchDate ? ` on ${dateLabel(button.dataset.batchDate)}` :
        button.dataset.repository ? ` in ${button.dataset.repository}` : "";
      const label = `Mark ${button.dataset.count} as ${button.dataset.batchAction}`;
      button.parentNode.querySelectorAll(".tooltip-content")[0].textContent = progress ?? label;
      button.setAttribute("aria-label", progress ? `${progress} as ${batch.action}${destination}` :
        `${label}${destination}; ${button.dataset.count} shown, loaded notifications`);
      button.setAttribute("aria-busy", String(Boolean(batch)));
    }
  }
  $("search").disabled = batchBusy || batchLocked();
  for (const tab of attentionTabs.values()) tab.disabled = !hasCapability || batchBusy || batchLocked();
  $("batch-stop").disabled = batchBusy || busy || state?.batch?.status === "stopping";
  $("batch-retry").disabled = batchBusy || busy || Boolean(pendingFilters) || (state?.batch?.retryAt ?? 0) > Date.now();
  $("batch-dismiss").disabled = batchBusy || busy;
  $("groups").setAttribute("aria-busy", String(loading));
  renderNotificationView();
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

function createBatchControls({ repository, date, timeZone, selectionKey, count, unread, tooltipPrefix }) {
  const scope = date ? "date" : repository ? "repository" : "shown";
  const key = repository ?? (date ? `date:${date}` : "shown");
  const name = repository ?? (date ? dateLabel(date) : "shown notifications");
  const destination = date ? ` on ${name}` : repository ? ` in ${repository}` : "";
  const target = date ? { scope: "date", date, timeZone } : repository ? { repository } : { scope: "shown" };
  const controls = element("div", "repo-actions");
  const read = element("button", "icon-button repo-read");
  const done = element("button", "icon-button repo-done");
  read.dataset.focusKey = `bulk:${key}`;
  done.dataset.focusKey = `bulk-done:${key}`;
  for (const [button, action] of [[read, "read"], [done, "done"]]) {
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
    button.disabled = !selected || busy || marking.size > 0 || batchBusy || batchLocked() || Boolean(pendingFilters);
    button.append(actionIcon(action));
    bindTooltip(button, anchor);
    button.addEventListener("click", () => {
      if (!selected || busy || batchBusy || batchLocked() || marking.size || pendingFilters) return;
      // WebKit pointer clicks can blur the button before this handler.
      button.focus();
      batchFocusKey = button.dataset.focusKey;
      return batchRequest("start", { ...target, selectionKey, action });
    });
    anchor.append(button, tooltip);
    controls.append(anchor);
  }
  return controls;
}

function renderGroups(groups, fallbackFocusKey) {
  $("collapse").hidden = !groups.length;
  $("collapse").textContent = groups.some(group => !collapsed.has(group.key)) ? "Collapse all" : "Expand all";
  // Keep focused controls and disclosure state stable across unchanged polls.
  const key = JSON.stringify(groups);
  if (key === listKey) return;
  listKey = key;
  const previousFocus = document.activeElement;
  const focused = previousFocus?.dataset.focusKey;
  const fragment = document.createDocumentFragment();
  for (const [index, group] of groups.entries()) {
    const rows = element("div", "repo-items");
    const section = element("section", "repo-group");
    const header = element("div", "repo-header");
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
      $("collapse").textContent = groups.some(item => !collapsed.has(item.key)) ? "Collapse all" : "Expand all";
    });
    header.append(disclosure, createBatchControls({
      repository: group.repository, date: group.date, timeZone: group.timeZone,
      selectionKey: group.selectionKey, count: group.items.length, unread: group.unread, tooltipPrefix: `group-${index}`,
    }));
    section.append(header, rows);
    fragment.append(section);
    for (const item of group.items) {
      const row = element("article", `row ${item.unread ? "unread" : "read"}`);
      const dot = element("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      const content = element("div", "row-content");
      const title = element("span", "title", item.title || "(Untitled notification)");
      const link = element("a", "row-link");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = item.label;
      // WebKit's default Tab navigation can skip links without an explicit tab stop.
      link.tabIndex = 0;
      link.dataset.focusKey = `thread:${item.id}`;
      content.append(title);
      content.append(element("span", "sr-only", item.unread ? "Unread" : "Read"));
      const metadata = element("div", "metadata");
      const type = item.type.replace(/([a-z])([A-Z])/g, "$1 $2");
      const time = element("time", "", relativeTime(item.updatedAt));
      time.dateTime = item.updatedAt;
      time.title = new Date(item.updatedAt).toLocaleString();
      time.setAttribute("aria-label", time.title);
      const fields = [
        ...(group.repository ? [] : [element("span", "repository", item.repository)]),
        element("span", "notification-type", item.number ? `${type} #${item.number}` : type),
        element("span", "", item.reason.replaceAll("_", " ")),
        ...(!item.direct ? [element("span", "destination", item.label)] : []),
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
      for (const action of item.unread ? ["read", "done"] : ["done"]) {
        const anchor = element("div", "tooltip-anchor");
        const button = element("button", `icon-button mark-${action}`);
        const tooltip = element("span", "tooltip");
        tooltip.id = `row-${action}-${item.id}-tooltip`;
        tooltip.setAttribute("role", "tooltip");
        tooltip.append(element("span", "tooltip-content", `Mark as ${action}`));
        button.type = "button";
        button.dataset.focusKey = `${action}:${item.id}`;
        button.dataset.threadId = item.id;
        button.dataset.action = action;
        button.disabled = busy || marking.has(item.id) || batchBusy || batchLocked() || Boolean(pendingFilters);
        button.setAttribute("aria-label", `Mark as ${action}: ${notificationTitle(item, "Untitled notification")}`);
        button.setAttribute("aria-describedby", tooltip.id);
        button.setAttribute("aria-busy", String(marking.get(item.id) === action));
        button.append(actionIcon(action));
        bindTooltip(button, anchor);
        button.addEventListener("click", () => markThread(item.id, action));
        anchor.append(button, tooltip);
        actions.append(anchor);
      }
      link.append(dot, content);
      row.append(link, actions);
      rows.append(row);
    }
  }
  $("groups").replaceChildren(fragment);
  if (focused) {
    const target = focusKey(focused) ?? focusKey(fallbackFocusKey);
    // Pending actions restore focus once their replacement controls are enabled.
    if (!target?.disabled) restoreFocus(previousFocus, target);
  }
}

function render(fallbackFocusKey) {
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
  const error = actionError || state?.error?.message || connectionError;
  const loading = state?.status === "idle" || state?.status === "loading";
  const filtered = Boolean(state?.filters.query || (state && state.filters.attention !== "all"));
  const cleared = Boolean(state && !state.loaded && (state.hasMore || state.needsRefresh));
  const caughtUp = Boolean(state && !error && !loading && !filtered && !state.groups.length && !cleared);
  const attention = state?.filters.attention ?? "all";
  const focusedTab = [...attentionTabs.values()].find(tab => tab === document.activeElement);
  let tabsChanged = false;
  for (const { value, label } of attentionFilters) {
    const tab = attentionTabs.get(value);
    const text = state ? `${label} (${state.attentionCounts[value]})` : label;
    const selected = String(value === attention);
    if (tab.textContent !== text || tab.getAttribute("aria-selected") !== selected) tabsChanged = true;
    tab.textContent = text;
    tab.setAttribute("aria-selected", selected);
    tab.tabIndex = (focusedTab ? tab === focusedTab : value === attention) ? 0 : -1;
  }
  renderAttentionOverflow();
  if (focusedTab && tabsChanged) revealAttentionTab(focusedTab);
  const panel = $("attention-panel");
  const movePanelFocus = panel.tabIndex === 0 && document.activeElement === panel;
  panel.setAttribute("aria-labelledby", `attention-${attention}`);
  panel.tabIndex = state?.groups.length ? -1 : 0;
  $("empty-symbol").hidden = caughtUp;
  $("count").hidden = caughtUp;
  $("notice").hidden = !error;
  $("notice").textContent = error ? `${state?.loaded ? "Showing previously loaded notifications. " : ""}${error}` : "";
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
  $("more").textContent = "Load more (up to 50)";
  $("more").title = state.needsRefresh ? "Refresh notifications before loading more." : "";
  const groupBy = preferences?.groupBy ?? "repo";
  $("groups").setAttribute("aria-label", groupBy === "repo" ? "Notifications by repository" :
    groupBy === "date" ? "Notifications by date" : "Notifications in GitHub order");
  $("subtitle").textContent = groupBy === "repo" ? "A little less noise. One repository at a time." :
    groupBy === "date" ? "A little less noise. One day at a time." : "A little less noise. Your GitHub inbox order.";
  renderGroups(displayGroups(), fallbackFocusKey);
  renderControls();
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
  if (!overflow && (focused === previous || focused === next)) {
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

for (const [index, filter] of attentionFilters.entries()) {
  const tab = element("button", "attention-tab", filter.label);
  tab.id = `attention-${filter.value}`;
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", "attention-panel");
  tab.setAttribute("aria-selected", String(filter.value === "all"));
  tab.tabIndex = filter.value === "all" ? 0 : -1;
  tab.disabled = !hasCapability;
  tab.addEventListener("click", () => {
    if (!tab.disabled) return activateAttention(filter.value);
  });
  tab.addEventListener("keydown", event => {
    if (tab.disabled) return;
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % attentionFilters.length;
    else if (event.key === "ArrowLeft") next = (index + attentionFilters.length - 1) % attentionFilters.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = attentionFilters.length - 1;
    else return;
    event.preventDefault();
    const filter = attentionFilters[next];
    attentionTabs.get(filter.value).focus();
    return activateAttention(filter.value);
  });
  attentionTabs.set(filter.value, tab);
  $("attention-tabs").append(tab);
}

for (const [id, action] of [["batch-stop", "cancel"],
  ["batch-retry", "retry"], ["batch-dismiss", "dismiss"]]) {
  $(id).addEventListener("click", () => state?.batch && batchRequest(action, { token: state.batch.token }));
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
document.addEventListener("click", event => {
  if ($("settings").open && !$("settings").contains(event.target)) closeSettings();
});
document.addEventListener("focusin", event => {
  if ($("settings").open && !$("settings").contains(event.target)) closeSettings();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if ($("settings").open) {
    event.preventDefault();
    closeSettings(true);
  }
  dismissTooltips();
});
$("open-inbox").addEventListener("click", dismissTooltips);
window.addEventListener("blur", () => {
  dismissTooltips();
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
$("search").addEventListener("input", () => {
  pendingFilters = { ...pendingFilters, query: $("search").value };
  renderControls();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void flushPendingUpdates();
  }, 250);
});
$("collapse").addEventListener("click", () => {
  const groups = displayGroups();
  const close = groups.some(group => !collapsed.has(group.key));
  for (const group of groups) {
    if (close) collapsed.add(group.key);
    else collapsed.delete(group.key);
  }
  listKey = undefined;
  renderGroups(groups);
  $("collapse").textContent = close ? "Expand all" : "Collapse all";
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
    copyAttempt++;
    dismissTooltips();
    for (const controller of requestControllers) controller.abort();
    closeSettings();
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
  if (stopped) return;
  renderAttentionOverflow();
  if (overlayFrame !== undefined) return;
  // Settings positioning can resize the panel this observer is watching.
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = undefined;
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
  copyAttempt++;
  dismissTooltips();
  clearTimeout(timer);
  clearTimeout(tooltipTimer);
  clearTimeout(searchTimer);
  clearTimeout(copyFeedbackTimer);
  if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
  overlayFrame = undefined;
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
