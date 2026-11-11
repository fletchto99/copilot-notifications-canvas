import { firstPage, RETRY_MS } from "./github.mjs";
import { attentionCounts, filterThreads, groupThreads, groupThreadsByDate, InboxError, refinementFilters, sharedFilters, uniqueThreads, validateFilters, validFilterDefaults } from "../shared/model.mjs";
import { NotificationBatch, selectionKey } from "./batch.mjs";

function normalizeFilters(input) {
  const { mode, ...filters } = validateFilters(input);
  if (filters.readState === undefined && mode !== undefined) {
    filters.readState = mode === "unread" ? "unread" : "all";
  }
  return filters;
}

export class Inbox {
  constructor(client, input = {}) {
    this.client = client;
    const filters = normalizeFilters(input);
    this.filters = { query: "", attention: "all", readState: "all", ...filters };
    this.initializedRefinements = new Set(refinementFilters.filter(({ key }) => filters[key] !== undefined).map(({ key }) => key));
    this.settingsRevision = 0;
    this.sharedFiltersKey = undefined;
    this.pages = [];
    this.busy = false;
    this.snapshotVersion = 0;
    this.batch = new NotificationBatch(this);
    this.error = null;
    this.settingsError = null;
    this.nextRefreshAt = 0;
    this.controller = new AbortController();
    this.needsRefresh = false;
    this.onThreadUpdated = (id, action = "done") => {
      this.pages = this.pages.map(page => ({
        ...page,
        items: page.items.flatMap(item => item.id !== id ? [item] : action === "read" ? [{ ...item, unread: false }] : []),
      }));
      this.batch.clearRowResults(id);
      this.needsRefresh = true;
    };
    client.threadListeners.add(this.onThreadUpdated);
  }

  loadedItems() {
    const sequences = new Map(this.pages.flatMap(page => page.items.map(item => [item, page.sequence])));
    return uniqueThreads([...sequences.keys()], (a, b) =>
      sequences.get(a) - sequences.get(b) || a.updatedAt.localeCompare(b.updatedAt));
  }

  applySettings({ matchGitHubInbox = true, filterDefaults, revision = 0 }, forceFilters = false) {
    if (typeof matchGitHubInbox !== "boolean") throw new InboxError("invalid_settings", "The legacy notification view preference must be a boolean.", 400);
    if (filterDefaults !== undefined && !validFilterDefaults(filterDefaults)) {
      throw new InboxError("invalid_settings", "Saved filter defaults must contain only supported type, readState, reason and age values.", 400);
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new InboxError("invalid_settings", "The settings revision must be a nonnegative safe integer.", 400);
    }
    if (revision < this.settingsRevision) return false;
    this.settingsError = null;
    const shared = sharedFilters({ matchGitHubInbox, filterDefaults });
    const key = JSON.stringify(shared);
    if (forceFilters || this.sharedFiltersKey !== undefined &&
        (key !== this.sharedFiltersKey || revision > this.settingsRevision)) {
      this.filters = { ...this.filters, ...shared };
    } else if (this.sharedFiltersKey === undefined) {
      const defaults = filterDefaults ?? { readState: matchGitHubInbox ? "all" : "unread" };
      this.filters = { ...this.filters, ...Object.fromEntries(refinementFilters
        .filter(({ key }) => !this.initializedRefinements.has(key) && Object.hasOwn(defaults, key))
        .map(({ key }) => [key, defaults[key]])) };
    }
    this.settingsRevision = revision;
    this.sharedFiltersKey = key;
    for (const { key } of refinementFilters) this.initializedRefinements.add(key);
    return true;
  }

  async syncSettings(preferences) {
    const revision = this.settingsRevision;
    try {
      const settings = await preferences.read();
      if (this.applySettings(settings)) return settings;
    } catch (error) {
      if (!(error instanceof InboxError) || error.code !== "settings_read") throw error;
      if (revision === this.settingsRevision) this.settingsError = { code: error.code, message: error.message };
    }
  }

  groups(items = this.loadedItems(), now = this.client.now()) {
    const positions = new Map(items.map((item, index) => [item.id, index]));
    return groupThreads(items.map(item => ({ ...item, ...this.client.authorshipSnapshot(item) })), this.filters, now).map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, apiPosition: positions.get(item.id) })),
      selectionKey: selectionKey(group, this.filters),
    }));
  }

  shownSelection(groups = this.groups()) {
    const selection = { repository: null, items: groups.flatMap(group => group.items)
      .sort((a, b) => a.apiPosition - b.apiPosition) };
    return { ...selection, selectionKey: selectionKey(selection, this.filters) };
  }

  dateSelection(date, timeZone) {
    const shown = this.shownSelection();
    const group = groupThreadsByDate(shown.items, timeZone).find(group => group.date === date);
    // Bind the date subset to the same filtered snapshot the renderer used.
    return group ? { ...group, repository: null, selectionKey: shown.selectionKey } : undefined;
  }

  snapshot() {
    const items = this.loadedItems();
    const now = this.client.now();
    const groups = this.groups(items, now);
    const snapshotVersion = ++this.snapshotVersion;
    const batches = this.batch.snapshots(items, groups, snapshotVersion);
    const authoredItems = filterThreads(items.map(item => ({ ...item, ...this.client.authorshipSnapshot(item) })),
      { ...this.filters, query: "" }, now);
    return {
      snapshotVersion,
      settingsRevision: this.settingsRevision,
      filters: { ...this.filters },
      status: this.busy ? "loading" : this.error ? (this.pages.length ? "stale" : "error") :
        this.pages.length ? "ready" : "idle",
      error: this.error,
      settingsError: this.settingsError,
      loaded: items.length,
      unread: items.filter(item => item.unread).length,
      matching: groups.reduce((count, group) => count + group.items.length, 0),
      selectionKey: this.shownSelection(groups).selectionKey,
      attentionCounts: attentionCounts(authoredItems),
      authorship: {
        pending: authoredItems.filter(item => item.mine === null && !item.authorshipError).length,
        unavailable: authoredItems.filter(item => item.mine === null && item.authorshipError).length,
      },
      hasMore: Boolean(this.pages.at(-1)?.next),
      needsRefresh: this.needsRefresh,
      lastFetchedAt: this.pages.length ? Math.min(...this.pages.map(page => page.fetchedAt)) : null,
      nextRefreshAt: Math.max(this.nextRefreshAt, this.client.blockedUntil),
      retryAt: this.client.blockedUntil,
      batch: batches.at(-1) ?? null,
      batches,
      lockedThreadIds: [...new Set([...this.client.pendingThreads, ...this.client.threadReservations.keys()])],
      threadWrites: [...this.client.threadWrites.values()].map(write => ({ ...write })),
      groups,
    };
  }

  summary() {
    const { filters, groups, batch, batches, lockedThreadIds, threadWrites, snapshotVersion, selectionKey, ...state } = this.snapshot();
    const counts = ({ repository, token, date, timeZone, threadId, remainingThreadIds, retryableThreadIds, retrySelectionKey, ...batchCounts }) => batchCounts;
    const operations = batches.filter(batch => batch.scope !== "thread" || batch.status !== "completed");
    return { ...state, batch: operations.length ? counts(operations.at(-1)) : null, batches: operations.map(counts),
      mode: filters.readState === "unread" ? "unread" : "inbox", readState: filters.readState, attention: filters.attention,
      searchActive: Boolean(filters.query),
      refinementsActive: refinementFilters.some(({ key }) => filters[key] !== undefined && filters[key] !== "all"),
      repositories: groups.length };
  }

  async execute(operation, source = "refresh") {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running. Try again when it finishes.", 409);
    if (this.batch.locked) throw new InboxError("busy", "Wait for the current batches to finish.", 409);
    this.busy = true;
    try {
      await operation();
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (source !== "more" || this.errorSource === source) this.error = null;
    } catch (error) {
      this.error = error instanceof InboxError
        ? { code: error.code, message: error.message }
        : { code: "internal_error", message: "An unexpected inbox error occurred. Inspect the extension log." };
      this.errorSource = source;
      const now = this.client.now();
      this.nextRefreshAt = this.client.blockedUntil > now ? this.client.blockedUntil : now + RETRY_MS;
      throw error;
    } finally {
      if (this.controller.signal.aborted) this.pages = [];
      this.busy = false;
    }
    return this.summary();
  }

  async refresh(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => key !== "force") ||
        (input.force !== undefined && typeof input.force !== "boolean")) {
      throw new InboxError("invalid_input", "Refresh accepts only an optional force boolean.", 400);
    }
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.batch.locked) throw new InboxError("busy", "Wait for the current batches to finish.", 409);
    if (!input.force && this.client.now() < this.nextRefreshAt) {
      if (this.error) throw new InboxError(this.error.code, this.error.message, 503);
      return this.summary();
    }
    return this.execute(async () => {
      const revision = this.client.revision;
      const pages = [];
      let next = firstPage({ mode: "inbox" });
      const target = Math.max(1, this.pages.length);
      while (next && pages.length < target) {
        const page = await this.client.page(next, this.controller.signal, { force: input.force });
        pages.push(page);
        next = page.next;
      }
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while refreshing. The next automatic refresh will reconcile it.", 409);
      this.pages = pages;
      this.batch.clearRowResults();
      this.needsRefresh = pages.some(page => page.invalidated);
      this.nextRefreshAt = Math.max(...pages.map(page => page.nextRefreshAt));
    });
  }

  async more() {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.needsRefresh) {
      throw new InboxError("refresh_required", "Refresh notifications before loading more after changing the inbox.", 409);
    }
    if (!this.pages.at(-1)?.next) throw new InboxError("no_more_pages", "No more notifications to load.", 409);
    return this.execute(async () => {
      const revision = this.client.revision;
      const next = this.pages.at(-1)?.next;
      const page = await this.client.page(next, this.controller.signal);
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while loading. Try loading more again.", 409);
      if (page.invalidated) {
        this.needsRefresh = true;
        throw new InboxError("refresh_required", "GitHub has not revalidated this page after an inbox update. Refresh notifications before loading more.", 409);
      }
      this.pages = [...this.pages, page];
      this.nextRefreshAt = Math.max(this.nextRefreshAt, page.nextRefreshAt);
    }, "more");
  }

  #filterInput(input) {
    const filters = normalizeFilters(input);
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running.", 409);
    return filters;
  }

  async syncFilters(input, preferences) {
    const filters = this.#filterInput(input);
    const changes = Object.fromEntries(refinementFilters
      .filter(({ key }) => Object.hasOwn(filters, key)).map(({ key }) => [key, filters[key]]));
    if (!Object.keys(changes).length) return this.setFilters(input);
    if (!preferences) throw new InboxError("settings_unavailable", "Shared notification filter settings are unavailable.", 503);
    const settings = await preferences.updateFilters(changes);
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed after saving shared filters.", 410);
    this.applySettings(settings, true);
    for (const key of ["query", "attention"]) {
      if (filters[key] !== undefined) this.filters = { ...this.filters, [key]: filters[key] };
    }
    return this.summary();
  }

  async setFilters(input) {
    const filters = this.#filterInput(input);
    for (const { key } of refinementFilters) {
      if (filters[key] !== undefined) this.initializedRefinements.add(key);
    }
    this.filters = { ...this.filters, ...filters };
    return this.summary();
  }

  queueThread(input, action) {
    const item = this.#thread(input, action);
    const token = this.batch.launch(item.repository, [item], action, "thread");
    this.batch.clearRowResults(item.id, token);
    return token;
  }

  #thread(input, action) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.id !== "string" ||
        !/^[1-9]\d{0,63}$/.test(input.id)) {
      throw new InboxError("invalid_thread", "Choose one valid notification to mark as read or done.", 400);
    }
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "Wait for the current inbox request to finish.", 409);
    const item = this.loadedItems().find(item => item.id === input.id && (action === "done" || item.unread));
    if (!item) {
      throw new InboxError("unknown_thread", "This notification is no longer in the loaded inbox. Let the view update automatically before trying again.", 404);
    }
    return item;
  }

  close() {
    this.controller.abort();
    this.batch.close();
    this.pages = [];
    this.client.threadListeners.delete(this.onThreadUpdated);
  }
}
