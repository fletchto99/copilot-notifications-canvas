import { firstPage, POLL_MS } from "./github.mjs";
import { groupThreads, InboxError, orderedThreads, validateFilters } from "./model.mjs";

export class Inbox {
  constructor(client, input = {}) {
    this.client = client;
    this.filters = { mode: "unread", query: "", ...validateFilters(input) };
    this.pages = [];
    this.busy = false;
    this.error = null;
    this.nextRefreshAt = 0;
    this.controller = new AbortController();
  }

  snapshot() {
    const items = orderedThreads(this.pages.flatMap(page => page.items));
    const groups = groupThreads(items, this.filters);
    return {
      filters: { ...this.filters },
      status: this.busy ? "loading" : this.error ? (this.pages.length ? "stale" : "error") :
        this.pages.length ? "ready" : "idle",
      error: this.error,
      loaded: items.length,
      unread: items.filter(item => item.unread).length,
      matching: groups.reduce((count, group) => count + group.items.length, 0),
      hasMore: Boolean(this.pages.at(-1)?.next),
      lastFetchedAt: this.pages.length ? Math.min(...this.pages.map(page => page.fetchedAt)) : null,
      nextRefreshAt: Math.max(this.nextRefreshAt, this.client.blockedUntil),
      groups,
    };
  }

  summary() {
    const { filters, groups, ...state } = this.snapshot();
    return { ...state, mode: filters.mode, searchActive: Boolean(filters.query), repositories: groups.length };
  }

  async execute(operation, source = "refresh") {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running. Try again when it finishes.", 409);
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

  async refresh() {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.client.now() < this.nextRefreshAt) {
      if (this.error) throw new InboxError(this.error.code, this.error.message, 503);
      return this.summary();
    }
    return this.execute(async () => {
      const pages = [];
      let next = firstPage(this.filters.mode);
      const target = Math.max(1, this.pages.length);
      while (next && pages.length < target) {
        const page = await this.client.page(next, this.controller.signal);
        pages.push(page);
        next = page.next;
      }
      this.pages = pages;
      this.nextRefreshAt = Math.max(...pages.map(page => page.nextRefreshAt));
    });
  }

  async more() {
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (!this.pages.at(-1)?.next) throw new InboxError("no_more_pages", "No more notifications to load.", 409);
    return this.execute(async () => {
      const next = this.pages.at(-1)?.next;
      const page = await this.client.page(next, this.controller.signal);
      this.pages = [...this.pages, page];
      this.nextRefreshAt = Math.max(this.nextRefreshAt, page.nextRefreshAt);
    }, "more");
  }

  async setFilters(input) {
    validateFilters(input);
    if (this.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.busy) throw new InboxError("busy", "An inbox request is already running.", 409);
    if (input.mode === undefined || input.mode === this.filters.mode) {
      this.filters = { ...this.filters, ...input };
      return this.summary();
    }
    return this.execute(async () => {
      this.filters = { ...this.filters, ...input };
      this.pages = [];
      this.nextRefreshAt = 0;
      const page = await this.client.page(firstPage(this.filters.mode), this.controller.signal);
      this.pages = [page];
      this.nextRefreshAt = page.nextRefreshAt;
    }, "filters");
  }

  close() {
    this.controller.abort();
    this.pages = [];
  }
}
