/**
 * The frame counter (docs/STATISTICS.md, "The numbers"): every frame the frame loop draws while a person drags, plays,
 * scrubs, moves the view or draws, in cells by what they do and scene size, with the late frames' stages and the five
 * slowest moments. The frame loop calls it three times a display callback, and only while statistics are on:
 *
 *   tick(now)                        at the start of every callback (now: the callback's timestamp)
 *   drawn(doing, paintStart, paintEnd)   when the callback drew the stage for an interaction
 *   end(continues)                   at the end of the callback: whether the loop asked for the next one
 *
 * A frame's time runs from the callback that drew it to the next display callback, which is when it was replaced: a frame
 * whose work overran its refresh shows as a longer interval. The first frame of a burst (the callback before drew nothing
 * for this interaction) is timed from the input that started it, to the end of its paint. A frame the loop does not follow
 * with another callback ends with its paint.
 */
import {DOING, SCENES, STAGES, emptyFrameTimes, frameStep, isLate, sceneOf} from './schema.mjs';
import {PlaybackCadence} from '../playback-cadence.mjs';

const STAGE = Object.fromEntries(STAGES.map((name, index) => [name, index]));
/** The spans the counter hears (src/trace.mjs) and the stage each one's time goes to. */
export const SPAN_STAGES = new Map([['edit session call', STAGE.edit], ['stage geometry', STAGE.geometry],
  ['stage submit', STAGE.draw], ['stage draw prepared', STAGE.draw]]);
const SLOWEST = 5;
/** Scene size is read from the stage at most this often: it parses the engine's counters. */
const SCENE_EVERY_MS = 500;
/** An input this long before a frame did not start it (a pointer held still, then a playback started by a timer). */
const INPUT_MAX_MS = 1000;

export class FrameCounter {
  /** `segments()`: the primitives the stage drew for the frame on show (engine-stage.mjs `stats.primitives`). */
  constructor({segments = () => null, foreground = () => true} = {}) {
    this.segments = segments; this.foreground = foreground;
    this.cadence = new PlaybackCadence();
    this.spans = new Float64Array(STAGES.length);
    this.onSpan = (name, ms) => { this.spans[SPAN_STAGES.get(name)] += ms; };
    this.reset();
  }

  reset() {
    this.cells = new Map(); this.slow = [];
    this.lastTick = 0; this.drewIn = null; this.drewBefore = null;
    this.pendingDoing = null; this.pendingStart = 0; this.pendingPaint = 0; this.pendingEnd = 0;
    this.inputAt = 0; this.scene = null; this.sceneAt = -Infinity;
    this.spans.fill(0);
    this.cadence.reset();
  }

  /** The display's refresh interval, as observed from the loop's own callbacks (16.7 ms until it is known). */
  get refreshMs() { return this.cadence.interval ?? 1000 / 60; }

  /** An input event's timestamp: the first one after the last frame counted starts the next burst. */
  input(at) { if (this.inputAt === 0) this.inputAt = at; }

  tick(now) {
    if (this.pendingDoing !== null) this.close(this.pendingDoing, now - this.pendingStart, this.pendingPaint, 0);
    else this.spans.fill(0);
    // The rolling minimum of the intervals (at most 50 ms) is the display's: a stall or an idle loop does not lower it.
    this.cadence.observe(now);
    this.drewBefore = this.drewIn; this.drewIn = null; this.lastTick = now;
  }

  drawn(doing, paintStart, paintEnd) {
    if (!this.foreground()) { this.inputAt = 0; return; }
    this.drewIn = doing;
    if (this.drewBefore === doing) { this.pendingDoing = doing; this.pendingStart = this.lastTick; this.pendingPaint = paintEnd - paintStart; this.pendingEnd = paintEnd; return; }
    // The first frame of a burst: from its input (or its own callback) to the end of its paint.
    const from = this.inputAt > 0 && this.lastTick - this.inputAt < INPUT_MAX_MS ? Math.min(this.inputAt, this.lastTick) : this.lastTick;
    this.close(doing, paintEnd - from, paintEnd - paintStart, this.lastTick - from);
  }

  end(continues) {
    if (continues || this.pendingDoing === null) return;
    // Nothing follows: the frame ends with its paint (its callback ran from `pendingStart`).
    this.close(this.pendingDoing, this.pendingEnd - this.pendingStart, this.pendingPaint, 0);
  }

  /** Counts one frame of `ms`, whose paint took `paint` and which waited `wait` for its callback after the input. */
  close(doing, ms, paint, wait) {
    this.pendingDoing = null; this.inputAt = 0;
    const scene = this.sceneNow();
    if (scene === null || !(ms >= 0)) { this.spans.fill(0); return; }
    const key = doing + scene;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = {doing, scene, frames: 0, late: 0, times: emptyFrameTimes(), worst: 0, lateMs: 0, stages: new Float64Array(STAGES.length)});
    cell.frames++; cell.times[frameStep(ms)]++;
    if (ms > cell.worst) cell.worst = ms;
    if (isLate(ms, this.refreshMs)) {
      cell.late++; cell.lateMs += ms;
      const s = this.spans;
      s[STAGE.wait] = wait;
      s[STAGE.interface] = Math.max(0, paint - s[STAGE.geometry] - s[STAGE.draw]);
      s[STAGE.other] = Math.max(0, ms - wait - s[STAGE.edit] - s[STAGE.geometry] - s[STAGE.draw] - s[STAGE.interface]);
      for (let i = 0; i < s.length; i++) cell.stages[i] += s[i];
      if (this.slow.length < SLOWEST || ms > this.slow[this.slow.length - 1].ms) this.slowMoment(ms, doing, scene);
    }
    this.spans.fill(0);
  }

  slowMoment(ms, doing, scene) {
    this.slow.push({ms, doing, scene, stages: Float64Array.from(this.spans)});
    this.slow.sort((a, b) => b.ms - a.ms);
    if (this.slow.length > SLOWEST) this.slow.length = SLOWEST;
  }

  sceneNow() {
    const now = this.lastTick;
    if (now - this.sceneAt >= SCENE_EVERY_MS || this.scene === null) {
      this.sceneAt = now;
      const segments = this.segments();
      this.scene = sceneOf(segments) ?? this.scene;
    }
    return this.scene;
  }

  /** The session's numbers as a report holds them: `smooth` (one cell per interaction and scene size) and `slow`. */
  summary() {
    const stages = values => {
      const out = {};
      values.forEach((ms, i) => { if (ms > 0) out[STAGES[i]] = Math.min(3.6e6, Math.round(ms * 10) / 10); });
      return Object.keys(out).length ? out : undefined;
    };
    const order = cell => DOING.indexOf(cell.doing) * SCENES.length + SCENES.indexOf(cell.scene);
    const smooth = [...this.cells.values()].sort((a, b) => order(a) - order(b)).map(cell => ({doing: cell.doing, scene: cell.scene,
      frames: cell.frames, late: cell.late, times: [...cell.times], worst: round(cell.worst), lateMs: Math.min(3.6e6, Math.round(cell.lateMs * 10) / 10), stages: stages(cell.stages)}));
    const slow = this.slow.map(moment => ({ms: round(moment.ms), doing: moment.doing, scene: moment.scene, stages: stages(moment.stages)}));
    return {smooth: smooth.length ? smooth : undefined, slow: slow.length ? slow : undefined};
  }

  /** Smooth share over every cell: one minus late over counted (null with nothing counted). */
  smoothShare() {
    let frames = 0, late = 0;
    for (const cell of this.cells.values()) { frames += cell.frames; late += cell.late; }
    return frames ? 1 - late / frames : null;
  }
}

const round = ms => Math.min(6e5, Math.round(ms * 10) / 10);
