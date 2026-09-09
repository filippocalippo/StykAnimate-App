/** Scene presentations, not rAF frequency or reciprocal CPU submission time. */
export class PlaybackMetrics {
  constructor({windowMs = 1000, tolerance = 0.05} = {}) {
    this.windowMs = windowMs;
    this.tolerance = tolerance;
    this.reset();
  }
  reset(now = null, targetFps = 24) {
    this.startedAt = now;
    this.targetFps = targetFps;
    this.presentations = [];
    this.intervals = [];
    this.totalFrames = 0;
    this.firstAt = null;
    this.lastAt = null;
    this.bufferingAt = null;
    this.bufferingMs = 0;
    this.bufferingEvents = 0;
    this.stoppedAt = null;
  }
  present(now) {
    if (this.stoppedAt !== null) return;
    if (this.firstAt === null) this.firstAt = now;
    if (this.lastAt !== null) {
      this.intervals.push(now - this.lastAt);
      if (this.intervals.length > 300) this.intervals.shift();
    }
    this.lastAt = now;
    this.totalFrames++;
    this.presentations.push(now);
    this.trim(now);
  }
  trim(now) {
    while (this.presentations.length && this.presentations[0] <= now - this.windowMs)
      this.presentations.shift();
  }
  buffering(active, now) {
    if (active && this.bufferingAt === null) {
      this.bufferingAt = now;
      this.bufferingEvents++;
    } else if (!active && this.bufferingAt !== null) {
      this.bufferingMs += now - this.bufferingAt;
      this.bufferingAt = null;
    }
  }
  stop(now) {
    this.buffering(false, now);
    this.stoppedAt = now;
  }
  snapshot(now) {
    now = this.stoppedAt ?? now;
    this.trim(now);
    const elapsedMs = this.startedAt === null ? 0 : Math.max(0, now - this.startedAt);
    // Allow half a second for a useful first sample; include preparation stalls.
    const fps = elapsedMs < 500 ? null
      : this.presentations.length * 1000 / Math.min(this.windowMs, elapsedMs);
    return {
      fps, targetFps: this.targetFps,
      coherent: fps === null ? null : fps >= this.targetFps * (1 - this.tolerance),
      totalFrames: this.totalFrames, elapsedMs,
      startupMs: this.firstAt === null ? null : this.firstAt - this.startedAt,
      bufferingMs: this.bufferingMs + (this.bufferingAt === null ? 0 : now - this.bufferingAt),
      bufferingEvents: this.bufferingEvents,
      intervalsMs: [...this.intervals],
    };
  }
}
