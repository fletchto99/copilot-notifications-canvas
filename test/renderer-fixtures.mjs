import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { Inbox } from "../src/inbox.mjs";
import { GitHubClient } from "../src/github.mjs";
import { desktopCapabilities } from "../src/notifier.mjs";
import { apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle } from "../src/model.mjs";
import { http, thread } from "./fixtures.mjs";

export const script = await readFile(process.env.NOTIFICATIONS_TEST_SCRIPT ??
  new URL("../src/app.mjs", import.meta.url), "utf8");
export const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
export const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
export const settle = () => new Promise(resolve => setImmediate(resolve));
export const groupActionText = button => button.parentNode.querySelectorAll(".tooltip-content")[0].textContent;
export const disabled = button => button.disabled || button.getAttribute("aria-disabled") === "true";
export const groupProgress = (ui, key) => ui.ids.get("groups").querySelectorAll(".group-progress")
  .find(node => node.dataset.groupKey === key)?.textContent;
export async function finishRows(ui) {
  await ui.inbox.batch.done;
  await runInContext("update()", ui.context);
}

// Minimal DOM/event/timer doubles exercise the actual renderer without a browser dependency.
export async function renderer({ hidden = false, token = "a".repeat(64), readFailure = false,
  initialRows, subjectStates = {}, subjectsLoading = false, onWrite, onFetch, onState, onFilters, onActionResponse, initialOffline = false, release, development = null,
  onUpdates, clipboardFailure = false, onSettings, onSubjects, developmentApi, onDevelopment, retainDisabledFocus = false, desktopPlatform = "darwin", desktopStatus = {},
  storedSettings = { autoOpen: false, darkMode: null, desktopNotifications: false, desktopSound: "default" },
  appColorMode = "light", systemDark = false, navigatorPlatform, userAgentData, onCopilot, copilotOperation } = {}) {
  const calls = [];
  const subjectSelections = [];
  let subjectSelectionVersion = 0;
  let subjectPositions = [];
  let documentFocused = true;
  const timers = new Map();
  const animationFrames = new Map();
  let timerId = 0;
  let frameId = 0;
  let intersect;
  let themeChanged;
  let themeDisconnected = false;
  let attentionResized;
  let attentionDisconnected = false;
  const attentionObserved = [];
  let now = Date.now();
  let offline = initialOffline;
  let rows = structuredClone(initialRows ?? [
    thread("1", { subject: { title: "<img src=x onerror=alert(1)>", type: "Issue", url: null } }),
  ]);
  let releaseMetadata = {
    currentVersion: "0.1.0", latestVersion: "0.1.0", status: "current", checking: false,
    checkedAt: now, nextCheckAt: now + 15 * 60_000, canCheckAt: 0, error: null,
    releaseUrl: "https://github.com/fletchto99/copilot-notifications-canvas/releases/tag/v0.1.0",
    instructionsUrl: "https://github.com/fletchto99/copilot-notifications-canvas#installation-and-updating", prompt: null,
    ...release,
  };
  const copied = [];
  const patches = [];
  const deletions = [];
  const githubCalls = [];
  const apiState = () => developmentApi ? {
    developmentApiBaseUrl: developmentApi.baseUrl,
    inboxUrl: `${apiTarget(developmentApi.baseUrl).webOrigin}/notifications`,
  } : {};
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.events = {};
      this.style = {};
      this.textContent = "";
      this.value = "";
      this._disabled = false;
      this._hidden = false;
      this.scrollLeft = 0;
      this.scrollWidth = 0;
      this.scrollHeight = 0;
      this.clientWidth = 0;
    }
    get disabled() { return this._disabled; }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (value && !retainDisabledFocus && this.contains(document.activeElement)) document.activeElement = document.body;
    }
    get hidden() { return this._hidden; }
    set hidden(value) {
      this._hidden = Boolean(value);
      if (value && this.contains(document.activeElement)) document.activeElement = document.body;
    }
    set innerHTML(_) { throw new Error("HTML interpolation is forbidden"); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) {
      delete this.attributes[key];
      if (key === "href") this.href = "";
    }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...children) {
      for (const child of children) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(node => node !== child);
        child.parentNode = this;
      }
      this.children.push(...children);
    }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    replaceChildren(fragment) {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      for (const child of this.children) child.parentNode = null;
      this.children = fragment.children;
      for (const child of this.children) child.parentNode = this;
    }
    addEventListener(name, handler) { this.events[name] = handler; }
    removeEventListener(name) { delete this.events[name]; }
    select() { this.selected = true; }
    getBoundingClientRect() {
      if (this.className === "row-link") {
        for (let node = this; node; node = node.parentNode) {
          if (node.hidden) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
        }
      }
      return this.bounds ?? { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    }
    scrollIntoView(options) { this.lastScroll = options; }
    scrollBy({ left }) {
      this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + left));
      this.events.scroll?.();
    }
    focus() {
      if (this.disabled) return;
      let node = this;
      while (node) {
        if (node.hidden) return;
        if (!node.parentNode && !node.id && !["body", "html"].includes(node.tag)) return;
        node = node.parentNode;
      }
      document.activeElement = this;
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    closest(selector) {
      for (let node = this; node; node = node.parentNode) {
        if (selector.split(",").some(part => {
          const value = part.trim();
          return node.tag === value || (value.startsWith(".") && node.className?.split(" ").includes(value.slice(1))) ||
            (value === "[contenteditable]" && node.getAttribute("contenteditable") !== null) ||
            (value === "[role=textbox]" && node.getAttribute("role") === "textbox");
        })) return node;
      }
      return null;
    }
    showModal() {
      this.open = true;
      ids.get("shortcuts-close").focus();
    }
    close() {
      this.open = false;
      this.events.close?.();
    }
    matches(selector) {
      return selector === ":focus-visible" ? this.focusVisible !== false : selector === ":hover" && this.hovered === true;
    }
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children) {
        if (child.tag === selector || (selector === "[data-focus-key]" && child.dataset.focusKey) ||
            (selector.startsWith(".") && child.className?.split(" ").includes(selector.slice(1)))) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
  }
  const ids = new Map([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => {
    const node = new Node(tag);
    node.id = id;
    return [id, node];
  }));
  const desktopLabel = new Node("span");
  desktopLabel.textContent = "Desktop notifications";
  ids.get("desktop-notifications").append(desktopLabel);
  ids.get("settings-toggle").bounds = { top: 175, bottom: 213, left: 270, right: 308, width: 38, height: 38 };
  ids.get("settings-panel").scrollHeight = 364;
  for (const [anchor, tooltip] of [
    ["inbox-control", "inbox-tooltip"], ["refresh-control", "refresh-tooltip"],
    ["shortcuts-control", "shortcuts-tooltip"], ["settings-toggle", "settings-tooltip"],
  ]) {
    ids.get(tooltip).className = "tooltip";
    ids.get(anchor).append(ids.get(tooltip));
  }
  for (const [anchorId, controlId] of [
    ["inbox-control", "open-inbox"], ["refresh-control", "force-refresh"], ["shortcuts-control", "shortcuts-toggle"],
  ]) {
    const anchor = ids.get(anchorId);
    anchor.contains = node => node === anchor || node === ids.get(controlId) || anchor.children.some(child => child.contains(node));
  }
  ids.get("batch-buttons").parentNode = ids.get("batch-progress");
  for (const id of ["batch-retry", "batch-dismiss"]) ids.get(id).parentNode = ids.get("batch-buttons");
  ids.get("batch-progress").contains = node =>
    ["batch-progress", "batch-buttons", "batch-retry", "batch-dismiss"].some(id => ids.get(id) === node);
  ids.get("settings").contains = node =>
    node === ids.get("settings") ||
    ["settings-toggle", "settings-panel", "show-notifications", "auto-open", "theme", "group-by", "copilot-integration", "copilot-confirmations", "hide-empty-tabs", "keyboard-shortcuts", "check-updates", "desktop-notifications", "desktop-sound",
      "development-api", "development-api-url", "development-api-save"].some(id => ids.get(id).contains(node));
  ids.get("copilot-dialog").contains = node => node === ids.get("copilot-dialog") ||
    ["copilot-close", "copilot-start", "copilot-skip-confirmation", "copilot-sessions"]
      .some(id => ids.get(id).contains(node));
  const document = {
    hidden,
    hasFocus: () => documentFocused,
    body: new Node("body"),
    documentElement: new Node("html"),
    events: {},
    getElementById(id) {
      return ids.get(id) ?? document.querySelectorAll("button").find(node => node.id === id) ?? null;
    },
    createElement: tag => new Node(tag),
    createElementNS: (namespace, tag) => Object.assign(new Node(tag), { namespaceURI: namespace }),
    createDocumentFragment: () => new Node("fragment"),
    querySelectorAll: selector => [...ids.values()].flatMap(node => node.querySelectorAll(selector)),
    addEventListener(name, handler) { this.events[name] = handler; },
  };
  const window = {
    innerHeight: 900,
    events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    removeEventListener(name) { delete this.events[name]; },
  };
  const inboxLink = ids.get("open-inbox");
  inboxLink.href = "";
  inboxLink.tabIndex = -1;
  inboxLink.setAttribute("aria-disabled", "true");
  ids.get("development-api-notice").hidden = true;
  const updateDetails = ids.get("update-prompt-details");
  updateDetails.contains = node =>
    ["update-prompt-details", "update-instructions", "update-prompt"].some(id => ids.get(id) === node);
  for (const id of ["update-instructions", "update-prompt"]) ids.get(id).parentNode = updateDetails;
  updateDetails.hidden = true;
  ids.get("update-details-toggle").setAttribute("aria-expanded", "false");
  if (appColorMode !== null) document.documentElement.setAttribute("data-color-mode", appColorMode);
  const media = {
    matches: systemDark, events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    removeEventListener(name) { delete this.events[name]; },
  };
  window.matchMedia = () => media;
  const inbox = new Inbox(new GitHubClient({ now: () => now, sleep: async delay => { now += delay; }, run: async args => {
    githubCalls.push(args);
    if (args.includes("PATCH") || args.includes("DELETE")) {
      const done = args.includes("DELETE");
      (done ? deletions : patches).push(args.at(-1));
      if (onWrite) return onWrite(args.at(-1), patches.length + deletions.length, done ? "DELETE" : "PATCH");
      const row = rows.find(row => args.at(-1).endsWith(`/threads/${row.id}`));
      if (row && (!readFailure || done)) {
        row.unread = false;
        if (done) row.done = true;
      }
      return readFailure && !done ? http({}, {}, 403) : `HTTP/2 ${done ? 204 : 205} Synthetic\r\n\r\n`;
    }
    const query = new URL(args.at(-1), "https://api.github.com").searchParams;
    return onFetch ? onFetch(args) : http(rows.filter(row => query.get("all") === "false" ? row.unread :
      query.get("is_done") !== "false" || !row.done));
  } }));
  const snapshot = () => {
    const state = inbox.snapshot();
    return { ...state, subjectSelectionVersion, subjectsLoading, updates: releaseMetadata, development, copilotOperation,
      copilotIntegration: storedSettings.copilotIntegration ?? true,
      confirmCopilotActions: storedSettings.confirmCopilotActions ?? true, ...apiState(),
      groups: state.groups.map(group => ({ ...group, items: group.items.map(item => {
        const subject = { ...inbox.client.subjectSnapshot(item), ...subjectStates[item.id] };
        return { ...item, ...subject,
          subjectLoading: subjectsLoading && subject.subjectState === null && !subject.subjectStateError,
        };
      }) })),
    };
  };
  const context = createContext({
    document, window, location: { hash: `#${token}` }, Intl, URL, AbortController,
    apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle,
    navigator: { platform: navigatorPlatform, userAgentData, clipboard: { writeText: async text => {
      if (clipboardFailure) throw new Error("Clipboard denied");
      copied.push(text);
    } } },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) {
      const id = frameId++;
      animationFrames.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
    IntersectionObserver: class {
      constructor(callback) { intersect = callback; }
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      constructor(callback) { themeChanged = callback; }
      observe() {}
      disconnect() { themeDisconnected = true; }
    },
    ResizeObserver: class {
      constructor(callback) { attentionResized = callback; }
      observe(node) { attentionObserved.push(node); }
      disconnect() { attentionDisconnected = true; }
    },
    fetch: async (path, options) => {
      if (offline) throw new Error("Synthetic connection failure");
      calls.push({ path, options });
      if (path === "/api/copilot") {
        copilotOperation = await onCopilot(JSON.parse(options.body));
        return { ok: true, json: async () => copilotOperation };
      }
      if (path === "/api/subjects") {
        const input = JSON.parse(options.body);
        const result = await onSubjects?.(input);
        if (result !== undefined) return { ok: true, json: async () => result };
        if (input.selectionKey !== inbox.shownSelection().selectionKey) {
          return { ok: true, json: async () => ({ status: "stale", version: subjectSelectionVersion }) };
        }
        subjectSelectionVersion = input.version;
        if (input.offset === 0) subjectPositions = [];
        assert.equal(input.offset, subjectPositions.length);
        assert.ok(input.positions.length <= 100);
        assert.ok(Buffer.byteLength(options.body) <= 4096);
        subjectPositions.push(...input.positions);
        if (input.complete) {
          const shown = inbox.shownSelection().items;
          subjectSelections.push(subjectPositions.map(position => shown[position]?.id));
        }
        return { ok: true, json: async () => ({ status: input.complete ? "complete" : "pending", version: subjectSelectionVersion }) };
      }
      if (path === "/api/settings" || path === "/api/development") {
        const input = options.body ? JSON.parse(options.body) : undefined;
        if (path === "/api/development") {
          if (onDevelopment) await onDevelopment(input);
          developmentApi.savedBaseUrl = input.baseUrl;
          developmentApi.requiresReload = input.baseUrl !== developmentApi.baseUrl;
        } else {
          if (onSettings) await onSettings(input);
          if (input) Object.assign(storedSettings, input);
        }
        const capabilities = desktopCapabilities(desktopPlatform);
        inbox.setMatchGitHubInbox(storedSettings.matchGitHubInbox ?? true);
        return { ok: true, json: async () => ({ matchGitHubInbox: true, copilotIntegration: true, confirmCopilotActions: true, hideEmptyTabs: true, keyboardShortcuts: true, desktopNotifications: false, desktopSound: "default", ...storedSettings,
          developmentApi, desktopStatus: { ...capabilities, state: "watching",
            message: capabilities.supported ? "Watching in the background." : capabilities.help, ...desktopStatus },
        }) };
      }
      if (path === "/api/updates") {
        if (onUpdates) releaseMetadata = await onUpdates();
        return { ok: true, json: async () => releaseMetadata };
      }
      if (["/api/refresh", "/api/state", "/api/more"].includes(path)) inbox.setMatchGitHubInbox(storedSettings.matchGitHubInbox ?? true);
      if (path === "/api/refresh") await inbox.refresh(JSON.parse(options.body));
      if (path === "/api/more") await inbox.more();
      if (path === "/api/state") {
        inbox.batch.acknowledge(options.headers["X-Notification-Acknowledged-Version"]);
        const state = snapshot();
        if (onState) await onState();
        return { ok: true, json: async () => state };
      }
      if (path === "/api/filters") {
        const input = JSON.parse(options.body);
        if (onFilters) await onFilters(input);
        await inbox.setFilters(input);
      }
      const rowActionToken = ["/api/read", "/api/done"].includes(path)
        ? inbox.queueThread(JSON.parse(options.body), path === "/api/done" ? "done" : "read") : undefined;
      if (path.startsWith("/api/batch/")) inbox.batch[path.slice("/api/batch/".length)](JSON.parse(options.body));
      if (onActionResponse && ["/api/read", "/api/done", "/api/batch/start"].includes(path)) {
        const state = { ...snapshot(), ...(rowActionToken ? { rowActionToken } : {}) };
        await onActionResponse(path, state);
        return { ok: true, json: async () => state };
      }
      return { ok: true, json: async () => ({ ...snapshot(), ...(rowActionToken ? { rowActionToken } : {}) }) };
    },
  });
  if (!process.env.NOTIFICATIONS_TEST_SCRIPT) assert.match(script, /^import \{ apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle \} from "\.\/model\.mjs";/);
  // Preserve source offsets for the coverage report when removing the injected import.
  runInContext(script.replace(/^import \{ apiTarget, attentionFilters, dateLabel, groupThreadsByDate, notificationTitle \} from "\.\/model\.mjs";/, match => " ".repeat(match.length)), context, {
    filename: process.env.NOTIFICATIONS_TEST_SCRIPT ?? fileURLToPath(new URL("../src/app.mjs", import.meta.url)),
  });
  await settle();
  return {
    calls, subjectSelections, document, window, ids, timers, animationFrames, context, inbox, patches, deletions, githubCalls, copied, media,
    get themeDisconnected() { return themeDisconnected; },
    attentionObserved,
    resizeAttention: () => attentionResized(),
    get attentionDisconnected() { return attentionDisconnected; },
    setAppTheme(mode) {
      if (mode === null) delete document.documentElement.attributes["data-color-mode"];
      else document.documentElement.setAttribute("data-color-mode", mode);
      themeChanged();
    },
    setSystemTheme(dark) {
      media.matches = dark;
      media.events.change?.();
    },
    advance(milliseconds = 120_000) { now += milliseconds; return now; },
    fireAnimationFrame() {
      for (const [id, callback] of [...animationFrames]) {
        animationFrames.delete(id);
        callback(now);
      }
    },
    async fireTimer(delay = 5000) {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay);
      timers.delete(id);
      await timer.fn();
      await settle();
    },
    setRows(value) { rows = value; },
    setDocumentFocused(value) { documentFocused = value; },
    setSubjectsLoading(value) { subjectsLoading = value; },
    setOffline(value) { offline = value; },
    setRelease(value) { releaseMetadata = { ...releaseMetadata, ...value }; },
    setCopilotOperation(value) { copilotOperation = value; },
    intersect: value => intersect([{ isIntersecting: value }]),
  };
}
