import { createHash, randomUUID } from "node:crypto";
import { WRITE_CONCURRENCY } from "./github.mjs";
import { groupThreadsByDate, InboxError, uniqueThreads } from "../shared/model.mjs";

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
    return operation.status === "running";
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
      items: items.map(({ id, updatedAt, repository, unread }) => ({ id, updatedAt, repository, unread, result: "pending", inFlight: false })),
      error: null, owner, controller: new AbortController(), queueController: new AbortController(),
    };
    this.operations.set(operation.token, operation);
    const done = this.run(operation);
    this.running.add(done);
    void done.finally(() => this.running.delete(done));
    return operation.token;
  }

  retryContext(items = this.inbox.loadedItems(), groups = this.inbox.groups(items)) {
    const loaded = new Map(items.map(item => [item.id, item]));
    const sequences = new Map(this.inbox.pages.flatMap(page => page.items.map(item => [item, page.sequence])));
    const invalidated = new Set();
    for (const page of this.inbox.client.cache.values()) {
      for (const row of uniqueThreads(page.items)) {
        const current = loaded.get(row.id);
        // Other views can retain older read states. Only newer responses invalidate a selection.
        if (!current || page.sequence < sequences.get(current)) continue;
        if (row.unread !== current.unread || row.repository !== current.repository || row.updatedAt > current.updatedAt) {
          invalidated.add(row.id);
        }
      }
    }
    return { loaded, invalidated, shown: new Map(groups.flatMap(group => group.items.map(item => [item.id, item]))), dates: new Map() };
  }

  eligible(operation, item, context = this.retryContext(this.inbox.loadedItems(), [])) {
    const current = context.loaded.get(item.id);
    if (!current || current.repository !== item.repository || current.updatedAt !== item.updatedAt ||
        current.unread !== item.unread || (operation.action === "read" && !current.unread) ||
        (operation.scope === "repository" && current.repository !== operation.repository)) return false;
    return !context.invalidated.has(item.id);
  }

  async run(operation) {
    const signal = AbortSignal.any([this.inbox.controller.signal, operation.controller.signal]);
    const queueSignal = AbortSignal.any([signal, operation.queueController.signal]);
    const items = operation.items.values();
    const stop = error => {
      if (error instanceof InboxError && error.code === "selection_changed") return;
      operation.error ??= error instanceof InboxError
        ? { code: error.code, message: error.message }
        : { code: "batch_failed", message: "An unexpected batch error occurred. Wait for the next automatic refresh before retrying remaining notifications." };
      operation.queueController.abort();
    };
    const worker = async () => {
      for (const item of items) {
        if (signal.aborted || operation.error) return;
        try {
          if (!this.eligible(operation, item)) {
            item.result = "skipped";
            continue;
          }
          const method = operation.action === "done" ? "markDone" : "markRead";
          await this.inbox.client[method](item.id, signal, {
            owner: operation.owner,
            queueSignal,
            onWriteError: stop,
            beforeWrite: () => {
              if (!this.eligible(operation, item)) throw new InboxError("selection_changed", "A selected notification changed.", 409);
              item.inFlight = true;
            },
          });
          item.result = "succeeded";
        } catch (error) {
          if (error instanceof InboxError && error.code === "selection_changed") {
            item.result = "skipped";
            continue;
          }
          if ((signal.aborted || operation.error) && !item.inFlight) return;
          if (item.inFlight) item.result = "failed";
          stop(error);
          return;
        } finally {
          item.inFlight = false;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, operation.items.length) }, worker));
      operation.status = operation.items.every(item => item.result === "succeeded") ? "completed" : "partial";
    } finally {
      this.inbox.client.releaseThreads(operation.owner);
      if (this.disposed || (operation.status === "completed" && operation.scope !== "thread")) this.operations.delete(operation.token);
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

  retryItems(operation, context = this.retryContext()) {
    let shown = context.shown;
    if (operation.scope === "date") {
      if (!context.dates.has(operation.timeZone)) {
        context.dates.set(operation.timeZone, new Map(groupThreadsByDate([...shown.values()], operation.timeZone)
          .map(group => [group.date, new Set(group.items.map(item => item.id))])));
      }
      shown = context.dates.get(operation.timeZone).get(operation.date) ?? new Set();
    }
    return operation.items.filter(item => ["pending", "failed"].includes(item.result) &&
      shown.has(item.id) && this.eligible(operation, item, context));
  }

  clearRowResults(id, exceptToken) {
    for (const operation of this.operations.values()) {
      if (operation.token !== exceptToken && operation.scope === "thread" && !this.isRunning(operation) &&
          operation.status !== "completed" &&
          (id === undefined || operation.items[0].id === id)) this.operations.delete(operation.token);
    }
  }

  acknowledge(version) {
    if (typeof version !== "string" || !/^(0|[1-9]\d{0,15})$/.test(version) ||
        !Number.isSafeInteger(Number(version)) || Number(version) > this.inbox.snapshotVersion) {
      throw new InboxError("invalid_snapshot", "Acknowledge only a previously received notification snapshot.", 400);
    }
    for (const operation of this.operations.values()) {
      if (operation.scope === "thread" && operation.status === "completed" &&
          operation.resultVersion !== undefined && operation.resultVersion <= Number(version)) {
        this.operations.delete(operation.token);
      }
    }
  }

  dismiss(input) {
    this.assertAvailable();
    const operation = this.identify(input);
    if (this.isRunning(operation)) throw new InboxError("busy", "Wait for this batch to finish before dismissing it.", 409);
    this.operations.delete(operation.token);
  }

  snapshot(operation = [...this.operations.values()].at(-1), context) {
    if (!operation) return null;
    const count = result => operation.items.filter(item => item.result === result).length;
    const inFlight = operation.items.filter(item => item.inFlight).length;
    return {
      token: operation.token, repository: operation.repository, scope: operation.scope, action: operation.action, status: operation.status,
      ...(operation.scope === "date" ? { date: operation.date, timeZone: operation.timeZone } : {}),
      ...(operation.scope === "thread" ? { threadId: operation.items[0].id } : {}),
      total: operation.items.length, succeeded: count("succeeded"), failed: count("failed"),
      skipped: count("skipped"), notAttempted: count("pending") - inFlight,
      inFlight: inFlight > 0, searchActive: operation.searchActive,
      remainingThreadIds: operation.items.filter(item => ["pending", "failed"].includes(item.result)).map(item => item.id),
      retryableThreadIds: this.isRunning(operation) || operation.status === "completed" ? [] : this.retryItems(operation, context).map(item => item.id),
      error: operation.error, retryAt: this.inbox.client.blockedUntil,
    };
  }

  snapshots(items, groups, version) {
    let context;
    return [...this.operations.values()].map(operation => {
      if (!this.isRunning(operation) && operation.status !== "completed") context ??= this.retryContext(items, groups);
      if (version !== undefined && operation.scope === "thread" && operation.status === "completed") {
        operation.resultVersion ??= version;
      }
      return this.snapshot(operation, context);
    });
  }

  close() {
    this.disposed = true;
    for (const operation of this.operations.values()) {
      if (this.isRunning(operation)) {
        operation.controller.abort();
      } else {
        this.operations.delete(operation.token);
      }
    }
  }
}
