/**
 * Engine panics, kept for statistics (docs/STATISTICS.md, "Problems").
 *
 * Each WebAssembly module's panic hook (engine/crates/styk-wasm/src/lib.rs `start`, and the codec's and the drawing engine's)
 * writes "StykAnimate … panic: panicked at <file>:<line>:<column>:\n<message>" to `console.error` on the thread it ran on,
 * just before the module traps. `capturePanics` runs on the interface thread and in every engine worker: it keeps that text
 * with the stack the hook ran in (whose WebAssembly lines name the Rust functions), and the console still gets it. A worker
 * forwards what it kept with the failure it posts (`lastPanic`); the interface thread hands each panic to `onEnginePanic`.
 */
import {isPanicText} from '../stats/stack.mjs';

let installed = false, last = null;
const listeners = new Set();

/** Starts keeping this thread's engine panics; `forward(panic)` also hears each one (a worker posts it). Once per thread. */
export function capturePanics(forward) {
  if (forward) listeners.add(forward);
  if (installed || typeof console === 'undefined') return;
  installed = true;
  const write = console.error;
  console.error = function (...args) {
    if (isPanicText(args[0])) enginePanicked({text: args[0], stack: new Error().stack ?? '', at: Date.now()});
    return write.apply(this, args);
  };
}

/** A panic this thread saw or a worker forwarded: `{text, stack, at}`. */
export function enginePanicked(panic) {
  if (!panic || typeof panic.text !== 'string') return;
  last = {text: panic.text.slice(0, 2000), stack: String(panic.stack ?? '').slice(0, 8000), at: Number(panic.at) || Date.now()};
  for (const listener of listeners) { try { listener(last); } catch { /* a listener's failure is not the engine's */ } }
}

/** The last panic seen on this thread within `withinMs`, or null: what a worker sends with the failure that follows it. */
export function lastPanic(withinMs = 10000) { return last && Date.now() - last.at <= withinMs ? last : null; }

/** Hears every panic, of this thread and forwarded ones; returns the function that stops it. */
export function onEnginePanic(listener) { listeners.add(listener); return () => listeners.delete(listener); }
