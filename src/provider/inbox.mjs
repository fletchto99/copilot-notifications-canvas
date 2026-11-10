import { firstPage, RETRY_MS } from "./github.mjs";
import { attentionCounts, groupThreads, groupThreadsByDate, InboxError, uniqueThreads, validateFilters } from "../shared/model.mjs";
import { NotificationBatch, selectionKey } from "./batch.mjs";

export class Inbox {
  constructor(client, input = {}) {
    this.client = client;
    this.filters = { mode: "inbox", query: "", attention: "all", ...validateFilters(input) };
    this.matchGitHubInbox = true;
    this.requestedMatchGitHubInbox = true;
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
      const retain = this.filters.mode === "inbox" && this.matchGitHubInbox && action === "read";
      this.pages = this.pages.map(page => ({
        ...page,
        items: page.items.flatMap(item => item.id !== id ? [item] : retain ? [{ ...item, unread: false }] : []),
      }));
      this.batch.clearRowResults(id);
      this.needsRefresh = true;
    };
    client.threadListeners.add(this.onThreadUpdated);
  }

  loadedItems() {
    const sequences = new Map(this.pages.flatMap(page => page.items.map(item => [item, page.sequence])));
    return uniqueThreads([...sequences.keys()], (a, b) =>
      sequences.get(a) - sequences.get(b) || a.updatedAt.localeCompare(b.updatedAt))
      .filter(item => this.filters.mode === "inbox" && this.matchGitHubInbox || item.unread);
  }

  setMatchGitHubInbox(value) {
    if (typeof value !== "boolean") throw new InboxError("invalid_settings", "The notification view preference must be a boolean.", 400);
    this.settingsError = null;
    if (value === this.requestedMatchGitHubInbox) return;
    this.requestedMatchGitHubInbox = value;
    if (this.viewChanged) this.nextRefreshAt = 0;
  }

  get viewChanged() {
    return firstPage({ mode: this.filters.mode, matchGitHubInbox: this.matchGitHubInbox }) !==
      firstPage({ mode: this.filters.mode, matchGitHubInbox: this.requestedMatchGitHubInbox });
  }

  async syncSettings(preferences) {
    try {
      const settings = await preferences.read();
      this.setMatchGitHubInbox(settings.matchGitHubInbox);
      return settings;
    } catch (error) {
      if (!(error instanceof InboxError) || error.code !== "settings_read") throw error;
      this.settingsError = { code: error.code, message: error.message };
    }
  }

  groups(items = this.loadedItems()) {
    const positions = new Map(items.map((item, index) => [item.id, index]));
    return groupThreads(items.map(item => ({ ...item, ...this.client.authorshipSnapshot(item) })), this.filters).map(group => ({
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
    const groups = this.groups(items);
    const snapshotVersion = ++this.snapshotVersion;
    const batches = this.batch.snapshots(items, groups, snapshotVersion);
    const authoredItems = items.map(item => ({ ...item, ...this.client.authorshipSnapshot(item) }));
    return {
      snapshotVersion,
      filters: { ...this.filters },
      matchGitHubInbox: this.matchGitHubInbox,
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
      needsRefresh: this.needsRefresh || this.viewChanged,
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
    const counts = ({ repository, token, date, timeZone, threadId, remainingThreadIds, retryableThreadIds, ...batchCounts }) => batchCounts;
    const operations = batches.filter(batch => batch.scope !== "thread" || batch.status !== "completed");
    return { ...state, batch: operations.length ? counts(operations.at(-1)) : null, batches: operations.map(counts), mode: filters.mode, attention: filters.attention,
      searchActive: Boolean(filters.query), repositories: groups.length };
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
      const matchGitHubInbox = this.requestedMatchGitHubInbox;
      const pages = [];
      let next = firstPage({ mode: this.filters.mode, matchGitHubInbox });
      const target = this.viewChanged ? 1 : Math.max(1, this.pages.length);
      while (next && pages.length < target) {
        const page = await this.client.page(next, this.controller.signal, { force: input.force });
        pages.push(page);
        next = page.next;
      }
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while refreshing. The next automatic refresh will reconcile it.", 409);
      this.pages = pages;
      this.batch.clearRowResults();
      this.matchGitHubInbox = matchGitHubInbox;
      this.needsRefresh = pages.some(page => page.invalidated);
      this.nextRefreshAt = this.viewChanged ? 0 : Math.max(...pages.map(page => page.nextRefreshAt));
    });
  }

  async more() {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.needsRefresh || this.viewChanged) {
      throw new InboxError("refresh_required", "Refresh notifications before loading more after changing the inbox or notification view.", 409);
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

  async setFilters(input) {
    validateFilters(input);
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running.", 409);
    if (input.mode !== undefined && input.mode !== this.filters.mode) {
      return this.execute(async () => {
        const revision = this.client.revision;
        const matchGitHubInbox = this.requestedMatchGitHubInbox;
        const page = await this.client.page(firstPage({ mode: input.mode, matchGitHubInbox }), this.controller.signal);
        if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
        if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while switching views. Try again.", 409);
        this.filters = { ...this.filters, ...input };
        this.pages = [page];
        this.matchGitHubInbox = matchGitHubInbox;
        this.needsRefresh = Boolean(page.invalidated);
        this.nextRefreshAt = this.viewChanged ? 0 : page.nextRefreshAt;
      });
    }
    this.filters = { ...this.filters, ...input };
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
