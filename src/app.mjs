import { notificationTitle, orderedThreads } from "./model.mjs";

const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const hasCapability = /^[a-f0-9]{64}$/.test(token);
const collapsed = new Set();
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
let state;
let listKey;
let busy = false;
let stopped = false;
let intersecting = true;
let timer;
let searchTimer;
let pendingQuery;
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
const markingRead = new Set();
let readError = "";
let batchBusy = false;
let batchFocusKey;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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

async function markRead(id) {
  if (!visible() || busy || batchBusy || batchLocked() || markingRead.size) return;
  const key = `read:${id}`;
  const index = displayGroups().flatMap(group => group.items).findIndex(item => item.id === id);
  const previousFocus = document.activeElement;
  let nextFocusKey = key;
  markingRead.add(id);
  renderControls();
  readError = "";
  const button = focusKey(key);
  if (button) {
    button.disabled = true;
    button.textContent = "Marking...";
  }
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api("read", { id });
    const remaining = displayGroups().flatMap(group => group.items);
    const next = remaining[Math.min(index, remaining.length - 1)];
    nextFocusKey = next ? `read:${next.id}` : null;
  } catch (error) {
    readError = `Could not mark the notification as read. ${error.message || "Try again."}`;
  } finally {
    markingRead.delete(id);
    render(nextFocusKey);
    const current = focusKey(key);
    if (current) {
      current.disabled = false;
      current.textContent = "Mark as read";
    }
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
  const target = preferred ?? (key ? focusKey(key) : $(previous.id));
  (target && !target.disabled && !target.hidden ? target : $("search")).focus({ preventScroll: true });
}

async function batchRequest(action, input) {
  if (!visible() || batchBusy || busy) return;
  if (["start", "retry"].includes(action) && (markingRead.size || batchLocked())) return;
  batchBusy = true;
  let failed = false;
  const previousFocus = document.activeElement;
  renderControls();
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api(`batch/${action}`, input);
    readError = "";
  } catch (error) {
    failed = true;
    readError = error.message || "The repository action failed. Try again.";
    try {
      state = await api("state");
    } catch {
      readError += " Could not reconnect. Reopen this panel to inspect its current progress.";
    }
  } finally {
    batchBusy = false;
    render();
    if (visible() && !failed) {
      const target = state?.batch?.status === "stopping" ? $("batch-progress") :
        batchLocked() ? $("batch-stop") : focusKey(batchFocusKey) ?? $("search");
      restoreFocus(previousFocus, target);
    } else {
      restoreFocus(previousFocus);
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
  $("batch-title").textContent = `${batch.repository}: ${batch.status === "stopping" ? "Stopping after the current request" : running ? "Marking as read..." : "Some notifications remain"}`;
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
    if (path === "refresh") readError = "";
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
    pendingQuery = input.query;
    return flushPendingUpdates();
  }
  if (path !== "state") return blockingUpdate(path, input);
  if (pollPromise) return pollPromise;
  if (busy || batchBusy || markingRead.size || !visible()) return Promise.resolve();
  pollPromise = performUpdate(path, input).finally(() => {
    pollPromise = undefined;
    render();
    void flushPendingUpdates();
    schedule();
  });
  return pollPromise;
}

async function blockingUpdate(path, input) {
  if (busy || batchBusy || markingRead.size || batchLocked() || !visible()) return;
  const previousFocus = document.activeElement;
  let succeeded = false;
  busy = true;
  refreshing = path === "refresh";
  renderControls();
  try {
    await pollPromise;
    if (path === "filters" && pendingQuery !== undefined) {
      input = { query: pendingQuery };
      pendingQuery = undefined;
      clearTimeout(searchTimer);
    }
    if (visible()) succeeded = await performUpdate(path, input);
  } finally {
    busy = false;
    refreshing = false;
    if (!succeeded && path === "filters" && pendingQuery === undefined) pendingQuery = input.query;
    render();
    restoreFocus(previousFocus);
    if (succeeded || path !== "filters" || pendingRefresh) void flushPendingUpdates();
    schedule();
  }
}

async function flushPendingUpdates() {
  if (busy || batchBusy || markingRead.size || batchLocked() || !visible()) return;
  if (pendingRefresh) {
    pendingRefresh = false;
    return blockingUpdate("refresh", { force: true });
  }
  if (pendingQuery === undefined) return;
  const query = pendingQuery;
  pendingQuery = undefined;
  clearTimeout(searchTimer);
  if (query !== state?.filters.query) await blockingUpdate("filters", { query });
}

async function tick() {
  if (!visible() || busy) return;
  if ($("settings").open) void settingsRequest(undefined, true);
  if (markingRead.size) return schedule();
  if (batchLocked() || batchBusy) return update();
  if (pendingRefresh) return flushPendingUpdates();
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderControls() {
  const loading = busy || state?.status === "loading" || markingRead.size > 0 || batchBusy || batchLocked();
  const waiting = state && Date.now() < state.nextRefreshAt;
  $("force-refresh").textContent = pendingRefresh ? "Refresh queued..." : refreshing ? "Refreshing..." : "Force refresh";
  $("force-refresh").setAttribute("aria-busy", String(pendingRefresh || refreshing));
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const button of $("groups").querySelectorAll("button")) {
    if (!button.dataset.disclosure) button.disabled = loading || markingRead.has(button.dataset.threadId);
    if (button.dataset.repository) {
      const batch = batchLocked() && state.batch.repository === button.dataset.repository ? state.batch : null;
      const progress = batch ? batch.status === "stopping" ? "Stopping..." : `Marking ${batch.succeeded}/${batch.total}...` : null;
      button.textContent = progress ?? `Mark ${button.dataset.count} as read`;
      button.setAttribute("aria-label", progress ? `${progress} in ${button.dataset.repository}` :
        `Mark ${button.dataset.count} shown, loaded notifications as read in ${button.dataset.repository}`);
      button.setAttribute("aria-busy", String(Boolean(batch)));
    }
  }
  $("search").disabled = batchBusy || batchLocked();
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
  const focused = document.activeElement?.dataset.focusKey;
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
        element("span", "repo-count", `${group.items.length} / ${group.unread} unread`));
      disclosure.addEventListener("click", () => {
        rows.hidden = !rows.hidden;
        if (rows.hidden) collapsed.add(group.key);
        else collapsed.delete(group.key);
        disclosure.setAttribute("aria-expanded", String(!rows.hidden));
        $("collapse").textContent = groups.some(item => !collapsed.has(item.key)) ? "Collapse all" : "Expand all";
      });
      header.append(disclosure);
      if (group.repository) {
        const markGroup = element("button", "repo-read", `Mark ${group.items.length} as read`);
        markGroup.type = "button";
        markGroup.dataset.focusKey = `bulk:${group.repository}`;
        markGroup.dataset.repository = group.repository;
        markGroup.dataset.count = String(group.items.length);
        markGroup.setAttribute("aria-label", `Mark ${group.items.length} shown, loaded notifications as read in ${group.repository}`);
        markGroup.disabled = busy || markingRead.size > 0 || batchBusy || batchLocked();
        markGroup.addEventListener("click", () => {
          if (busy || batchBusy || batchLocked() || markingRead.size) return;
          batchFocusKey = markGroup.dataset.focusKey;
          return batchRequest("start", { repository: group.repository, selectionKey: group.selectionKey });
        });
        header.append(markGroup);
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
      const content = element("div");
      const link = element("a", "title", item.title || "(Untitled notification)");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = item.label;
      link.dataset.focusKey = `thread:${item.id}`;
      content.append(link);
      const metadata = element("div", "metadata");
      if (!group.repository) metadata.append(element("span", "repository", item.repository));
      const type = item.type.replace(/([a-z])([A-Z])/g, "$1 $2");
      metadata.append(element("span", "", item.number ? `${type} #${item.number}` : type),
        element("span", "", item.reason.replaceAll("_", " ")),
        element("span", "", "Unread"));
      if (!item.direct) metadata.append(element("span", "destination", item.label));
      content.append(metadata);
      const time = element("time", "", relativeTime(item.updatedAt));
      time.dateTime = item.updatedAt;
      time.title = new Date(item.updatedAt).toLocaleString();
      time.setAttribute("aria-label", time.title);
      const read = element("button", "mark-read", markingRead.has(item.id) ? "Marking..." : "Mark as read");
      read.type = "button";
      read.dataset.focusKey = `read:${item.id}`;
      read.dataset.threadId = item.id;
      read.disabled = busy || markingRead.has(item.id) || batchBusy || batchLocked();
      read.setAttribute("aria-label", `Mark as read: ${notificationTitle(item, "Untitled notification")}`);
      read.addEventListener("click", () => markRead(item.id));
      row.append(dot, content, time, read);
      rows.append(row);
    }
  }
  $("groups").replaceChildren(fragment);
  if (focused) {
    (focusKey(focused) ?? focusKey(fallbackFocusKey) ?? $("search")).focus({ preventScroll: true });
  }
}

function render(fallbackFocusKey) {
  renderUpdates(state?.updates);
  const development = state?.development;
  $("development-build").hidden = !development;
  $("development-build").textContent = development ? `dev (v${development.version}) ${development.branch}` : "";
  renderControls();
  const error = readError || state?.error?.message || connectionError;
  const loading = state?.status === "idle" || state?.status === "loading";
  const caughtUp = Boolean(state && !error && !loading && !state.filters.query && !state.groups.length);
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
  if (document.activeElement !== $("search") && pendingQuery === undefined) $("search").value = state.filters.query;
  $("count").textContent = `${state.unread} unread${state.filters.query ? ` \u00b7 ${state.matching} matching` : ""}`;
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
    state.filters.query ? "No matches in loaded notifications" : "All caught up \u{1F389}";
  $("empty-description").textContent = error ? "Resolve the message above. This view retries automatically while visible when the retry time arrives." :
    state.filters.query ? "Try another title, number or repository, or load more notifications." :
    loading ? "Using your existing GitHub CLI sign-in." :
    groupBy === "repo" ? "New notifications will appear here, grouped by repository." :
    groupBy === "date" ? "New notifications will appear here, grouped by date." :
    "New notifications will appear here, newest first.";
  const fetched = state.lastFetchedAt ? `Checked ${relativeTime(new Date(state.lastFetchedAt).toISOString())} \u00b7 ` : "";
  const minutes = Math.ceil(Math.max(0, state.nextRefreshAt - Date.now()) / 60_000);
  const next = minutes ? `Next check in ${minutes} min` : "Next check soon";
  $("updated").textContent = `${fetched}${loading ? "Checking..." : next}`;
  const checkedAt = state.lastFetchedAt ? `Last checked ${new Date(state.lastFetchedAt).toLocaleString()}. ` : "";
  const nextAt = state.nextRefreshAt ? `Next check ${new Date(state.nextRefreshAt).toLocaleString()}. ` : "";
  $("updated").title = `${checkedAt}${nextAt}Automatic refresh runs only while this view is visible.`;
  renderBatch();
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
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("settings").open) {
    event.preventDefault();
    closeSettings(true);
  }
});
$("more").addEventListener("click", () => update("more", {}));
$("force-refresh").addEventListener("click", () => {
  if (!visible()) return;
  pendingRefresh = true;
  renderControls();
  return flushPendingUpdates();
});
$("search").addEventListener("input", () => {
  pendingQuery = $("search").value;
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
function visibilityChanged() {
  clearTimeout(timer);
  if (visible()) {
    void tick();
    void settingsRequest();
  } else {
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
systemTheme.addEventListener("change", renderTheme);
renderTheme();
window.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(searchTimer);
  for (const controller of requestControllers) controller.abort();
  observer.disconnect();
  themeObserver.disconnect();
  systemTheme.removeEventListener("change", renderTheme);
});
if (hasCapability) {
  void tick();
  void settingsRequest();
} else {
  $("notice").hidden = false;
  $("notice").textContent = "Missing canvas capability. Open this canvas from Copilot instead of browsing to its local address.";
  $("empty-title").textContent = "Open from Copilot";
  $("check-updates").disabled = true;
}
