import { createHash, randomUUID } from "node:crypto";
import { InboxError } from "./model.mjs";
import { runTriageSession } from "./triage-session.mjs";

const categories = ["attention", "awareness", "dismissible", "uncertain"];
const schema = {
  type: "object", additionalProperties: false, required: ["recommendations"],
  properties: {
    recommendations: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["ref", "category", "reason"],
      properties: {
        ref: { type: "string" }, category: { type: "string", enum: categories },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
    } },
  },
};

function fields(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function fingerprint(selection) {
  return createHash("sha256").update(JSON.stringify([selection.selectionKey, selection.items])).digest("hex");
}

export class NotificationTriage {
  constructor(inbox, { run = runTriageSession, log = () => {}, timeout = 300_000 } = {}) {
    this.inbox = inbox;
    this.run = run;
    this.log = log;
    this.timeout = timeout;
    this.operation = null;
    this.done = Promise.resolve();
    this.disposed = false;
  }

  get running() {
    return this.operation?.status === "running";
  }

  get pending() {
    return this.operation && !this.operation.settled;
  }

  checkCurrent(operation) {
    if (fingerprint(this.inbox.shownSelection()) !== operation.fingerprint) {
      operation.status = "stale";
      operation.results = [];
      operation.controller.abort(new InboxError("triage_stale", "Shown notifications changed. Run triage again for the updated view.", 409));
    }
    operation.controller.signal.throwIfAborted();
  }

  snapshot() {
    const operation = this.operation;
    if (!operation) return { status: "idle" };
    if (["running", "complete"].includes(operation.status) && !operation.controller.signal.aborted) {
      try {
        this.checkCurrent(operation);
      } catch (error) {
        if (!(error instanceof InboxError) || error.code !== "triage_stale") throw error;
      }
    }
    return {
      token: operation.token, status: operation.status, total: operation.items.length,
      inspected: operation.inspected, settling: !operation.settled,
      error: operation.error, results: operation.results,
    };
  }

  validateStart(input, acknowledged = false) {
    if (this.disposed || this.inbox.controller.signal.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
    if (this.pending || this.inbox.busy || this.inbox.marking.size || this.inbox.batch.locked) {
      throw new InboxError("busy", "Finish the current operation before starting triage.", 409);
    }
    const confirmed = fields(input, ["selectionKey", "consent"]) && input.consent === true;
    const remembered = fields(input, ["selectionKey"]) && acknowledged;
    if ((!confirmed && !remembered) ||
        typeof input.selectionKey !== "string" || !/^[a-f0-9]{64}$/.test(input.selectionKey)) {
      throw new InboxError("triage_consent", "Review and confirm the Copilot data-sharing disclosure first.", 400);
    }
    const selection = this.inbox.shownSelection();
    if (selection.selectionKey !== input.selectionKey) {
      throw new InboxError("selection_changed", "The shown selection changed. Review the updated view and confirm triage again.", 409);
    }
    if (!selection.items.length) throw new InboxError("invalid_selection", "Show at least one notification before starting triage.", 400);
    return selection;
  }

  start(input, acknowledged = false) {
    const selection = this.validateStart(input, acknowledged);
    const operation = {
      token: randomUUID(), status: "running", items: selection.items.map(item => ({ ...item })),
      fingerprint: fingerprint(selection), controller: new AbortController(),
      context: new Map(), listed: new Set(), results: [], error: null, calls: 0, inspected: 0, settled: false,
    };
    this.operation = operation;
    this.done = this.execute(operation);
  }

  identify(input) {
    if (!fields(input, ["token"]) || !this.operation || input.token !== this.operation.token) {
      throw new InboxError("unknown_triage", "This triage run is no longer available.", 409);
    }
    return this.operation;
  }

  cancel(input) {
    const operation = this.identify(input);
    if (!this.running) return;
    operation.status = "cancelled";
    operation.controller.abort(new InboxError("triage_cancelled", "Copilot triage was cancelled.", 409));
  }

  dismiss(input) {
    this.identify(input);
    if (this.pending) throw new InboxError("busy", "Wait for triage to stop before dismissing it.", 409);
    this.operation = null;
  }

  tools(operation) {
    const tool = (name, description, parameters, run) => ({
      name, description, parameters,
      handler: async input => {
        try {
          this.checkCurrent(operation);
          if (++operation.calls > operation.items.length * 3 + 20) {
            throw new InboxError("triage_budget", "Copilot reached the triage request limit. Narrow the view and try again.", 429);
          }
          const value = await run(input);
          this.checkCurrent(operation);
          return { textResultForLlm: JSON.stringify(value), resultType: "success" };
        } catch (error) {
          const failure = error instanceof InboxError ? error :
            new InboxError("triage_context", "Could not read GitHub context for triage.", 502);
          operation.error = { code: failure.code, message: failure.message };
          operation.controller.abort(failure);
          return { textResultForLlm: failure.message, resultType: "failure" };
        }
      },
    });
    return [
      tool("list_shown_notifications", "Read one page of the approved shown notifications, using the provider's GitHub snapshot. No other notifications are accessible.", {
        type: "object", additionalProperties: false, required: ["offset"],
        properties: { offset: { type: "integer", minimum: 0 } },
      }, input => {
        if (!fields(input, ["offset"]) || !Number.isSafeInteger(input.offset) || input.offset < 0 ||
            input.offset >= operation.items.length) throw new InboxError("triage_input", "Choose a valid notification page offset.", 400);
        const items = operation.items.slice(input.offset, input.offset + 20).map((item, index) => {
          const ref = `n${input.offset + index + 1}`;
          operation.listed.add(ref);
          return {
            ref, title: item.title.slice(0, 512), repository: item.repository, reason: item.reason,
            type: item.type, updatedAt: item.updatedAt,
          };
        });
        return { items, nextOffset: input.offset + items.length < operation.items.length ? input.offset + items.length : null };
      }),
      tool("read_notification_context", "Read the linked issue or PR and its last page of up to 10 comments from GitHub. Other subject types report context unavailable. Cannot read arbitrary repositories, URLs or notifications.", {
        type: "object", additionalProperties: false, required: ["ref"],
        properties: { ref: { type: "string", pattern: "^n[1-9][0-9]*$" } },
      }, async input => {
        if (!fields(input, ["ref"]) || !operation.listed.has(input.ref)) {
          throw new InboxError("triage_scope", "Read only references returned by list_shown_notifications.", 400);
        }
        if (!operation.context.has(input.ref)) {
          const item = operation.items[Number(input.ref.slice(1)) - 1];
          const value = await this.inbox.client.triageContext(item, operation.controller.signal);
          operation.context.set(input.ref, value);
          operation.inspected = operation.context.size;
        }
        return operation.context.get(input.ref);
      }),
    ];
  }

  validate(value, operation) {
    if (!fields(value, ["recommendations"]) || !Array.isArray(value.recommendations) ||
        value.recommendations.length !== operation.items.length) {
      throw new InboxError("triage_result", "Copilot returned an incomplete triage result. Narrow the view and try again.", 502);
    }
    const seen = new Set();
    return value.recommendations.map(result => {
      if (!fields(result, ["ref", "category", "reason"]) || !operation.listed.has(result.ref) ||
          seen.has(result.ref) || !categories.includes(result.category) ||
          typeof result.reason !== "string" || !result.reason.trim() || result.reason.length > 500) {
        throw new InboxError("triage_result", "Copilot returned an invalid triage result. Try again.", 502);
      }
      seen.add(result.ref);
      return {
        id: operation.items[Number(result.ref.slice(1)) - 1].id,
        category: result.category, reason: result.reason,
        context: operation.context.get(result.ref)?.available ? "thread" : "notification",
      };
    });
  }

  async execute(operation) {
    const timer = setTimeout(() => operation.controller.abort(
      new InboxError("triage_timeout", "Copilot triage timed out. Narrow the view and try again.", 504)), this.timeout);
    const closed = () => operation.controller.abort(new InboxError("closed", "The canvas was closed.", 410));
    this.inbox.controller.signal.addEventListener("abort", closed, { once: true });
    try {
      const value = await this.run({
        tools: this.tools(operation), schema, signal: operation.controller.signal,
      }, { log: this.log });
      this.checkCurrent(operation);
      operation.results = this.validate(value, operation);
      operation.status = "complete";
    } catch (error) {
      if (!["stale", "cancelled"].includes(operation.status) || error?.code === "triage_cleanup") {
        const failure = error?.code === "triage_cleanup" ? error : operation.controller.signal.reason ?? error;
        operation.status = "error";
        operation.error = failure instanceof InboxError ? { code: failure.code, message: failure.message } :
          { code: "triage_failed", message: "Copilot triage failed. Try again." };
        this.log("Copilot notification triage did not complete.", { level: "warning" });
      }
    } finally {
      clearTimeout(timer);
      this.inbox.controller.signal.removeEventListener("abort", closed);
      operation.context.clear();
      operation.listed.clear();
      operation.settled = true;
      // Keep only the snapshot identity and validated recommendations after the run.
      operation.items = operation.items.map(({ id }) => ({ id }));
    }
  }

  async close() {
    this.disposed = true;
    if (this.operation) this.operation.controller.abort(new InboxError("closed", "The canvas was closed.", 410));
    await this.done;
    this.operation = null;
  }
}
