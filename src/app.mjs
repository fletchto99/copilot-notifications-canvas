import { attentionFilters, notificationTitle, orderedThreads } from "./model.mjs";

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
let pendingSettings;
let soundOptionsKey;
let releaseState;
let updatesBusy = false;
let updateError = "";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const marking = new Map();
let actionError = "";
let batchBusy = false;
let batchFocusKey;
let repositoryMenu;
const iconPaths = {
  read: "M3 9 12 3l9 6v11H3V9Zm0 0 9 6 9-6M3 20l6-7m12 7-6-7",
  done: "m5 12 4 4L19 6",
  more: "m7 10 5 5 5-5",
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
  const mode = document.documentElement.getAttribute("data-color-mode") ?? document.body.getAttribute("data-color-mode");
  if (theme !== "system") {
    document.documentElement.dataset.notificationTheme = theme;
  } else if (mode === "dark" || mode === "light") {
    delete document.documentElement.dataset.notificationTheme;
  } else {
    document.documentElement.dataset.notificationTheme = systemTheme.matches ? "dark" : "light";
  }
  $("theme").value = theme;
}

function renderSettings() {
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
      (id !== "auto-open" && !preferences.desktopStatus?.supported);
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
}

async function settingsRequest(input, quiet = false) {
  if (!visible()) return;
  if (settingsBusy) {
    if (input && !pendingSettings) {
      pendingSettings = { input, focus: document.activeElement };
      renderSettings();
    }
    return;
  }
  const previousFocus = document.activeElement;
  settingsBusy = true;
  if (!quiet) {
    renderSettings();
    $("settings-status").textContent = input ? "" : "Loading...";
    $("settings-status").hidden = !$("settings-status").textContent;
    $("settings-error").hidden = true;
  }
  try {
    preferences = await api("settings", input);
    render();
    $("settings-status").textContent = "";
    $("settings-error").hidden = true;
  } catch (error) {
    $("settings-status").textContent = `${error.message || "Settings request failed."} Close and reopen Settings to retry.`;
    $("settings-error").textContent = $("settings-status").textContent;
    $("settings-error").hidden = false;
  } finally {
    settingsBusy = false;
    $("settings-status").hidden = !$("settings-status").textContent;
    renderSettings();
    restoreFocus(previousFocus);
    if (pendingSettings && visible()) {
      const next = pendingSettings;
      pendingSettings = undefined;
      restoreFocus(next.focus);
      void settingsRequest(next.input);
    }
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
  if (!available) return;
  $("update-title").textContent = `Canvas update available: v${updates.latestVersion} (running v${updates.currentVersion}).${updates.error ? " Last known release; the latest check failed." : ""}`;
  $("release-notes").href = updates.releaseUrl;
  $("update-instructions").href = updates.instructionsUrl;
  if ($("update-prompt").value !== updates.prompt) {
    $("update-prompt").value = updates.prompt;
    $("copy-status").textContent = "";
  }
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
  if (!visible() || !releaseState?.prompt) return;
  try {
    await navigator.clipboard.writeText(releaseState.prompt);
    $("copy-status").textContent = "Copied. Paste the prompt into Copilot to review and run the update.";
  } catch {
    $("update-prompt-details").open = true;
    $("update-prompt").focus();
    $("update-prompt").select();
    $("copy-status").textContent = "Clipboard unavailable. Copy the selected prompt and paste it into Copilot.";
  }
}

function closeSettings(focus = false) {
  $("settings").open = false;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  if (focus) $("settings-toggle").focus();
}

async function markThread(id, action) {
  if (!visible() || busy || batchBusy || batchLocked() || marking.size) return;
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
    nextFocusKey = next ? `${action}:${next.id}` : null;
  } catch (error) {
    actionError = `Could not mark the notification as ${action}. ${error.message || "Try again."}`;
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

function focusKey(key) {
  return [...$("groups").querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key);
}

function restoreFocus(previous, preferred) {
  if (!visible() || !previous || (!previous.id && !previous.dataset?.focusKey)) return;
  const current = document.activeElement;
  const key = previous.dataset?.focusKey;
  if (current && current !== previous && current !== document.body && current !== document.documentElement &&
      !(key && current.dataset?.focusKey === key)) return;
  let target = preferred ?? (key ? focusKey(key) : $(previous.id));
  for (let node = target; node; node = node.parentNode) {
    if (node.hidden) {
      target = null;
      break;
    }
  }
  (target && !target.disabled ? target : $("search")).focus({ preventScroll: true });
}

function closeRepositoryMenu(focus = false) {
  if (!repositoryMenu) return;
  const { trigger, panel } = repositoryMenu;
  repositoryMenu = undefined;
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (focus && visible()) trigger.focus();
}

function toggleRepositoryMenu(container, trigger, panel, option) {
  if (!visible() || busy || batchBusy || batchLocked() || marking.size) return;
  trigger.focus();
  const closing = repositoryMenu?.trigger === trigger;
  closeRepositoryMenu();
  dismissTooltips();
  if (closing) return;
  closeSettings();
  repositoryMenu = { container, trigger, panel };
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  option.focus();
}

async function batchRequest(action, input) {
  if (!visible() || batchBusy || busy) return;
  if (["start", "retry"].includes(action) && (marking.size || batchLocked())) return;
  batchBusy = true;
  let failed = false;
  const previousFocus = document.activeElement;
  closeRepositoryMenu();
  dismissTooltips();
  renderControls();
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api(`batch/${action}`, input);
    actionError = "";
  } catch (error) {
    failed = true;
    actionError = error.message || "The repository action failed. Try again.";
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
  $("batch-progress").className = running ? "batch-running" : "batch-progress";
  $("batch-title").textContent = `${batch.repository}: ${batch.status === "stopping" ? "Stopping after the current request" :
    running ? `Marking as ${batch.action}...` : `Some notifications remain to mark as ${batch.action}`}`;
  $("batch-counts").hidden = running;
  $("batch-counts").textContent = running ? "" : `${batch.succeeded} succeeded / ${batch.failed} failed / ${batch.skipped} skipped / ${batch.notAttempted} not attempted (${batch.total} selected)`;
  const retryTime = batch.retryAt > Date.now() ? ` Retry after ${new Date(batch.retryAt).toLocaleTimeString()}.` : "";
  const detail = batch.error?.message ?? (batch.skipped ? "Skipped notifications were changed or no longer unread in the loaded inbox. Review their current state separately." : "");
  $("batch-error").hidden = !detail;
  $("batch-error").textContent = detail + retryTime;
  $("batch-stop").hidden = !running;
  $("batch-stop").disabled = batchBusy || busy || batch.status === "stopping";
  $("batch-retry").hidden = running || batch.failed + batch.notAttempted === 0;
  $("batch-retry").textContent = `Retry remaining (${batch.failed + batch.notAttempted})`;
  $("batch-retry").disabled = batchBusy || busy || batch.retryAt > Date.now();
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
    if (succeeded || path !== "filters" || pendingRefresh) void flushPendingUpdates();
    schedule();
  }
}

async function flushPendingUpdates() {
  if (busy || batchBusy || marking.size || batchLocked() || !visible()) return;
  if (pendingRefresh) {
    pendingRefresh = false;
    return blockingUpdate("refresh", { force: true });
  }
  if (!pendingFilters) return;
  const input = pendingFilters;
  pendingFilters = undefined;
  clearTimeout(searchTimer);
  if (Object.entries(input).some(([key, value]) => value !== state?.filters[key])) {
    await blockingUpdate("filters", input);
  }
}

async function tick() {
  if (!visible() || busy) return;
  if ($("settings").open) void settingsRequest(undefined, true);
  if (marking.size) return schedule();
  if (batchLocked() || batchBusy) return update();
  if (pendingRefresh) return flushPendingUpdates();
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderRefreshStatus(updateAge = false) {
  const fetchedAt = state?.lastFetchedAt ?? null;
  const progress = pendingRefresh ? "Refresh queued. " : refreshing ? "Refreshing. " : "";
  const key = `${fetchedAt}:${progress}`;
  if (!updateAge && key === refreshStatusKey) return;
  refreshStatusKey = key;
  const seconds = fetchedAt === null ? null : Math.floor(Math.max(0, Date.now() - fetchedAt) / 1000);
  const updated = seconds === null ? "Not updated yet" : `Last updated ${seconds} second${seconds === 1 ? "" : "s"} ago`;
  $("refresh-tooltip-text").textContent = progress + updated;
  $("force-refresh").setAttribute("aria-busy", String(pendingRefresh || refreshing));
}

function bindTooltip(control, anchor) {
  const show = () => {
    delete anchor.dataset.tooltipDismissed;
    if (anchor.id === "refresh-control") renderRefreshStatus(true);
  };
  control.addEventListener("pointerenter", show);
  control.addEventListener("focus", show);
}

function dismissTooltips() {
  const anchors = [...tooltipControls.map(([, id]) => $(id)), ...$("groups").querySelectorAll(".tooltip-anchor")];
  for (const anchor of anchors) anchor.dataset.tooltipDismissed = "true";
}

function tickTooltip() {
  clearTimeout(tooltipTimer);
  if (!visible()) return;
  renderRefreshStatus(true);
  tooltipTimer = setTimeout(tickTooltip, 15_000);
}

function renderControls() {
  const loading = busy || state?.status === "loading" || marking.size > 0 || batchBusy || batchLocked();
  const waiting = state && Date.now() < state.nextRefreshAt;
  renderRefreshStatus();
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const button of $("groups").querySelectorAll("button")) {
    if (!button.dataset.disclosure) button.disabled = loading || marking.has(button.dataset.threadId);
    if (button.dataset.threadId) {
      button.setAttribute("aria-busy", String(marking.get(button.dataset.threadId) === button.dataset.action));
    }
    if (button.dataset.repository) {
      const batch = batchLocked() && state.batch.repository === button.dataset.repository ? state.batch : null;
      const progress = batch ? batch.status === "stopping" ? "Stopping..." : `Marking ${batch.succeeded}/${batch.total}...` : null;
      button.textContent = progress ?? `Mark ${button.dataset.count} as ${button.dataset.batchAction}`;
      button.setAttribute("aria-label", progress ? `${progress} as ${batch.action} in ${button.dataset.repository}` :
        `Mark ${button.dataset.count} shown, loaded notifications as ${button.dataset.batchAction} in ${button.dataset.repository}`);
      button.setAttribute("aria-busy", String(Boolean(batch)));
    }
  }
  $("search").disabled = batchBusy || batchLocked();
  for (const tab of attentionTabs.values()) tab.disabled = !hasCapability || batchBusy || batchLocked();
  $("batch-stop").disabled = batchBusy || busy || state?.batch?.status === "stopping";
  $("batch-retry").disabled = batchBusy || busy || (state?.batch?.retryAt ?? 0) > Date.now();
  $("batch-dismiss").disabled = batchBusy || busy;
  $("groups").setAttribute("aria-busy", String(loading));
}

function displayGroups() {
  const groups = state?.groups ?? [];
  const groupBy = preferences?.groupBy ?? "repo";
  if (groupBy === "repo") {
    return groups.map(group => ({ ...group, key: `repo:${group.repository}`, label: group.repository }));
  }
  const items = orderedThreads(groups.flatMap(group => group.items));
  if (groupBy === "none") return items.length ? [{ items }] : [];
  const dates = new Map();
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const key = `date:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    let group = dates.get(key);
    if (!group) {
      group = {
        key,
        label: date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        unread: 0,
        items: [],
      };
      dates.set(key, group);
    }
    group.items.push(item);
    group.unread++;
  }
  return [...dates.values()];
}

function renderGroups(groups, fallbackFocusKey) {
  $("collapse").hidden = !groups.length || !groups[0].key;
  $("collapse").textContent = groups.some(group => !collapsed.has(group.key)) ? "Collapse all" : "Expand all";
  // Keep focused controls and disclosure state stable across unchanged polls.
  const key = JSON.stringify(groups);
  if (key === listKey) return;
  listKey = key;
  const previousFocus = document.activeElement;
  const focused = repositoryMenu?.panel.contains(previousFocus) ? repositoryMenu.trigger.dataset.focusKey : previousFocus?.dataset.focusKey;
  closeRepositoryMenu();
  const fragment = document.createDocumentFragment();
  for (const [index, group] of groups.entries()) {
    const rows = element("div", group.key ? "repo-items" : "notification-list");
    if (group.key) {
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
        element("span", "repo-count", `${group.unread} unread`));
      disclosure.addEventListener("click", () => {
        rows.hidden = !rows.hidden;
        if (rows.hidden) collapsed.add(group.key);
        else collapsed.delete(group.key);
        disclosure.setAttribute("aria-expanded", String(!rows.hidden));
        $("collapse").textContent = groups.some(item => !collapsed.has(item.key)) ? "Collapse all" : "Expand all";
      });
      header.append(disclosure);
      if (group.repository) {
        const controls = element("div", "repo-actions");
        controls.addEventListener("mousedown", event => {
          // Do not let WebKit focus the surrounding tabpanel and dismiss an open menu before click.
          if (event.button === 0 && repositoryMenu?.container === controls) event.preventDefault();
        });
        const markGroup = element("button", "repo-read", `Mark ${group.items.length} as read`);
        const more = element("button", "icon-button repo-more");
        more.type = "button";
        more.dataset.focusKey = `bulk-menu:${group.repository}`;
        more.setAttribute("aria-label", `More actions for ${group.repository}`);
        more.setAttribute("aria-expanded", "false");
        more.append(actionIcon("more"));
        const menu = element("div", "repo-menu");
        menu.id = `repo-menu-${index}`;
        menu.hidden = true;
        menu.setAttribute("role", "group");
        menu.setAttribute("aria-label", `Actions for ${group.repository}`);
        more.setAttribute("aria-controls", menu.id);
        const done = element("button", "repo-done", `Mark ${group.items.length} as done`);
        markGroup.dataset.focusKey = `bulk:${group.repository}`;
        done.dataset.focusKey = `bulk-done:${group.repository}`;
        for (const [button, action] of [[markGroup, "read"], [done, "done"]]) {
          button.type = "button";
          button.dataset.repository = group.repository;
          button.dataset.count = String(group.items.length);
          button.dataset.batchAction = action;
          button.setAttribute("aria-label", `Mark ${group.items.length} shown, loaded notifications as ${action} in ${group.repository}`);
          button.disabled = busy || marking.size > 0 || batchBusy || batchLocked();
          button.addEventListener("click", () => {
            if (busy || batchBusy || batchLocked() || marking.size || (action === "done" && menu.hidden)) return;
            // WebKit pointer clicks can blur the button before this handler.
            button.focus();
            batchFocusKey = markGroup.dataset.focusKey;
            return batchRequest("start", { repository: group.repository, selectionKey: group.selectionKey, action });
          });
        }
        more.disabled = markGroup.disabled;
        more.addEventListener("click", () => toggleRepositoryMenu(controls, more, menu, done));
        menu.append(done);
        controls.append(markGroup, more, menu);
        header.append(controls);
      }
      section.append(header, rows);
      fragment.append(section);
    } else {
      fragment.append(rows);
    }
    for (const item of group.items) {
      const row = element("article", "row unread");
      const dot = element("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      const content = element("div", "row-content");
      const link = element("a", "title", item.title || "(Untitled notification)");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = item.label;
      link.dataset.focusKey = `thread:${item.id}`;
      content.append(link);
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
      for (const action of ["read", "done"]) {
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
        button.disabled = busy || marking.has(item.id) || batchBusy || batchLocked();
        button.setAttribute("aria-label", `Mark as ${action}: ${notificationTitle(item, "Untitled notification")}`);
        button.setAttribute("aria-describedby", tooltip.id);
        button.setAttribute("aria-busy", String(marking.get(item.id) === action));
        button.append(actionIcon(action));
        bindTooltip(button, anchor);
        button.addEventListener("click", () => markThread(item.id, action));
        anchor.append(button, tooltip);
        actions.append(anchor);
      }
      row.append(dot, content, actions);
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
  renderUpdates(state?.updates);
  const development = state?.development;
  $("development-build").hidden = !development;
  $("development-build").textContent = development ? `dev (v${development.version}) ${development.branch}` : "";
  renderControls();
  const error = actionError || state?.error?.message || connectionError;
  const loading = state?.status === "idle" || state?.status === "loading";
  const filtered = Boolean(state?.filters.query || (state && state.filters.attention !== "all"));
  const caughtUp = Boolean(state && !error && !loading && !filtered && !state.groups.length);
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
  $("attention-panel").setAttribute("aria-labelledby", `attention-${attention}`);
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
  $("count").textContent = `${state.unread} unread${filtered ? ` \u00b7 ${state.matching} matching` : ""}`;
  $("more").hidden = !state.hasMore;
  $("more").textContent = "Load more (up to 50)";
  $("more").title = state.needsRefresh ? "Refresh notifications before loading more." : "";
  const groupBy = preferences?.groupBy ?? "repo";
  $("groups").setAttribute("aria-label", groupBy === "repo" ? "Notifications by repository" :
    groupBy === "date" ? "Notifications by date" : "Notifications, newest first");
  $("subtitle").textContent = groupBy === "repo" ? "A little less noise. One repository at a time." :
    groupBy === "date" ? "A little less noise. One day at a time." : "A little less noise. Newest notifications first.";
  renderGroups(displayGroups(), fallbackFocusKey);
  renderControls();
  for (const time of document.querySelectorAll("time")) time.textContent = relativeTime(time.dateTime);
  $("empty").hidden = Boolean(state.groups.length);
  $("empty-title").textContent = error ? "Your inbox is unavailable" :
    loading ? "Loading your inbox" :
    filtered ? "No matches in loaded notifications" : "All caught up \u{1F389}";
  $("empty-description").textContent = error ? "Resolve the message above. This view retries automatically while visible when the retry time arrives." :
    attention !== "all" ? "Try another attention filter or search, or load more notifications." :
    state.filters.query ? "Try another title, number or repository, or load more notifications." :
    loading ? "Using your existing GitHub CLI sign-in." :
    groupBy === "repo" ? "New notifications will appear here, grouped by repository." :
    groupBy === "date" ? "New notifications will appear here, grouped by date." :
    "New notifications will appear here, newest first.";
  renderBatch();
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
  if (open) void settingsRequest();
});
$("auto-open").addEventListener("click", () => {
  if (preferences) void settingsRequest({ autoOpen: !preferences.autoOpen });
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
  if (repositoryMenu && !repositoryMenu.container.contains(event.target)) closeRepositoryMenu();
});
document.addEventListener("focusin", event => {
  if (repositoryMenu && !repositoryMenu.container.contains(event.target)) closeRepositoryMenu();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if ($("settings").open) {
    event.preventDefault();
    closeSettings(true);
  }
  if (repositoryMenu) {
    event.preventDefault();
    closeRepositoryMenu(true);
  }
  dismissTooltips();
});
$("open-inbox").addEventListener("click", dismissTooltips);
window.addEventListener("blur", () => {
  closeRepositoryMenu();
  dismissTooltips();
});
$("more").addEventListener("click", () => update("more", {}));
$("force-refresh").addEventListener("click", () => {
  if (!visible()) return;
  pendingRefresh = true;
  renderControls();
  return flushPendingUpdates();
});
for (const [control, anchor] of tooltipControls) {
  bindTooltip($(control), $(anchor));
}
$("search").addEventListener("input", () => {
  pendingFilters = { ...pendingFilters, query: $("search").value };
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
    closeRepositoryMenu();
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
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-color-mode"] });
const attentionObserver = new ResizeObserver(renderAttentionOverflow);
attentionObserver.observe($("attention-navigation"));
for (const tab of attentionTabs.values()) attentionObserver.observe(tab);
systemTheme.addEventListener("change", renderTheme);
renderTheme();
window.addEventListener("pagehide", () => {
  stopped = true;
  closeRepositoryMenu();
  dismissTooltips();
  clearTimeout(timer);
  clearTimeout(tooltipTimer);
  clearTimeout(searchTimer);
  for (const controller of requestControllers) controller.abort();
  observer.disconnect();
  themeObserver.disconnect();
  attentionObserver.disconnect();
  $("attention-tabs").removeEventListener("scroll", renderAttentionOverflow);
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
