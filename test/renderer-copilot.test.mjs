import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { renderer, settle } from "./renderer-fixtures.mjs";

const ready = {
  id: "1", status: "ready", token: "synthetic-token", label: "Investigate with Copilot",
  repository: "example/widgets", url: "https://github.com/example/widgets/issues/1",
  sessions: [], needsClone: false, canClone: true,
  canRemember: true, confirmCopilotActions: true,
};
async function setup(t, options = {}) {
  const ui = await renderer({ subjectStates: { "1": { copilot: { label: ready.label, enabled: true, reason: "" } } }, ...options });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  return ui;
}
const button = ui => ui.ids.get("groups").querySelectorAll(".copilot-action")[0];
async function open(ui) {
  button(ui).focus();
  button(ui).events.click();
  await settle();
  await settle();
}

test("cold discovery polls promptly and updates disabled placeholders in place without moving focus", async t => {
  const subjectStates = { "1": { copilot: {
    label: "Checking Copilot availability...", reason: "Checking Copilot availability...", enabled: false, loading: true,
  } } };
  const ui = await setup(t, { subjectStates, copilotLoading: true, onCopilot: () => assert.fail("Discovery cannot submit a handoff") });
  const control = button(ui);
  assert.equal(control.disabled, true);
  assert.equal(control.getAttribute("aria-busy"), "true");
  assert.match(control.getAttribute("aria-label"), /^Checking Copilot availability/);
  control.events.click();
  assert.equal(Boolean(ui.ids.get("copilot-dialog").open), false);
  const link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
  link.focus();
  subjectStates["1"].copilot = { label: ready.label, enabled: true };
  ui.setCopilotLoading(false);
  await ui.fireTimer(1000);
  assert.equal(button(ui), control);
  assert.equal(control.disabled, false);
  assert.equal(control.getAttribute("aria-busy"), "false");
  assert.equal(ui.document.activeElement, link);
  await ui.fireTimer(5000);
  assert.equal(button(ui), control);
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("Copilot controls precede Read, confirm explicitly, preserve focus, and never write notification state", async t => {
  const requests = [];
  const ui = await setup(t, { onCopilot: input => {
    requests.push(input);
    return input.token ? { id: "1", status: "started", message: "Opened." } : ready;
  } });
  const controls = ui.ids.get("groups").querySelectorAll(".row-actions")[0].querySelectorAll("button");
  assert.equal(controls[0], button(ui));
  assert.equal(controls[1].dataset.action, "read");
  const icon = button(ui).querySelectorAll("svg")[0];
  assert.equal(icon.getAttribute("viewBox"), "0 0 16 16");
  assert.equal(icon.getAttribute("fill"), "currentColor");
  assert.equal(icon.getAttribute("stroke"), "none");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(controls[1].querySelectorAll("svg")[0].getAttribute("stroke"), "currentColor");
  await open(ui);
  assert.equal(ui.ids.get("copilot-dialog").open, true);
  assert.equal(ui.document.activeElement, ui.ids.get("copilot-close"));
  assert.equal(ui.ids.get("copilot-title").textContent, ready.label);
  assert.equal(ui.ids.get("copilot-reference").textContent, ready.url);
  assert.equal(ui.ids.get("copilot-start").hidden, false);
  assert.deepEqual(requests, [{ id: "1" }]);
  await ui.ids.get("copilot-start").events.click();
  await settle();
  assert.deepEqual(requests[1], { id: "1", token: ready.token, clone: false });
  assert.equal(ui.ids.get("copilot-status").textContent, "Opened.");
  assert.equal(ui.ids.get("copilot-start").hidden, true);
  ui.ids.get("copilot-close").events.click();
  assert.equal(ui.document.activeElement, button(ui));
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("existing sessions and clone confirmation have distinct actions and safe text rendering", async t => {
  const requests = [];
  const ui = await setup(t, { onCopilot: input => {
    requests.push(input);
    return { ...ready, sessions: [{ id: "session", name: "<script>existing</script>" }] };
  } });
  await open(ui);
  assert.equal(ui.ids.get("copilot-start").hidden, false);
  assert.equal(ui.ids.get("copilot-start").textContent, "Start a new session");
  const existing = ui.ids.get("copilot-sessions").querySelectorAll("button")[0];
  assert.equal(existing.textContent, "Open existing session: <script>existing</script>");
  existing.events.click();
  await settle();
  assert.equal(requests[1].sessionId, "session");
  ui.ids.get("copilot-start").events.click();
  await settle();
  assert.equal(requests.at(-1).startNew, true);
  assert.equal(requests.at(-1).sessionId, undefined);
  ui.setCopilotOperation({ ...ready, needsClone: true });
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-clone").hidden, false);
  assert.equal(ui.ids.get("copilot-start").textContent, "Clone repository and start");
  ui.setCopilotOperation({ ...ready, needsClone: true, canClone: false });
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-start").hidden, true);
});

test("closed and merged PR controls retain focus and describe the correct summary follow-up", async t => {
  for (const pullState of ["closed", "merged"]) await t.test(pullState, async t => {
    const subjectStates = { "1": { copilot: { label: "Review with Copilot", enabled: true } } };
    const ui = await setup(t, { subjectStates,
      onCopilot: () => ({ ...ready, action: "summarize", pullState, label: "Summarize Changes" }),
    });
    const control = button(ui);
    control.focus();
    subjectStates["1"].copilot = { label: "Summarize Changes", enabled: true, reason: "" };
    await runInContext("update()", ui.context);
    assert.equal(button(ui), control);
    assert.equal(control.disabled, false);
    assert.equal(ui.document.activeElement, control);
    assert.match(control.getAttribute("aria-label"), /^Summarize Changes:/);
    assert.equal(control.parentNode.querySelectorAll(".tooltip-content")[0].textContent, "Summarize Changes");
    await open(ui);
    assert.equal(ui.ids.get("copilot-title").textContent, "Summarize Changes");
    if (pullState === "closed") {
      assert.match(ui.ids.get("copilot-status").textContent, /changes proposed by this closed PR/);
      assert.match(ui.ids.get("copilot-status").textContent, /ask whether you'd like help reopening it/);
      assert.match(ui.ids.get("copilot-status").textContent, /will not reopen the PR or make changes without your approval/);
    } else {
      assert.match(ui.ids.get("copilot-status").textContent, /summarize what this merged PR changed/);
      assert.doesNotMatch(ui.ids.get("copilot-status").textContent, /reopen/);
    }
    assert.doesNotMatch(ui.ids.get("copilot-status").textContent, /then investigate/);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  });
});

test("inactive controls expose their reason, preserve focus and never submit a handoff", async t => {
  const subjectStates = { "1": { copilot: { label: ready.label, enabled: true } } };
  const ui = await setup(t, { subjectStates, onCopilot: () => assert.fail("Disabled controls cannot submit") });
  const control = button(ui);
  control.focus();
  subjectStates["1"].copilot = { label: "PR in merge queue", enabled: false, reason: "PR in merge queue" };
  await runInContext("update()", ui.context);
  assert.equal(button(ui), control);
  assert.equal(control.disabled, true);
  assert.match(control.getAttribute("aria-label"), /^PR in merge queue:/);
  assert.equal(control.parentNode.querySelectorAll(".tooltip-content")[0].textContent, "PR in merge queue");
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
  control.events.click();
  assert.equal(Boolean(ui.ids.get("copilot-dialog").open), false);
});

test("summary confirmations describe the selected task without offering implementation", async t => {
  for (const [action, label, reference, description] of [
    ["release", "Summarize Release Notes", "releases/tag/v1.2.0", /selected release notes read-only/],
    ["issueSummary", "Summarize with Copilot", "issues/1", /closed issue and its documented outcome read-only/],
    ["discussion", "Summarize with Copilot", "discussions/1", /summarize this discussion/],
    ["commit", "Summarize commit", `commit/${"a".repeat(40)}`, /code and behavior changed in the selected commit/],
  ]) await t.test(action, async t => {
    const url = `https://github.com/example/widgets/${reference}`;
    const ui = await setup(t, {
      subjectStates: { "1": { copilot: { label, enabled: true } } },
      onCopilot: () => ({ ...ready, action, label, url }),
    });
    await open(ui);
    assert.equal(ui.ids.get("copilot-title").textContent, label);
    assert.equal(ui.ids.get("copilot-reference").textContent, url);
    assert.match(ui.ids.get("copilot-status").textContent, description);
    assert.doesNotMatch(ui.ids.get("copilot-status").textContent, /PR|then investigate/);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  });
});

test("progress updates reach the dialog, nonmodal status and row tooltip without changing focus", async t => {
  const ui = await setup(t, { onCopilot: () => ({ id: "1", status: "starting", message: "Preparing checkout..." }) });
  await open(ui);
  assert.equal(ui.ids.get("copilot-status").textContent, "Preparing checkout...");
  ui.ids.get("copilot-close").events.click();
  for (const message of ["Fetching selected commit...", "Starting session..."]) {
    ui.setCopilotOperation({ id: "1", status: "starting", message });
    await runInContext("update()", ui.context);
    assert.equal(ui.ids.get("copilot-feedback").textContent, message);
    assert.equal(button(ui).parentNode.querySelectorAll(".tooltip-content")[0].textContent, message);
    assert.equal(ui.ids.get("copilot-dialog").open, false);
  }
});

test("inferred CI confirmation discloses the association and displays the exact run attempt", async t => {
  const url = "https://github.com/example/widgets/actions/runs/123/attempts/2";
  const ui = await setup(t, { onCopilot: () => ({ ...ready, url, inferred: true }) });
  await open(ui);
  assert.match(ui.ids.get("copilot-status").textContent, /matched from notification metadata, not linked by GitHub/);
  assert.match(ui.ids.get("copilot-status").textContent, /Confirm the run and attempt/);
  assert.equal(ui.ids.get("copilot-reference").textContent, url);
  assert.equal(ui.ids.get("copilot-start").hidden, false);
});

test("pending handoffs survive dialog dismissal without duplicate requests or background keyboard actions", async t => {
  let release;
  const requests = [];
  const ui = await setup(t, { onCopilot: input => {
    requests.push(input);
    return new Promise(resolve => { release = resolve; });
  } });
  await open(ui);
  assert.match(ui.ids.get("copilot-status").textContent, /Checking/);
  assert.equal(ui.ids.get("copilot-start").hidden, true);
  let prevented = false;
  ui.document.events.keydown({ key: "/", target: ui.document.activeElement, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  ui.document.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.ids.get("copilot-dialog").open, false);
  release({ id: "1", status: "preparing" });
  await settle();
  await open(ui);
  assert.equal(requests.length, 1);
  ui.setCopilotOperation({ ...ready, status: "starting" });
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-dialog").open, false);
  assert.match(ui.ids.get("copilot-feedback").textContent, /Opening Copilot/);
  assert.equal(button(ui).getAttribute("aria-busy"), "true");
});

test("failed requests remain visible and are not retried automatically", async t => {
  let calls = 0;
  const ui = await setup(t, { onCopilot: () => { calls++; throw new Error("Permission denied"); } });
  await open(ui);
  assert.match(ui.ids.get("copilot-status").textContent, /Permission denied/);
  assert.equal(ui.ids.get("copilot-status").getAttribute("role"), "alert");
  await runInContext("update()", ui.context);
  assert.equal(calls, 1);
});

test("subject hydration updates contextual actions without replacing focused controls", async t => {
  const subjectStates = { "1": { copilot: { label: "Work with Copilot", enabled: false, reason: "Unavailable" } } };
  const ui = await setup(t, { subjectStates });
  const control = button(ui);
  control.events.click();
  assert.equal(ui.ids.get("copilot-dialog").open, undefined);
  subjectStates["1"].copilot = { label: "Continue with Copilot", enabled: true };
  await runInContext("update()", ui.context);
  assert.equal(button(ui), control);
  assert.match(control.getAttribute("aria-label"), /^Continue with Copilot:/);
  subjectStates["1"].copilot = null;
  await runInContext("update()", ui.context);
  assert.equal(control.parentNode.hidden, true);
});

test("the default-on integration switch hides controls immediately, persists, and follows cross-panel changes", async t => {
  const storedSettings = {};
  const ui = await setup(t, { storedSettings });
  const toggle = ui.ids.get("copilot-integration");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(ui.document.documentElement.dataset.copilotIntegration, "true");
  await toggle.events.click();
  await settle();
  assert.equal(storedSettings.copilotIntegration, false);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(ui.document.documentElement.dataset.copilotIntegration, "false");
  assert.equal(button(ui).parentNode.hidden, true);
  const reopened = await setup(t, { storedSettings });
  assert.equal(button(reopened), undefined);
  await toggle.events.click();
  await settle();
  assert.equal(button(ui).parentNode.hidden, false);
  assert.equal(ui.document.documentElement.dataset.copilotIntegration, "true");
  button(ui).focus();
  storedSettings.copilotIntegration = false;
  await runInContext("update()", ui.context);
  assert.equal(button(ui).parentNode.hidden, true);
  assert.equal(ui.document.activeElement.dataset.focusKey, "thread:1");
  assert.deepEqual(ui.patches, []);
  assert.deepEqual(ui.deletions, []);
});

test("turning integration off removes a prepared dialog's start action", async t => {
  const storedSettings = {};
  const ui = await setup(t, { storedSettings, onCopilot: () => ready });
  await open(ui);
  assert.equal(ui.ids.get("copilot-start").hidden, false);
  storedSettings.copilotIntegration = false;
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-start").hidden, true);
  assert.match(ui.ids.get("copilot-status").textContent, /integration is off/);
});

test("the popup opt-out is submitted only with Start, not when cancelling", async t => {
  const requests = [];
  const ui = await setup(t, { onCopilot: input => {
    requests.push(input);
    return input.token ? { id: "1", status: "started", message: "Opened." } : ready;
  } });
  await open(ui);
  assert.equal(ui.ids.get("copilot-remember").hidden, false);
  ui.ids.get("copilot-skip-confirmation").focus();
  ui.ids.get("copilot-skip-confirmation").events.click();
  assert.equal(ui.ids.get("copilot-skip-confirmation").getAttribute("aria-checked"), "true");
  ui.document.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.document.activeElement, button(ui));
  assert.equal(requests.length, 1);
  assert.equal(ui.calls.some(call => call.path === "/api/settings" && call.options.body), false);
  await open(ui);
  assert.equal(ui.ids.get("copilot-skip-confirmation").getAttribute("aria-checked"), "false");
  ui.ids.get("copilot-skip-confirmation").events.click();
  ui.ids.get("copilot-start").events.click();
  await settle();
  assert.equal(requests.at(-1).skipConfirmation, true);
});

test("direct clicks show nonmodal progress, do not replay on polls, and reveal required decisions", async t => {
  const requests = [];
  const ui = await setup(t, { storedSettings: { confirmCopilotActions: false }, onCopilot: input => {
    requests.push(input);
    return { id: "1", status: "preparing" };
  } });
  await open(ui);
  assert.deepEqual(requests, [{ id: "1", direct: true }]);
  assert.equal(Boolean(ui.ids.get("copilot-dialog").open), false);
  assert.equal(ui.ids.get("copilot-feedback").hidden, false);
  assert.equal(button(ui).disabled, true);
  await runInContext("update()", ui.context);
  assert.equal(requests.length, 1);
  ui.setCopilotOperation({ ...ready, needsClone: true, confirmCopilotActions: false });
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-dialog").open, true);
  assert.equal(ui.ids.get("copilot-start").textContent, "Clone repository and start");
  assert.equal(ui.ids.get("copilot-remember").hidden, true);
  ui.ids.get("copilot-close").events.click();
  await runInContext("update()", ui.context);
  assert.equal(ui.ids.get("copilot-dialog").open, false, "A cancelled safety decision must not reopen on every poll");
});

test("direct failures remain visible and confirming can be restored in Settings", async t => {
  const storedSettings = { confirmCopilotActions: false };
  const ui = await setup(t, { storedSettings, onCopilot: () => { throw new Error("Synthetic host failure"); } });
  await open(ui);
  assert.equal(ui.ids.get("copilot-dialog").open, true);
  assert.match(ui.ids.get("copilot-status").textContent, /Synthetic host failure/);
  assert.equal(button(ui).disabled, false);
  ui.ids.get("copilot-close").events.click();
  ui.ids.get("copilot-confirmations").events.click();
  await settle();
  assert.equal(storedSettings.confirmCopilotActions, true);
  assert.equal(ui.ids.get("copilot-confirmations").getAttribute("aria-checked"), "true");
});
