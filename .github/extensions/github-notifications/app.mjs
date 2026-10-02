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
const requestControllers = new Set();
let connectionError = "";
let preferences;
let settingsBusy = false;
const markingRead = new Set();
let readError = "";
let batchBusy = false;
let batchFocusKey;
let batchMessage = "";
const sound = new NotificationSound({
  createContext: () => new (window.AudioContext || window.webkitAudioContext)(),
  onChange: ({ enabled, pending, message }) => {
    $("sound").textContent = pending ? "Cancel enabling sound" : enabled ? "Play sound: On" : "Play sound: Off";
    $("sound").setAttribute("aria-checked", String(enabled));
    $("sound").setAttribute("aria-label", pending ? "Cancel enabling sound" : enabled ? "Disable notification sound" : "Enable notification sound");
    $("sound-status").textContent = message;
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

async function settingsRequest(input) {
  if (settingsBusy || !visible()) return;
  settingsBusy = true;
  $("auto-open").disabled = true;
  $("settings-status").textContent = input ? "Saving startup setting..." : "Loading startup setting...";
  try {
    preferences = await api("settings", input);
    $("auto-open").textContent = `Open on new sessions: ${preferences.autoOpen ? "On" : "Off"}`;
    $("auto-open").setAttribute("aria-checked", String(preferences.autoOpen));
    $("settings-status").textContent = input ? "Saved. Applies to future new sessions." : "";
  } catch (error) {
    preferences = undefined;
    $("settings-status").textContent = `${error.message || "Settings request failed."} Close and reopen Settings to retry.`;
  } finally {
    settingsBusy = false;
    $("auto-open").disabled = !preferences;
  }
}

function closeSettings(focus = false) {
  $("settings").open = false;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  if (focus) $("settings-toggle").focus();
}

async function markRead(id) {
  if (!visible() || busy || batchBusy || batchLocked() || markingRead.has(id)) return;
  const findButton = key => [...$("groups").querySelectorAll("[data-focus-key]")]
    .find(node => node.dataset.focusKey === key);
  const key = `read:${id}`;
  const index = state.groups.flatMap(group => group.items).findIndex(item => item.id === id);
  markingRead.add(id);
  renderControls();
  readError = "";
  const button = findButton(key);
  if (button) {
    button.disabled = true;
    button.textContent = "Marking...";
  }
  try {
    state = await api("read", { id });
    sound.observe(state.activity);
    const moveFocus = document.activeElement?.dataset.focusKey === key;
    render();
    if (moveFocus && visible()) {
      const remaining = state.groups.flatMap(group => group.items);
      const next = remaining[Math.min(index, remaining.length - 1)];
      (next ? findButton(`read:${next.id}`) : $("search"))?.focus();
    }
  } catch (error) {
    readError = `Could not mark the notification as read. ${error.message || "Try again."}`;
    render();
  } finally {
    markingRead.delete(id);
    renderControls();
    const current = findButton(key);
    if (current) {
      current.disabled = false;
      current.textContent = "Mark as read";
    }
  }
}

function visible() {
  return hasCapability && !stopped && !document.hidden && intersecting;
}

function batchLocked() {
  return ["prepared", "running", "stopping"].includes(state?.batch?.status);
}

function focusKey(key) {
  return [...$("groups").querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key);
}

async function batchRequest(action, input) {
  if (!visible() || batchBusy || busy) return;
  if (action === "prepare" && (busy || markingRead.size || batchLocked())) return;
  batchBusy = true;
  batchMessage = "";
  renderControls();
  try {
    state = await api(`batch/${action}`, input);
    sound.observe(state.activity);
    readError = "";
  } catch (error) {
    batchMessage = error.message || "The repository action failed. Try again.";
    readError = batchMessage;
    try {
      state = await api("state");
      sound.observe(state.activity);
    } catch {
      batchMessage += " Could not reconnect. Reopen this panel to inspect its current progress.";
    }
  } finally {
    batchBusy = false;
    render();
    if (visible() && !batchMessage) {
      if (action === "start") $("batch-progress").focus();
      if (["cancel", "dismiss"].includes(action) && !state?.batch) {
        (focusKey(batchFocusKey) ?? $("search")).focus();
      }
    }
    schedule();
  }
}

function renderBatch() {
  const batch = state?.batch;
  const dialog = $("batch-confirm");
  if (batch?.status === "prepared") {
    $("batch-confirm-title").textContent = `Mark ${batch.total} as read in ${batch.repository}?`;
    $("batch-confirm-scope").textContent = `Only these ${batch.total} shown, loaded notifications will be marked as read.${batch.searchActive ? " The captured selection matches your current search." : ""} Older unloaded items, other repositories, and arrivals after this selection was prepared are excluded. Changed notifications are skipped.`;
    $("batch-start").textContent = `Mark ${batch.total} as read`;
    if (!dialog.open && visible()) {
      dialog.showModal();
      $("batch-cancel").focus();
    }
  } else if (dialog.open) {
    dialog.close();
  }
  $("batch-dialog-error").hidden = !batchMessage;
  $("batch-dialog-error").textContent = batchMessage;
  $("batch-progress").hidden = !batch || batch.status === "prepared";
  if (!batch || batch.status === "prepared") return;
  const running = ["running", "stopping"].includes(batch.status);
  $("batch-title").textContent = `${batch.repository}: ${batch.status === "stopping" ? "Stopping after the current request" : running ? "Marking notifications as read" : "Repository action finished"}`;
  $("batch-counts").textContent = `${batch.succeeded} succeeded / ${batch.failed} failed / ${batch.skipped} skipped / ${batch.notAttempted} ${running ? "waiting" : "not attempted"}${batch.inFlight ? " / 1 in flight" : ""} (${batch.total} selected)`;
  const retryTime = batch.retryAt > Date.now() ? ` Retry after ${new Date(batch.retryAt).toLocaleTimeString()}.` : "";
  const detail = batch.error?.message ?? (batch.skipped ? "Skipped notifications were changed or no longer unread in the loaded inbox. Review their current state separately." : "");
  $("batch-error").hidden = !detail;
  $("batch-error").textContent = detail + retryTime;
  $("batch-stop").hidden = !running;
  $("batch-stop").disabled = batchBusy || busy || batch.status === "stopping";
  $("batch-retry").hidden = running || batch.failed + batch.notAttempted === 0;
  $("batch-retry").textContent = `Review remaining (${batch.failed + batch.notAttempted})`;
  $("batch-retry").disabled = batchBusy || busy || batch.retryAt > Date.now();
  $("batch-dismiss").hidden = running;
  $("batch-dismiss").disabled = batchBusy || busy;
  if ([ $("batch-stop"), $("batch-retry"), $("batch-dismiss") ].some(button =>
    button === document.activeElement && button.hidden) && visible()) $("batch-progress").focus();
}

function schedule() {
  clearTimeout(timer);
  if (visible()) timer = setTimeout(tick, batchLocked() ? 1000 : 5000);
}

async function update(path = "state", input) {
  if (busy || batchBusy || !visible()) return;
  if ((markingRead.size || batchLocked() || batchBusy) && path !== "state") return;
  busy = true;
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
  } catch (error) {
    if (!visible() && error.name === "AbortError") return;
    connectionError = error.name === "AbortError"
      ? "The canvas request timed out. Refresh to reconnect."
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
  } finally {
    busy = false;
    render();
    if (pendingQuery !== undefined && visible()) {
      const query = pendingQuery;
      pendingQuery = undefined;
      void update("filters", { query });
    } else {
      schedule();
    }
  }
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
  $("refresh").disabled = loading || Boolean(waiting);
  $("refresh").textContent = loading ? "Loading..." : "Refresh";
  $("refresh").title = waiting ? `Available ${new Date(state.nextRefreshAt).toLocaleTimeString()}` : "Refresh loaded notifications";
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const button of $("groups").querySelectorAll("button")) {
    if (!button.dataset.disclosure) button.disabled = loading || markingRead.has(button.dataset.threadId);
  }
  $("search").disabled = batchBusy || batchLocked();
  $("batch-start").disabled = batchBusy || busy;
  $("batch-cancel").disabled = batchBusy || busy;
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
    markGroup.setAttribute("aria-label", `Mark ${group.items.length} shown, loaded notifications as read in ${group.repository}`);
    markGroup.disabled = busy || markingRead.size > 0 || batchBusy || batchLocked();
    markGroup.addEventListener("click", () => {
      if (busy || batchBusy || batchLocked() || markingRead.size) return;
      batchFocusKey = markGroup.dataset.focusKey;
      return batchRequest("prepare", { repository: group.repository, selectionKey: group.selectionKey });
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
  if (focused && !$("batch-confirm").open) {
    (focusKey(focused) ?? $("search")).focus({ preventScroll: true });
  }
}

function render() {
  renderControls();
  const error = readError || state?.error?.message || connectionError;
  $("notice").hidden = !error;
  $("notice").textContent = error ? `${state?.loaded ? "Showing previously loaded notifications. " : ""}${error}` : "";
  if (!state) return;
  if (document.activeElement !== $("search") && pendingQuery === undefined) $("search").value = state.filters.query;
  $("count").textContent = `${state.matching} shown / ${state.groups.length} repositories / ${state.unread} unread loaded`;
  $("collapse").hidden = !state.groups.length;
  $("more").hidden = !state.hasMore;
  $("more").textContent = "Load more (up to 50)";
  $("coverage").textContent = `${state.loaded} notifications loaded.${state.hasMore ? " Older notifications are available." : state.lastFetchedAt ? " End of the available inbox." : ""}${state.needsRefresh ? " Refresh before loading more; pagination changed." : ""}${state.filters.query ? " Search covers loaded notifications only." : ""}`;
  renderGroups(state.groups);
  for (const time of document.querySelectorAll("time")) time.textContent = relativeTime(time.dateTime);
  $("empty").hidden = Boolean(state.groups.length);
  $("empty-title").textContent = error ? "Your inbox is unavailable" :
    state.status === "idle" || state.status === "loading" ? "Loading your inbox" :
    state.filters.query ? "No matches in loaded notifications" : "All caught up";
  $("empty-description").textContent = error ? "Resolve the message above, then refresh when the retry time arrives." :
    state.filters.query ? "Try another title or repository, or load more notifications." :
    state.status === "idle" || state.status === "loading" ? "Using your existing GitHub CLI sign-in." :
    "New notifications will appear here, grouped by repository.";
  const fetched = state.lastFetchedAt ? `Checked ${new Date(state.lastFetchedAt).toLocaleTimeString()}. ` : "";
  $("updated").textContent = `${fetched}Next refresh ${new Date(Math.max(Date.now(), state.nextRefreshAt)).toLocaleTimeString()} while visible.`;
  renderBatch();
}

$("refresh").addEventListener("click", () => update("refresh", {}));
for (const [id, action] of [["batch-start", "start"], ["batch-cancel", "cancel"], ["batch-stop", "cancel"],
  ["batch-retry", "retry"], ["batch-dismiss", "dismiss"]]) {
  $(id).addEventListener("click", () => state?.batch && batchRequest(action, { token: state.batch.token }));
}
$("batch-confirm").addEventListener("cancel", event => {
  event.preventDefault();
  if (state?.batch && !batchBusy) void batchRequest("cancel", { token: state.batch.token });
});
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
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (busy) pendingQuery = $("search").value;
    else void update("filters", { query: $("search").value });
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
  if (visible()) void tick();
  else {
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
window.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(searchTimer);
  for (const controller of requestControllers) controller.abort();
  observer.disconnect();
  void sound.close();
});
if (hasCapability) void tick();
else {
  $("notice").hidden = false;
  $("notice").textContent = "Missing canvas capability. Open this canvas from Copilot instead of browsing to its local address.";
  $("empty-title").textContent = "Open from Copilot";
  $("refresh").disabled = true;
  $("sound").disabled = true;
}
