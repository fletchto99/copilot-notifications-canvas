import { createHash, randomUUID } from "node:crypto";
import { InboxError } from "./model.mjs";

export function selectionKey(group, query) {
  return createHash("sha256").update(JSON.stringify([
    group.repository, query, group.items.map(item => [item.id, item.updatedAt]),
  ])).digest("hex");
}

function fields(input, keys) {
  return input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}

export class ReadBatch {
  constructor(inbox) {
    this.inbox = inbox;
    this.operation = null;
    this.done = Promise.resolve();
    this.disposed = false;
  }

  get locked() {
    return ["running", "stopping"].includes(this.operation?.status);
  }

  assertAvailable() {
    if (this.disposed) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.locked || this.inbox.busy || this.inbox.reading.size) {
      throw new InboxError("busy", "Finish or cancel the current inbox operation first.", 409);
    }
  }

  identify(input) {
    if (!fields(input, ["token"]) || typeof input.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.token)) {
      throw new InboxError("invalid_batch", "Use the current repository operation token.", 400);
    }
    if (!this.operation || this.operation.token !== input.token) {
      throw new InboxError("unknown_batch", "This repository operation is no longer available. Review the updated view and try again.", 409);
    }
    return this.operation;
  }

  start(input) {
    this.assertAvailable();
    if (!fields(input, ["repository", "selectionKey"]) || typeof input.repository !== "string" ||
        input.repository.length > 256 || typeof input.selectionKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.selectionKey)) {
      throw new InboxError("invalid_selection", "Choose a currently shown repository group.", 400);
    }
    const group = this.inbox.groups().find(item => item.repository === input.repository);
    if (!group || group.selectionKey !== input.selectionKey) {
      throw new InboxError("selection_changed", "The shown group changed. Review its updated count and try again.", 409);
    }
    this.launch(group.repository, group.items);
  }

  launch(repository, items) {
    if (!items.length || items.some(item => !/^[1-9]\d{0,63}$/.test(item.id)) ||
        new Set(items.map(item => item.id)).size !== items.length) {
      throw new InboxError("invalid_selection", "The selected group contains no eligible notifications or invalid thread IDs.", 400);
    }
    if (this.inbox.client.now() < this.inbox.client.blockedUntil) {
      throw this.inbox.client.lastError ??
        new InboxError("rate_limited", "GitHub requests are paused until the rate limit resets.", 429);
    }
    const owner = this.inbox.client.reserveReads(items.map(item => item.id));
    const operation = {
      token: randomUUID(), repository, status: "running",
      searchActive: Boolean(this.inbox.filters.query.trim()),
      items: items.map(({ id, updatedAt }) => ({ id, updatedAt, result: "pending" })),
      inFlight: false, cancelled: false, error: null, owner, controller: new AbortController(),
    };
    this.operation = operation;
    this.done = this.run(operation);
  }

  eligible(operation, item) {
    const current = this.inbox.loadedItems().find(row => row.id === item.id);
    if (!current || current.repository !== operation.repository || current.updatedAt !== item.updatedAt) return false;
    // A different panel may have fetched a newer version since this selection was clicked.
    for (const page of this.inbox.client.cache.values()) {
      if (page.items.some(row => row.id === item.id &&
          (!row.unread || row.repository !== operation.repository || row.updatedAt > item.updatedAt))) return false;
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
          await this.inbox.client.markRead(item.id, signal, {
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
      this.inbox.client.releaseReads(operation.owner);
      if (this.disposed || operation.status === "completed") this.operation = null;
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
    const shown = new Set(this.inbox.groups().find(group => group.repository === operation.repository)?.items.map(item => item.id));
    const remaining = operation.items.filter(item => ["pending", "failed"].includes(item.result) &&
      shown.has(item.id) && this.eligible(operation, item));
    if (!remaining.length) {
      throw new InboxError("no_remaining", "No unchanged, shown notifications remain from this batch. Wait for the next automatic refresh, then choose a repository group instead.", 409);
    }
    this.launch(operation.repository, remaining);
  }

  dismiss(input) {
    this.assertAvailable();
    this.identify(input);
    this.operation = null;
  }

  snapshot() {
    const operation = this.operation;
    if (!operation) return null;
    const count = result => operation.items.filter(item => item.result === result).length;
    return {
      token: operation.token, repository: operation.repository, status: operation.status,
      total: operation.items.length, succeeded: count("succeeded"), failed: count("failed"),
      skipped: count("skipped"), notAttempted: count("pending") - Number(operation.inFlight),
      inFlight: operation.inFlight, searchActive: operation.searchActive,
      error: operation.error, retryAt: this.inbox.client.blockedUntil,
    };
  }

  close() {
    this.disposed = true;
    if (this.locked) {
      this.operation.cancelled = true;
      this.operation.controller.abort();
    } else {
      this.operation = null;
    }
  }
}
