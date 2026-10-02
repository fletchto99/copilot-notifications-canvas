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
  if (!visible() || busy || markingRead.has(id)) return;
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

function schedule() {
  clearTimeout(timer);
  if (visible()) timer = setTimeout(tick, 5000);
}

async function update(path = "state", input) {
  if (busy || !visible()) return;
  if (markingRead.size && ["refresh", "more"].includes(path)) return;
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
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderControls() {
  const loading = busy || state?.status === "loading" || markingRead.size > 0;
  const waiting = state && Date.now() < state.nextRefreshAt;
  $("refresh").disabled = loading || Boolean(waiting);
  $("refresh").textContent = loading ? "Loading..." : "Refresh";
  $("refresh").title = waiting ? `Available ${new Date(state.nextRefreshAt).toLocaleTimeString()}` : "Refresh loaded notifications";
  $("more").disabled = loading || state?.needsRefresh || Boolean(state?.error && waiting);
  for (const button of $("groups").querySelectorAll("button")) {
    button.disabled = loading || markingRead.has(button.dataset.threadId);
  }
  $("groups").setAttribute("aria-busy", String(loading));
}

function renderGroups(groups) {
  // Keep focused links and native details state stable across unchanged polls.
  const key = JSON.stringify(groups);
  if (key === listKey) return;
  listKey = key;
  const focused = document.activeElement?.dataset.focusKey;
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const details = element("details", "repo-group");
    details.open = !collapsed.has(group.repository);
    details.addEventListener("toggle", () => {
      if (details.open) collapsed.delete(group.repository);
      else collapsed.add(group.repository);
      $("collapse").textContent = [...$("groups").querySelectorAll("details")].some(node => node.open) ? "Collapse all" : "Expand all";
    });
    const summary = element("summary");
    summary.dataset.focusKey = `repo:${group.repository}`;
    summary.append(element("span", "repo-name", group.repository),
      element("span", "repo-count", `${group.items.length} / ${group.unread} unread`));
    details.append(summary);
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
      read.disabled = busy || markingRead.has(item.id);
      read.setAttribute("aria-label", `Mark as read: ${item.title || "Untitled notification"}`);
      read.addEventListener("click", () => markRead(item.id));
      row.append(dot, content, time, read);
      details.append(row);
    }
    fragment.append(details);
  }
  $("groups").replaceChildren(fragment);
  if (focused) {
    [...$("groups").querySelectorAll("[data-focus-key]")]
      .find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
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
}

$("refresh").addEventListener("click", () => update("refresh", {}));
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
  const details = [...$("groups").querySelectorAll("details")];
  const close = details.some(node => node.open);
  for (const node of details) node.open = !close;
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
