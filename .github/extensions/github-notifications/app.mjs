import { NotificationSound } from "./sound.mjs";

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
let pollPromise;
const requestControllers = new Set();
let connectionError = "";
let preferences;
let settingsBusy = false;
let releaseState;
let updatesBusy = false;
let updateError = "";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const markingRead = new Set();
let readError = "";
let batchBusy = false;
let batchFocusKey;
const sound = new NotificationSound({
  createContext: () => new (window.AudioContext || window.webkitAudioContext)(),
  onChange: ({ enabled, pending, message }) => {
    $("sound-label").textContent = pending ? "Cancel enabling sound" : "Play sound";
    $("sound").setAttribute("aria-checked", String(enabled));
    $("sound-status").textContent = message;
    $("sound-status").hidden = !message;
  },
});

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

function darkMode() {
  if (typeof preferences?.darkMode === "boolean") return preferences.darkMode;
  const mode = document.documentElement.getAttribute("data-color-mode") ?? document.body.getAttribute("data-color-mode");
  return mode === "dark" || (mode !== "light" && systemTheme.matches);
}

function renderTheme() {
  if (typeof preferences?.darkMode === "boolean") {
    document.documentElement.dataset.notificationTheme = preferences.darkMode ? "dark" : "light";
  } else {
    delete document.documentElement.dataset.notificationTheme;
  }
  $("dark-mode").setAttribute("aria-checked", String(darkMode()));
}

async function settingsRequest(input) {
  if (settingsBusy || !visible()) return;
  const previousFocus = document.activeElement;
  settingsBusy = true;
  $("auto-open").disabled = true;
  $("dark-mode").disabled = true;
  $("settings-status").textContent = input ? "Saving..." : "Loading...";
  $("settings-status").hidden = false;
  $("settings-error").hidden = true;
  try {
    preferences = await api("settings", input);
    $("auto-open").setAttribute("aria-checked", String(preferences.autoOpen));
    renderTheme();
    $("settings-status").textContent = "";
  } catch (error) {
    $("settings-status").textContent = `${error.message || "Settings request failed."} Close and reopen Settings to retry.`;
    $("settings-error").textContent = $("settings-status").textContent;
    $("settings-error").hidden = false;
  } finally {
    settingsBusy = false;
    $("settings-status").hidden = !$("settings-status").textContent;
    $("auto-open").disabled = !preferences;
    $("dark-mode").disabled = !preferences;
    if (previousFocus === $("auto-open") || previousFocus === $("dark-mode")) restoreFocus(previousFocus);
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
  $("installed-version").textContent = `Notification Canvas v${updates.currentVersion}`;
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
  const findButton = key => [...$("groups").querySelectorAll("[data-focus-key]")]
    .find(node => node.dataset.focusKey === key);
  const key = `read:${id}`;
  const index = state.groups.flatMap(group => group.items).findIndex(item => item.id === id);
  const previousFocus = document.activeElement;
  let nextFocusKey = key;
  markingRead.add(id);
  renderControls();
  readError = "";
  const button = findButton(key);
  if (button) {
    button.disabled = true;
    button.textContent = "Marking...";
  }
  try {
    await pollPromise;
    if (!visible()) return;
    state = await api("read", { id });
    sound.observe(state.activity);
    const remaining = state.groups.flatMap(group => group.items);
    const next = remaining[Math.min(index, remaining.length - 1)];
    nextFocusKey = next ? `read:${next.id}` : null;
  } catch (error) {
    readError = `Could not mark the notification as read. ${error.message || "Try again."}`;
  } finally {
    markingRead.delete(id);
    render();
    const current = findButton(key);
    if (current) {
      current.disabled = false;
      current.textContent = "Mark as read";
    }
    restoreFocus(previousFocus, nextFocusKey ? findButton(nextFocusKey) : $("search"));
    void flushSearch();
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
    sound.observe(state.activity);
    readError = "";
  } catch (error) {
    failed = true;
    readError = error.message || "The repository action failed. Try again.";
    try {
      state = await api("state");
      sound.observe(state.activity);
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
    void flushSearch();
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
  const soundGeneration = sound.generation;
  const soundWasEnabled = sound.enabled;
  renderControls();
  try {
    state = await api(path, input);
    sound.observe(state.activity, {
      refresh: path === "refresh" && soundWasEnabled,
      visible: visible(),
      generation: soundGeneration,
    });
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
        sound.observe(state.activity);
      } catch {
        connectionError = "The local canvas disconnected. Reopen it to reconnect.";
        sound.resetBaseline();
      }
    } else if (visible()) {
      sound.resetBaseline();
    }
    return false;
  }
}

function update(path = "state", input) {
  if (path === "filters") {
    pendingQuery = input.query;
    return flushSearch();
  }
  if (path !== "state") return blockingUpdate(path, input);
  if (pollPromise) return pollPromise;
  if (busy || batchBusy || markingRead.size || !visible()) return Promise.resolve();
  pollPromise = performUpdate(path, input).finally(() => {
    pollPromise = undefined;
    render();
    void flushSearch();
    schedule();
  });
  return pollPromise;
}

async function blockingUpdate(path, input) {
  if (busy || batchBusy || markingRead.size || batchLocked() || !visible()) return;
  const previousFocus = document.activeElement;
  let succeeded = false;
  busy = true;
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
    if (!succeeded && path === "filters" && pendingQuery === undefined) pendingQuery = input.query;
    render();
    restoreFocus(previousFocus);
    if (succeeded || path !== "filters") void flushSearch();
    schedule();
  }
}

async function flushSearch() {
  if (pendingQuery === undefined || busy || batchBusy || markingRead.size || batchLocked() || !visible()) return;
  const query = pendingQuery;
  pendingQuery = undefined;
  clearTimeout(searchTimer);
  if (query !== state?.filters.query) await blockingUpdate("filters", { query });
}

async function tick() {
  if (!visible() || busy) return;
  if (markingRead.size) return schedule();
  if (batchLocked() || batchBusy) return update();
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderControls() {
  const loading = busy || state?.status === "loading" || markingRead.size > 0 || batchBusy || batchLocked();
  const waiting = state && Date.now() < state.nextRefreshAt;
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

function renderGroups(groups) {
  // Keep focused controls and disclosure state stable across unchanged polls.
  const key = JSON.stringify(groups);
  if (key === listKey) return;
  listKey = key;
  const focused = document.activeElement?.dataset.focusKey;
  const fragment = document.createDocumentFragment();
  for (const [index, group] of groups.entries()) {
    const section = element("section", "repo-group");
    const header = element("div", "repo-header");
    const rows = element("div", "repo-items");
    rows.id = `repo-items-${index}`;
    rows.hidden = collapsed.has(group.repository);
    const disclosure = element("button", "repo-toggle");
    disclosure.type = "button";
    disclosure.dataset.disclosure = "true";
    disclosure.dataset.focusKey = `repo:${group.repository}`;
    disclosure.setAttribute("aria-controls", rows.id);
    disclosure.setAttribute("aria-expanded", String(!rows.hidden));
    disclosure.append(element("span", "repo-name", group.repository),
      element("span", "repo-count", `${group.items.length} / ${group.unread} unread`));
    disclosure.addEventListener("click", () => {
      rows.hidden = !rows.hidden;
      if (rows.hidden) collapsed.add(group.repository);
      else collapsed.delete(group.repository);
      disclosure.setAttribute("aria-expanded", String(!rows.hidden));
      $("collapse").textContent = groups.some(item => !collapsed.has(item.repository)) ? "Collapse all" : "Expand all";
    });
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
    header.append(disclosure, markGroup);
    section.append(header, rows);
    for (const item of group.items) {
      const row = element("article", `row${item.unread ? " unread" : ""}`);
      const dot = element("span", `dot${item.unread ? "" : " read"}`);
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
      metadata.append(element("span", "", item.type.replace(/([a-z])([A-Z])/g, "$1 $2")),
        element("span", "", item.reason.replaceAll("_", " ")),
        element("span", "", item.unread ? "Unread" : "Read"));
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
      read.setAttribute("aria-label", `Mark as read: ${item.title || "Untitled notification"}`);
      read.addEventListener("click", () => markRead(item.id));
      row.append(dot, content, time, read);
      rows.append(row);
    }
    fragment.append(section);
  }
  $("groups").replaceChildren(fragment);
  if (focused) {
    (focusKey(focused) ?? $("search")).focus({ preventScroll: true });
  }
}

function render() {
  renderUpdates(state?.updates);
  renderControls();
  const error = readError || state?.error?.message || connectionError;
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
  $("count").textContent = `${state.matching} shown / ${state.groups.length} repositories / ${state.unread} unread notifications`;
  $("collapse").hidden = !state.groups.length;
  $("more").hidden = !state.hasMore;
  $("more").textContent = "Load more (up to 50)";
  $("coverage").textContent = `${state.loaded} notifications loaded.${state.hasMore ? " Older notifications are available." : state.lastFetchedAt ? " End of the available inbox." : ""}${state.needsRefresh ? " Waiting for automatic refresh before loading more; pagination changed." : ""}${state.filters.query ? " Search covers loaded notifications only." : ""}`;
  renderGroups(state.groups);
  renderControls();
  for (const time of document.querySelectorAll("time")) time.textContent = relativeTime(time.dateTime);
  $("empty").hidden = Boolean(state.groups.length);
  $("empty-title").textContent = error ? "Your inbox is unavailable" :
    state.status === "idle" || state.status === "loading" ? "Loading your inbox" :
    state.filters.query ? "No matches in loaded notifications" : "All caught up";
  $("empty-description").textContent = error ? "Resolve the message above. This view retries automatically while visible when the retry time arrives." :
    state.filters.query ? "Try another title or repository, or load more notifications." :
    state.status === "idle" || state.status === "loading" ? "Using your existing GitHub CLI sign-in." :
    "New notifications will appear here, grouped by repository.";
  const fetched = state.lastFetchedAt ? `Checked ${new Date(state.lastFetchedAt).toLocaleTimeString()}. ` : "";
  $("updated").textContent = `${fetched}Next refresh ${new Date(Math.max(Date.now(), state.nextRefreshAt)).toLocaleTimeString()} while visible.`;
  renderBatch();
}

for (const [id, action] of [["batch-stop", "cancel"],
  ["batch-retry", "retry"], ["batch-dismiss", "dismiss"]]) {
  $(id).addEventListener("click", () => state?.batch && batchRequest(action, { token: state.batch.token }));
}
$("sound").addEventListener("click", () => {
  if (visible()) void sound.toggle();
});
$("settings").addEventListener("toggle", () => {
  const open = $("settings").open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
  if (open) void settingsRequest();
});
$("auto-open").addEventListener("click", () => {
  if (preferences) void settingsRequest({ autoOpen: !preferences.autoOpen });
});
$("check-updates").addEventListener("click", checkUpdates);
$("copy-update").addEventListener("click", copyUpdatePrompt);
$("dark-mode").addEventListener("click", () => {
  if (preferences) void settingsRequest({ darkMode: !darkMode() });
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
$("search").addEventListener("input", () => {
  pendingQuery = $("search").value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void flushSearch();
  }, 250);
});
$("collapse").addEventListener("click", () => {
  const groups = state?.groups ?? [];
  const close = groups.some(group => !collapsed.has(group.repository));
  for (const group of groups) {
    if (close) collapsed.add(group.repository);
    else collapsed.delete(group.repository);
  }
  listKey = undefined;
  renderGroups(groups);
  $("collapse").textContent = close ? "Expand all" : "Collapse all";
});
function visibilityChanged() {
  clearTimeout(timer);
  sound.resetBaseline();
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
  void sound.close();
});
if (hasCapability) {
  void tick();
  void settingsRequest();
} else {
  $("notice").hidden = false;
  $("notice").textContent = "Missing canvas capability. Open this canvas from Copilot instead of browsing to its local address.";
  $("empty-title").textContent = "Open from Copilot";
  $("sound").disabled = true;
  $("check-updates").disabled = true;
}
