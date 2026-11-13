/**
 * `problem` reports (docs/STATISTICS.md): an error, an engine panic, a lost graphics device or a stopped worker, as text made
 * safe to send, its message key when the app raised it, stack lines through our own code, what the app was doing, the last
 * commands, the scene size and the features that were on. The same problem in one session is one report with a count.
 */
import {ACTIVITIES, FEATURES, PROBLEM_TYPES, SCENES, sanitizeMessage} from './schema.mjs';
import {ourStack, panicDetails} from './stack.mjs';
import {UserActionError} from '../user-action-error.mjs';
import english from '../locales/en.mjs';

const MESSAGE_KEY = /^[A-Za-z][\w.]{0,119}$/;
/** The problems one session keeps: a session that hits more is already understood. */
const MAX_PROBLEMS = 64;
/** A trap that follows an engine panic within this time is the panic's, already reported. */
const PANIC_TRAP_MS = 3000;

/** Whether `error` is a problem at all: a person's cancel and an action refused with a message to them are not. */
export function isProblem(error) {
  if (error == null || error instanceof UserActionError) return false;
  return error.name !== 'AbortError' && !(globalThis.DOMException && error instanceof DOMException && error.name === 'AbortError');
}

/**
 * The English text of a message key with its placeholders left unfilled: a problem's message is the text the code wrote,
 * whatever language the interface shows, so the same problem reads the same from every installation.
 */
const englishOf = key => { const text = english[key]; return typeof text === 'string' ? text : typeof text?.other === 'string' ? text.other : ''; };

/** The report fields an error gives: type, cleaned message, key and stack. */
export function describeError(error, type = 'error') {
  if (error?.panic) return describePanic(error.panic);
  const key = typeof error?.messageKey === 'string' && MESSAGE_KEY.test(error.messageKey) ? error.messageKey : undefined;
  const text = key && englishOf(key) || (typeof error === 'object' && error !== null ? error.message : error);
  const message = sanitizeMessage(text) || sanitizeMessage(error?.name) || 'Error';
  const name = typeof error?.name === 'string' && /^\w{1,40}$/.test(error.name) && error.name !== 'Error' && !message.startsWith(error.name) ? `${error.name}: ` : '';
  return {type: PROBLEM_TYPES.includes(type) ? type : 'error', message: sanitizeMessage(name + message), ...(key ? {key} : {}),
    stack: ourStack(error?.workerStack ?? error?.stack)};
}

/** The report fields an engine panic gives (src/engine/engine-panic.mjs). */
export function describePanic(panic) {
  const details = panicDetails(panic.text, panic.stack);
  return {type: 'engine', message: sanitizeMessage(details.message) || 'engine panic', stack: details.stack};
}

export class Problems {
  constructor() { this.list = new Map(); this.changed = new Set(); this.lastPanicAt = -Infinity; }

  /**
   * Records one occurrence; returns the report when it is new or changed (to send now), else null. `context`: {doing, trail,
   * scene, features, recovered}.
   */
  add(fields, context = {}) {
    if (fields.type === 'engine') this.lastPanicAt = Date.now();
    else if (/^RuntimeError\b/.test(fields.message) && Date.now() - this.lastPanicAt < PANIC_TRAP_MS) return null;
    const signature = JSON.stringify([fields.type, fields.key ?? '', fields.message, fields.stack]);
    let report = this.list.get(signature);
    if (report) {
      report.times = Math.min(1e5, report.times + 1);
      if (context.recovered === true) report.recovered = true;
      this.changed.add(signature);
      return null;
    }
    if (this.list.size >= MAX_PROBLEMS) return null;
    report = {kind: 'problem', ...fields, doing: ACTIVITIES.includes(context.doing) ? context.doing : 'unknown',
      trail: (context.trail ?? []).slice(-20),
      ...(SCENES.includes(context.scene) ? {scene: context.scene} : {}),
      ...(context.features?.length ? {features: [...new Set(context.features)].filter(name => FEATURES.includes(name))} : {}),
      ...(typeof context.recovered === 'boolean' ? {recovered: context.recovered} : {}), times: 1};
    this.list.set(signature, report);
    return report;
  }

  /** A problem that came right: a graphics device lost and then back. */
  recovered(type) {
    for (const [signature, report] of this.list) if (report.type === type && report.recovered === false) { report.recovered = true; this.changed.add(signature); }
  }

  /** The reports that changed since the last call (a repeat, a recovery): sent again with their totals. */
  drainChanged() {
    const out = [...this.changed].map(signature => this.list.get(signature));
    this.changed.clear();
    return out;
  }
}
