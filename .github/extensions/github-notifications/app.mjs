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
let requestController;
let connectionError = "";

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
  requestController = new AbortController();
  const timeout = setTimeout(() => requestController?.abort(), 35_000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: requestController.signal,
      credentials: "omit",
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? `Canvas returned HTTP ${response.status}.`);
    return result;
  } finally {
    clearTimeout(timeout);
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
  busy = true;
  renderControls();
  try {
    state = await api(path, input);
    connectionError = "";
  } catch (error) {
    if (!visible() && error.name === "AbortError") return;
    connectionError = error.name === "AbortError"
      ? "The canvas request timed out. Refresh to reconnect."
      : error.message || "The local canvas disconnected. Reopen it to reconnect.";
    if (path !== "state" && visible()) {
      try {
        state = await api("state");
      } catch {
        connectionError = "The local canvas disconnected. Reopen it to reconnect.";
      }
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
  if (!state || (state.status !== "loading" && Date.now() >= state.nextRefreshAt)) {
    await update("refresh", {});
  } else {
    await update();
  }
}

function renderControls() {
  const loading = busy || state?.status === "loading";
  const waiting = state && Date.now() < state.nextRefreshAt;
  $("refresh").disabled = loading || Boolean(waiting);
  $("refresh").textContent = loading ? "Loading..." : "Refresh";
  $("refresh").title = waiting ? `Available ${new Date(state.nextRefreshAt).toLocaleTimeString()}` : "Refresh loaded notifications";
  for (const mode of ["all", "unread"]) {
    $(mode).disabled = loading;
    $(mode).setAttribute("aria-pressed", String((state?.filters.mode ?? "unread") === mode));
  }
  $("more").disabled = loading || Boolean(state?.error && waiting);
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
      $("collapse").textContent = [...document.querySelectorAll("details")].some(node => node.open) ? "Collapse all" : "Expand all";
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
      row.append(dot, content, time);
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
  const error = state?.error?.message || connectionError;
  $("notice").hidden = !error;
  $("notice").textContent = error ? `${state?.loaded ? "Showing previously loaded notifications. " : ""}${error}` : "";
  if (!state) return;
  $("api-limit").hidden = state.filters.mode !== "all";
  if (document.activeElement !== $("search") && pendingQuery === undefined) $("search").value = state.filters.query;
  $("count").textContent = `${state.matching} shown / ${state.groups.length} repositories / ${state.unread} unread loaded`;
  $("collapse").hidden = !state.groups.length;
  $("more").hidden = !state.hasMore;
  $("more").textContent = "Load more (up to 50)";
  $("coverage").textContent = `${state.loaded} notifications loaded.${state.hasMore ? " Older notifications are available." : state.lastFetchedAt ? " End of the available inbox." : ""}${state.filters.query ? " Search covers loaded notifications only." : ""}`;
  renderGroups(state.groups);
  for (const time of document.querySelectorAll("time")) time.textContent = relativeTime(time.dateTime);
  $("empty").hidden = Boolean(state.groups.length);
  $("empty-title").textContent = error ? "Your inbox is unavailable" :
    state.status === "idle" || state.status === "loading" ? "Loading your inbox" :
    state.filters.query ? "No matches in loaded notifications" :
    state.filters.mode === "unread" ? "All caught up" : "Your inbox is clear";
  $("empty-description").textContent = error ? "Resolve the message above, then refresh when the retry time arrives." :
    state.filters.query ? "Try another title or repository, or load more notifications." :
    state.status === "idle" || state.status === "loading" ? "Using your existing GitHub CLI sign-in." :
    "New notifications will appear here, grouped by repository.";
  const fetched = state.lastFetchedAt ? `Checked ${new Date(state.lastFetchedAt).toLocaleTimeString()}. ` : "";
  $("updated").textContent = `${fetched}Next refresh ${new Date(Math.max(Date.now(), state.nextRefreshAt)).toLocaleTimeString()} while visible.`;
}

$("refresh").addEventListener("click", () => update("refresh", {}));
$("more").addEventListener("click", () => update("more", {}));
for (const mode of ["all", "unread"]) $(mode).addEventListener("click", () => update("filters", { mode }));
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (busy) pendingQuery = $("search").value;
    else void update("filters", { query: $("search").value });
  }, 250);
});
$("collapse").addEventListener("click", () => {
  const details = [...document.querySelectorAll("details")];
  const close = details.some(node => node.open);
  for (const node of details) node.open = !close;
  $("collapse").textContent = close ? "Expand all" : "Collapse all";
});
function visibilityChanged() {
  clearTimeout(timer);
  if (visible()) void tick();
  else requestController?.abort();
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
  requestController?.abort();
  observer.disconnect();
});
if (hasCapability) void tick();
else {
  $("notice").hidden = false;
  $("notice").textContent = "Missing canvas capability. Open this canvas from Copilot instead of browsing to its local address.";
  $("empty-title").textContent = "Open from Copilot";
  $("refresh").disabled = true;
}
