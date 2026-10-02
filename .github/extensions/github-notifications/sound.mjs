export class NotificationSound {
  constructor({ createContext, now = Date.now, onChange = () => {} }) {
    this.createContext = createContext;
    this.now = now;
    this.onChange = onChange;
    this.enabled = false;
    this.pending = false;
    this.generation = 0;
    this.sequence = undefined;
    this.nodes = new Set();
    this.context = null;
    this.closed = false;
  }

  async toggle() {
    if (this.closed) return;
    if (this.enabled || this.pending) return this.disable();
    const generation = ++this.generation;
    this.pending = true;
    this.onChange({ enabled: false, pending: true, message: "Enabling sound..." });
    let timeout;
    try {
      const context = this.createContext();
      this.context = context;
      context.onstatechange = () => {
        if (this.enabled && this.context === context && context.state !== "running") {
          void this.disable("Sound was paused by the browser. Enable sound to retry.");
        }
      };
      if (context.state !== "running") {
        await Promise.race([
          context.resume(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Audio resume timed out")), 3000); }),
        ]);
      }
      if (generation !== this.generation) return;
      if (context.state !== "running") throw new Error("Audio is not running");
      this.enabled = true;
      this.pending = false;
      this.enabledAt = this.now();
      this.onChange({ enabled: true, pending: false, message: "Sound is on for new activity while this canvas is visible." });
    } catch {
      if (generation === this.generation) {
        await this.disable("Sound could not be enabled. Check browser audio permissions, then enable sound to retry.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  observe(activity, { refresh = false, visible = false, generation = this.generation } = {}) {
    const previous = this.sequence;
    this.sequence = activity.sequence;
    if (previous === undefined || activity.sequence <= previous || !refresh || !visible ||
        !this.enabled || generation !== this.generation ||
        activity.latestAt <= Math.max(this.enabledAt, this.activityAfter ?? -Infinity)) return;
    try {
      const context = this.context;
      if (context?.state !== "running") throw new Error("Audio is not running");
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const nodes = { oscillator, gain };
      this.nodes.add(nodes);
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(660, context.currentTime);
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.06, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.24);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        this.nodes.delete(nodes);
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          void this.disable("Sound cleanup failed. Enable sound to retry.");
        }
      };
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.26);
    } catch {
      void this.disable("Sound playback failed. Enable sound to retry.");
    }
  }

  stopNotes() {
    let failed = false;
    for (const { oscillator, gain } of this.nodes) {
      oscillator.onended = null;
      try {
        gain.gain.setValueAtTime(0, this.context.currentTime);
        oscillator.stop();
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        failed = true;
      }
    }
    this.nodes.clear();
    return failed;
  }

  resetBaseline() {
    this.sequence = undefined;
    this.activityAfter = this.now();
    if (this.stopNotes()) void this.disable("Sound could not be paused. Enable sound to retry.");
  }

  async disable(message = "") {
    const generation = ++this.generation;
    this.enabled = false;
    this.pending = false;
    const failed = this.stopNotes();
    const context = this.context;
    this.context = null;
    if (context) context.onstatechange = null;
    this.onChange({ enabled: false, pending: false, message: message || (failed ? "Sound is off; audio cleanup failed." : "Sound is off.") });
    try {
      if (context && context.state !== "closed") await context.close();
    } catch {
      if (generation === this.generation) {
        this.onChange({ enabled: false, pending: false, message: "Sound is off, but the browser could not release audio. Reopen the canvas to retry." });
      }
    }
  }

  async close() {
    this.closed = true;
    await this.disable();
  }
}
