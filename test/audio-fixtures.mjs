export class FakeAudioContext {
  constructor(options = {}) {
    this.options = options;
    this.state = options.state ?? "suspended";
    this.currentTime = 0;
    this.destination = {};
    this.oscillators = [];
    this.gains = [];
    this.starts = 0;
    this.closes = 0;
    this.resumes = 0;
  }

  async resume() {
    this.resumes++;
    if (this.options.resumeError) throw new Error("Synthetic audio policy denial");
    if (this.options.resumeWait) await this.options.resumeWait;
    if (this.state !== "closed") this.state = this.options.resumeState ?? "running";
    this.onstatechange?.();
  }

  async close() {
    this.closes++;
    if (this.options.closeError) throw new Error("Synthetic audio cleanup failure");
    this.state = "closed";
    this.onstatechange?.();
  }

  createOscillator() {
    const node = {
      frequency: { setValueAtTime() {} },
      connect() {},
      disconnect() { node.disconnected = true; },
      start: () => {
        if (this.options.playError) throw new Error("Synthetic audio playback failure");
        this.starts++;
      },
      stop(time) { node.stoppedAt = time; node.stopped = true; },
    };
    this.oscillators.push(node);
    return node;
  }

  createGain() {
    const values = [];
    const node = {
      gain: {
        setValueAtTime: (value, time) => values.push([value, time]),
        linearRampToValueAtTime: (value, time) => values.push([value, time]),
        exponentialRampToValueAtTime: (value, time) => values.push([value, time]),
      },
      connect() {},
      disconnect() { node.disconnected = true; },
      values,
    };
    this.gains.push(node);
    return node;
  }
}
