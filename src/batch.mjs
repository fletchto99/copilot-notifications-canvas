import { createHash, randomUUID } from "node:crypto";
import { InboxError, uniqueThreads } from "./model.mjs";

export function selectionKey(group, filters) {
  return createHash("sha256").update(JSON.stringify([
    group.repository, filters.mode, filters.query, filters.attention,
    group.items.map(item => [item.id, item.updatedAt, item.repository, item.unread]),
  ])).digest("hex");
}

function fields(input, keys, optional = []) {
  return input && typeof input === "object" && !Array.isArray(input) &&
    keys.every(key => Object.hasOwn(input, key)) &&
    Object.keys(input).every(key => keys.includes(key) || optional.includes(key));
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export class NotificationBatch {
  constructor(inbox) {
    this.inbox = inbox;
    this.operations = new Map();
    this.running = new Set();
    this.disposed = false;
  }

  get locked() {
    return [...this.operations.values()].some(operation => this.isRunning(operation));
  }

  get done() {
    return Promise.all(this.running);
  }

  isRunning(operation) {
    return ["running", "stopping"].includes(operation.status);
  }

  assertAvailable() {
    if (this.disposed) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.inbox.busy) {
      throw new InboxError("busy", "Wait for the current inbox operation to finish.", 409);
    }
  }

  identify(input) {
    if (!fields(input, ["token"]) || typeof input.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.token)) {
      throw new InboxError("invalid_batch", "Use the current notification operation token.", 400);
    }
    const operation = this.operations.get(input.token);
    if (!operation) {
      throw new InboxError("unknown_batch", "This notification operation is no longer available. Review the updated view and try again.", 409);
    }
    return operation;
  }

  start(input) {
    this.assertAvailable();
    const shown = input?.scope === "shown";
    const dated = input?.scope === "date";
    const required = dated ? ["scope", "date", "timeZone", "selectionKey"] :
      shown ? ["scope", "selectionKey"] : ["repository", "selectionKey"];
    if (!fields(input, required, ["action"]) ||
        (Object.hasOwn(input, "action") && !["read", "done"].includes(input.action)) ||
        (!shown && !dated && (typeof input.repository !== "string" || input.repository.length > 256)) ||
        (dated && (!validDate(input.date) || typeof input.timeZone !== "string" || !input.timeZone || input.timeZone.length > 128)) ||
        typeof input.selectionKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.selectionKey)) {
      throw new InboxError("invalid_selection", "Choose currently shown notifications and a read or done action.", 400);
    }
    const selection = dated ? this.inbox.dateSelection(input.date, input.timeZone) : shown ? this.inbox.shownSelection() :
      this.inbox.groups().find(item => item.repository === input.repository);
    if (!selection || selection.selectionKey !== input.selectionKey) {
      throw new InboxError("selection_changed", "The shown selection changed. Review its updated count and try again.", 409);
    }
    const action = input.action ?? "read";
    const items = selection.items.filter(item => action === "done" || item.unread);
    this.launch(selection.repository, items, action, dated ? "date" : shown ? "shown" : "repository", input, selection.items);
  }

  launch(repository, items, action = "read", scope = "repository", { date, timeZone } = {}, lockedItems = items) {
    if (!items.length || items.some(item => !/^[1-9]\d{0,63}$/.test(item.id)) ||
        new Set(items.map(item => item.id)).size !== items.length) {
      throw new InboxError("invalid_selection", "The selected group contains no eligible notifications or invalid thread IDs.", 400);
    }
    if (this.inbox.client.now() < this.inbox.client.blockedUntil) {
      throw this.inbox.client.lastError ??
        new InboxError("rate_limited", "GitHub requests are paused until the rate limit resets.", 429);
    }
    const owner = this.inbox.client.reserveThreads(lockedItems.map(item => item.id));
    const operation = {
      token: randomUUID(), repository, scope, action, status: "running",
      ...(scope === "date" ? { date, timeZone } : {}),
      searchActive: Boolean(this.inbox.filters.query.trim()),
      items: items.map(({ id, updatedAt, repository, unread }) => ({ id, updatedAt, repository, unread, result: "pending" })),
      inFlight: false, cancelled: false, error: null, owner, controller: new AbortController(),
    };
    this.operations.set(operation.token, operation);
    const done = this.run(operation);
    this.running.add(done);
    void done.finally(() => this.running.delete(done));
    return operation.token;
  }

  eligible(operation, item) {
    const current = this.inbox.loadedItems().find(row => row.id === item.id);
    if (!current || current.repository !== item.repository || current.updatedAt !== item.updatedAt ||
        current.unread !== item.unread || (operation.action === "read" && !current.unread) ||
        (operation.scope === "repository" && current.repository !== operation.repository)) return false;
    const sequence = this.inbox.pages.find(page => page.items.includes(current)).sequence;
    // Other views can retain older read states. Only newer responses can invalidate this selection.
    for (const page of this.inbox.client.cache.values()) {
      if (page.sequence < sequence) continue;
      if (uniqueThreads(page.items).some(row => row.id === item.id &&
          (row.unread !== item.unread || row.repository !== item.repository || row.updatedAt > item.updatedAt))) return false;
    }
    return true;
  }

  async run(operation) {
    const signal = AbortSignal.any([this.inbox.controller.signal, operation.controller.signal]);
    try {
      for (const item of operation.items) {
        if (operation.cancelled || signal.aborted) break;
        try {
          if (!this.eligible(operation, item)) {
            item.result = "skipped";
            continue;
          }
          const method = operation.action === "done" ? "markDone" : "markRead";
          await this.inbox.client[method](item.id, signal, {
            owner: operation.owner,
            beforeWrite: () => {
              if (operation.cancelled || signal.aborted) throw new InboxError("batch_cancelled", "Remaining work was cancelled.", 409);
              if (!this.eligible(operation, item)) throw new InboxError("selection_changed", "A selected notification changed.", 409);
              operation.inFlight = true;
            },
          });
          item.result = "succeeded";
        } catch (error) {
          if (error instanceof InboxError && error.code === "selection_changed") {
            item.result = "skipped";
            continue;
          }
          if ((operation.cancelled || signal.aborted) && !operation.inFlight) break;
          if (operation.inFlight) item.result = "failed";
          operation.error = error instanceof InboxError
            ? { code: error.code, message: error.message }
            : { code: "batch_failed", message: "An unexpected batch error occurred. Wait for the next automatic refresh before retrying remaining notifications." };
          if (signal.aborted && operation.inFlight) {
            operation.error = { code: "result_unknown", message: "The in-flight request was interrupted. GitHub may have applied it; wait for the next automatic refresh or reopen the canvas before retrying." };
          }
          break;
        } finally {
          operation.inFlight = false;
        }
      }
      operation.status = operation.items.every(item => item.result === "succeeded") ? "completed" :
        operation.cancelled || signal.aborted ? "cancelled" : "partial";
    } finally {
      this.inbox.client.releaseThreads(operation.owner);
      if (this.disposed || operation.status === "completed") this.operations.delete(operation.token);
    }
  }

  cancel(input) {
    const operation = this.identify(input);
    if (["running", "stopping"].includes(operation.status)) {
      operation.cancelled = true;
      operation.status = "stopping";
      // Let an already-sent request report its outcome; cancel queued and not-yet-sent work.
      if (!operation.inFlight) operation.controller.abort();
    }
  }

  retry(input) {
    this.assertAvailable();
    const operation = this.identify(input);
    if (this.isRunning(operation)) throw new InboxError("busy", "Wait for this batch to finish before retrying it.", 409);
    const remaining = this.retryItems(operation);
    if (!remaining.length) {
      throw new InboxError("no_remaining", "No unchanged, shown notifications remain from this batch. Wait for the next automatic refresh, then review the current selection.", 409);
    }
    this.launch(operation.repository, remaining, operation.action, operation.scope, operation);
    this.operations.delete(operation.token);
  }

  retryItems(operation) {
    const selection = operation.scope === "date" ? this.inbox.dateSelection(operation.date, operation.timeZone) :
      ["shown", "thread"].includes(operation.scope) ? this.inbox.shownSelection() :
      this.inbox.groups().find(group => group.repository === operation.repository);
    const shown = new Set(selection?.items.map(item => item.id));
    return operation.items.filter(item => ["pending", "failed"].includes(item.result) &&
      shown.has(item.id) && this.eligible(operation, item));
  }

  clearRowResults(id, exceptToken) {
    for (const operation of this.operations.values()) {
      if (operation.token !== exceptToken && operation.scope === "thread" && !this.isRunning(operation) &&
          (id === undefined || operation.items[0].id === id)) this.operations.delete(operation.token);
    }
  }

  dismiss(input) {
    this.assertAvailable();
    const operation = this.identify(input);
    if (this.isRunning(operation)) throw new InboxError("busy", "Wait for this batch to finish before dismissing it.", 409);
    this.operations.delete(operation.token);
  }

  snapshot(operation = [...this.operations.values()].at(-1)) {
    if (!operation) return null;
    const count = result => operation.items.filter(item => item.result === result).length;
    return {
      token: operation.token, repository: operation.repository, scope: operation.scope, action: operation.action, status: operation.status,
      ...(operation.scope === "date" ? { date: operation.date, timeZone: operation.timeZone } : {}),
      ...(operation.scope === "thread" ? { threadId: operation.items[0].id } : {}),
      total: operation.items.length, succeeded: count("succeeded"), failed: count("failed"),
      skipped: count("skipped"), notAttempted: count("pending") - Number(operation.inFlight),
      inFlight: operation.inFlight, searchActive: operation.searchActive,
      remainingThreadIds: operation.items.filter(item => ["pending", "failed"].includes(item.result)).map(item => item.id),
      retryableThreadIds: this.isRunning(operation) ? [] : this.retryItems(operation).map(item => item.id),
      error: operation.error, retryAt: this.inbox.client.blockedUntil,
    };
  }

  snapshots() {
    return [...this.operations.values()].map(operation => this.snapshot(operation));
  }

  close() {
    this.disposed = true;
    for (const operation of this.operations.values()) {
      if (this.isRunning(operation)) {
        operation.cancelled = true;
        operation.controller.abort();
      } else {
        this.operations.delete(operation.token);
      }
    }
  }
}
