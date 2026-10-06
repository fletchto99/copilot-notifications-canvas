import { firstPage, POLL_MS } from "./github.mjs";
import { groupThreads, InboxError, orderedThreads, validateFilters } from "./model.mjs";
import { ReadBatch, selectionKey } from "./batch.mjs";

export class Inbox {
  constructor(client, input = {}) {
    this.client = client;
    this.filters = { mode: "unread", query: "", ...validateFilters(input) };
    this.pages = [];
    this.busy = false;
    this.reading = new Set();
    this.batch = new ReadBatch(this);
    this.error = null;
    this.nextRefreshAt = 0;
    this.controller = new AbortController();
    this.seenActivity = new Map();
    this.activityWatermark = null;
    this.activity = { sequence: 0, latestAt: null };
    this.needsRefresh = false;
    this.onRead = id => {
      this.pages = this.pages.map(page => ({ ...page, items: page.items.filter(item => item.id !== id) }));
      this.needsRefresh = true;
    };
    client.readListeners.add(this.onRead);
  }

  loadedItems() {
    return orderedThreads(this.pages.flatMap(page => page.items)).filter(item => item.unread);
  }

  groups() {
    return groupThreads(this.loadedItems(), this.filters).map(group =>
      ({ ...group, selectionKey: selectionKey(group, this.filters.query) }));
  }

  snapshot() {
    const items = this.loadedItems();
    const groups = this.groups();
    return {
      filters: { ...this.filters },
      status: this.busy ? "loading" : this.error ? (this.pages.length ? "stale" : "error") :
        this.pages.length ? "ready" : "idle",
      error: this.error,
      loaded: items.length,
      unread: items.filter(item => item.unread).length,
      matching: groups.reduce((count, group) => count + group.items.length, 0),
      hasMore: Boolean(this.pages.at(-1)?.next),
      needsRefresh: this.needsRefresh,
      lastFetchedAt: this.pages.length ? Math.min(...this.pages.map(page => page.fetchedAt)) : null,
      nextRefreshAt: Math.max(this.nextRefreshAt, this.client.blockedUntil),
      activity: { ...this.activity },
      batch: this.batch.snapshot(),
      groups,
    };
  }

  summary() {
    const { filters, groups, batch, ...state } = this.snapshot();
    const { repository, token, ...batchCounts } = batch ?? {};
    return { ...state, batch: batch ? batchCounts : null, mode: filters.mode, searchActive: Boolean(filters.query), repositories: groups.length };
  }

  recordActivity(pages, refresh) {
    const items = orderedThreads(pages.flatMap(page => page.items)).filter(item => item.unread);
    let watermark = this.activityWatermark;
    let newestArrival = null;
    for (const item of items) {
      const updatedAt = Date.parse(item.updatedAt);
      const previous = this.seenActivity.get(item.id) ?? -Infinity;
      if (refresh && this.activityWatermark !== null &&
          updatedAt > this.activityWatermark && updatedAt > previous) {
        newestArrival = Math.max(newestArrival ?? updatedAt, updatedAt);
      }
      this.seenActivity.set(item.id, Math.max(previous, updatedAt));
      watermark = Math.max(watermark ?? updatedAt, updatedAt);
    }
    // An empty first inbox starts at observation time, not at the beginning of history.
    this.activityWatermark = watermark ?? this.client.now();
    if (newestArrival !== null) {
      this.activity = { sequence: this.activity.sequence + 1, latestAt: newestArrival };
    }
  }

  async execute(operation, source = "refresh") {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running. Try again when it finishes.", 409);
    if (this.batch.locked) throw new InboxError("busy", "Finish or cancel the repository batch first.", 409);
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
      this.nextRefreshAt = Math.max(this.client.now() + POLL_MS, this.client.blockedUntil);
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
    if (this.batch.locked) throw new InboxError("busy", "Finish or cancel the repository batch first.", 409);
    if (!input.force && this.client.now() < this.nextRefreshAt) {
      if (this.error) throw new InboxError(this.error.code, this.error.message, 503);
      return this.summary();
    }
    return this.execute(async () => {
      const revision = this.client.revision;
      const pages = [];
      let next = firstPage();
      const target = Math.max(1, this.pages.length);
      while (next && pages.length < target) {
        const page = await this.client.page(next, this.controller.signal, { force: input.force });
        pages.push(page);
        next = page.next;
      }
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while refreshing. The next automatic refresh will reconcile it.", 409);
      this.recordActivity(pages, true);
      this.pages = pages;
      this.needsRefresh = false;
      this.nextRefreshAt = Math.max(...pages.map(page => page.nextRefreshAt));
    });
  }

  async more() {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.needsRefresh) throw new InboxError("refresh_required", "Refresh notifications before loading more after marking a notification read.", 409);
    if (!this.pages.at(-1)?.next) throw new InboxError("no_more_pages", "No more notifications to load.", 409);
    return this.execute(async () => {
      const revision = this.client.revision;
      const next = this.pages.at(-1)?.next;
      const page = await this.client.page(next, this.controller.signal);
      if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
      if (revision !== this.client.revision) throw new InboxError("inbox_changed", "The inbox changed while loading. Try loading more again.", 409);
      this.recordActivity([page], false);
      this.pages = [...this.pages, page];
      this.nextRefreshAt = Math.max(this.nextRefreshAt, page.nextRefreshAt);
    }, "more");
  }

  async setFilters(input) {
    validateFilters(input);
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running.", 409);
    if (this.batch.locked) throw new InboxError("busy", "Finish or cancel the repository batch before changing search.", 409);
    this.filters = { ...this.filters, ...input };
    return this.summary();
  }

  async markRead(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.id !== "string" ||
        !/^[1-9]\d{0,63}$/.test(input.id)) {
      throw new InboxError("invalid_thread", "Choose one valid notification to mark as read.", 400);
    }
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "Wait for the current inbox request to finish.", 409);
    if (this.batch.locked) throw new InboxError("busy", "Finish or cancel the repository batch first.", 409);
    if (this.reading.has(input.id)) throw new InboxError("busy", "This notification is already being marked as read.", 409);
    if (!this.pages.some(page => page.items.some(item => item.id === input.id && item.unread))) {
      throw new InboxError("unknown_thread", "This notification is no longer in the loaded inbox. Let the view update automatically before trying again.", 404);
    }
    this.reading.add(input.id);
    try {
      await this.client.markRead(input.id, this.controller.signal);
    } finally {
      this.reading.delete(input.id);
    }
    return this.summary();
  }

  close() {
    this.controller.abort();
    this.batch.close();
    this.pages = [];
    this.seenActivity.clear();
    this.client.readListeners.delete(this.onRead);
  }
}
