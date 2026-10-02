import test from "node:test";
import assert from "node:assert/strict";
import { NotificationSound } from "../.github/extensions/github-notifications/sound.mjs";
import { FakeAudioContext } from "./audio-fixtures.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(options = {}) {
  const contexts = [];
  const changes = [];
  const sound = new NotificationSound({
    createContext: () => {
      const context = new FakeAudioContext(options);
      contexts.push(context);
      return context;
    },
    now: () => 1000,
    onChange: state => changes.push(state),
  });
  const observe = (sequence, latestAt = 2000, settings = {}) =>
    sound.observe({ sequence, latestAt }, { refresh: true, visible: true, ...settings });
  return { sound, contexts, changes, observe };
}

test("sound defaults off, updates its baseline while off and never rings for initial load or backlog on enable", async () => {
  const { sound, contexts, observe } = setup();
  observe(0);
  observe(1);
  assert.equal(sound.enabled, false);
  assert.equal(contexts.length, 0);
  await sound.toggle();
  assert.equal(contexts[0].resumes, 1);
  assert.equal(contexts[0].starts, 0);
  observe(1);
  observe(2, 999);
  assert.equal(contexts[0].starts, 0);
  observe(3, 2000);
  assert.equal(contexts[0].starts, 1);
  observe(3, 2000);
  assert.equal(contexts[0].starts, 1);
  await sound.close();
});

test("one gentle bounded chime per new batch; state/filter/more reads and hidden updates stay silent", async () => {
  const { sound, contexts, observe } = setup();
  await sound.toggle();
  observe(5);
  observe(6, 2000, { refresh: false });
  observe(7, 3000, { visible: false });
  assert.equal(contexts[0].starts, 0);
  observe(10, 4000);
  assert.equal(contexts[0].starts, 1);
  assert.equal(contexts[0].oscillators[0].type, "sine");
  assert.equal(contexts[0].oscillators[0].stoppedAt, 0.26);
  assert.ok(contexts[0].gains[0].values.every(([value]) => value <= 0.06));
  contexts[0].oscillators[0].onended();
  assert.equal(sound.nodes.size, 0);
  await sound.close();
});

test("turning off promptly stops notes and cancels batches already in flight across toggle changes", async () => {
  const { sound, contexts, observe } = setup();
  observe(0);
  await sound.toggle();
  const generation = sound.generation;
  observe(1);
  await sound.toggle();
  assert.equal(sound.enabled, false);
  assert.equal(contexts[0].state, "closed");
  assert.equal(contexts[0].oscillators[0].disconnected, true);
  assert.equal(contexts[0].gains[0].values.at(-1)[0], 0);
  observe(2);
  await sound.toggle();
  observe(3, 3000, { generation });
  assert.equal(contexts[1].starts, 0);
  observe(4, 4000);
  assert.equal(contexts[1].starts, 1);
  await sound.close();
});

test("reconnect and visibility resets are silent, stop current notes and keep the toggle preference", async () => {
  const { sound, contexts, observe } = setup();
  observe(0);
  await sound.toggle();
  observe(1);
  sound.resetBaseline();
  assert.equal(sound.enabled, true);
  assert.equal(sound.nodes.size, 0);
  observe(5, 5000);
  assert.equal(contexts[0].starts, 1);
  observe(6, 6000);
  assert.equal(contexts[0].starts, 2);
  await sound.close();
  await sound.toggle();
  observe(7, 7000);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].state, "closed");
});

test("blocked or suspended audio reports a visible off/retry state instead of claiming enabled", async () => {
  for (const options of [{ resumeError: true }, { resumeState: "suspended" }]) {
    const { sound, contexts, changes } = setup(options);
    await sound.toggle();
    assert.equal(sound.enabled, false);
    assert.equal(sound.pending, false);
    assert.match(changes.at(-1).message, /could not be enabled.*retry/);
    assert.equal(contexts[0].state, "closed");
    options.resumeError = false;
    options.resumeState = "running";
    await sound.toggle();
    assert.equal(sound.enabled, true);
    await sound.close();
  }
});

test("unavailable Web Audio support is reported without leaking browser error details", async () => {
  const changes = [];
  const sound = new NotificationSound({
    createContext: () => { throw new Error("Synthetic unsupported browser detail"); },
    onChange: state => changes.push(state),
  });
  await sound.toggle();
  assert.equal(sound.enabled, false);
  assert.equal(sound.pending, false);
  assert.match(changes.at(-1).message, /could not be enabled/);
  assert.doesNotMatch(changes.at(-1).message, /Synthetic/);
});

test("playback failure or later browser suspension disables sound and releases resources", async () => {
  for (const options of [{ playError: true }, {}]) {
    const { sound, contexts, changes, observe } = setup(options);
    observe(0);
    await sound.toggle();
    if (options.playError) observe(1);
    else {
      contexts[0].state = "suspended";
      contexts[0].onstatechange();
    }
    await settle();
    assert.equal(sound.enabled, false);
    assert.match(changes.at(-1).message, /retry/);
    assert.equal(contexts[0].state, "closed");
    assert.equal(sound.nodes.size, 0);
  }
});

test("cancelling a pending enable cannot turn sound back on when resume eventually completes", async () => {
  let resolve;
  const { sound, contexts } = setup({ resumeWait: new Promise(done => { resolve = done; }) });
  const enabling = sound.toggle();
  assert.equal(sound.pending, true);
  await sound.toggle();
  resolve();
  await enabling;
  assert.equal(sound.enabled, false);
  assert.equal(contexts[0].state, "closed");
});

test("cleanup failure is reported without leaving sound enabled", async () => {
  const { sound, changes } = setup({ closeError: true });
  await sound.toggle();
  await sound.close();
  assert.equal(sound.enabled, false);
  assert.match(changes.at(-1).message, /could not release audio/);
});

test("a stalled browser resume times out to a retryable off state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sound, contexts, changes } = setup({ resumeWait: new Promise(() => {}) });
  const enabling = sound.toggle();
  t.mock.timers.tick(3000);
  await enabling;
  assert.equal(sound.enabled, false);
  assert.equal(sound.pending, false);
  assert.equal(contexts[0].state, "closed");
  assert.match(changes.at(-1).message, /could not be enabled/);
});
