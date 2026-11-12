/**
 * Input for scenarios: the pointer, the wheel and the keyboard, sent through the inspector protocol. The page receives
 * trusted events exactly as it does from a person's devices, but nothing touches the system's mouse or keyboard, so a
 * run never disturbs whoever is at the computer.
 *
 * A gesture has the duration it was given, whatever the app makes of it: moves are sent on a clock (a person's hand
 * does not wait for the app), and where the app is slow the browser merges the moves it could not deliver, as it does
 * with a real mouse. So a scenario always takes the same time, and a slow app shows up as fewer, later frames.
 */
import {performance} from 'node:perf_hooks';

const BUTTONS = {left: 1, right: 2, middle: 4};
const MODIFIERS = {alt: 1, ctrl: 2, meta: 4, shift: 8};
/** Keys by the name scenarios use: [key, code, Windows virtual key code]. Letters and digits are derived. */
const KEYS = {
  Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27], Space: [' ', 'Space', 32], Tab: ['Tab', 'Tab', 9], Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34],
  Comma: [',', 'Comma', 188], Period: ['.', 'Period', 190], Minus: ['-', 'Minus', 189], Equal: ['=', 'Equal', 187], BracketLeft: ['[', 'BracketLeft', 219], BracketRight: [']', 'BracketRight', 221],
  Control: ['Control', 'ControlLeft', 17], Shift: ['Shift', 'ShiftLeft', 16], Alt: ['Alt', 'AltLeft', 18],
};
function keyOf(name) {
  if (KEYS[name]) return KEYS[name];
  if (/^[a-z]$/i.test(name)) return [name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  if (/^\d$/.test(name)) return [name, `Digit${name}`, name.charCodeAt(0)];
  if (/^F\d{1,2}$/.test(name)) return [name, name, 111 + Number(name.slice(1))];
  throw new Error(`Unknown key ${JSON.stringify(name)}: add it to perf/lib/input.mjs.`);
}
const modifierBits = held => Object.entries(MODIFIERS).reduce((bits, [name, bit]) => bits | (held?.[name] ? bit : 0), 0);

/** Waits until `time` (performance.now ms) more exactly than a timer does: a timer for most of it, then turns of the event loop. */
async function until(time) {
  const coarse = time - performance.now() - 4;
  if (coarse > 0) await new Promise(resolve => setTimeout(resolve, coarse));
  while (performance.now() < time) await new Promise(resolve => setImmediate(resolve));
}

/** The input of one app (`app.inspector`, `app.page`). Positions are CSS pixels in the window. */
export function createInput(app) {
  const send = (method, params) => app.inspector.send(method, params, app.page);
  const state = {x: 0, y: 0, buttons: 0, modifiers: 0};
  const mouse = (type, extra = {}) => send('Input.dispatchMouseEvent', {type, x: state.x, y: state.y, buttons: state.buttons, modifiers: state.modifiers, pointerType: 'mouse', ...extra});
  const input = {
    async move(x, y) { state.x = x; state.y = y; await mouse('mouseMoved', {button: 'none'}); },
    async down(button = 'left', {clickCount = 1} = {}) { state.buttons |= BUTTONS[button]; await mouse('mousePressed', {button, clickCount}); },
    async up(button = 'left', {clickCount = 1} = {}) { state.buttons &= ~BUTTONS[button]; await mouse('mouseReleased', {button, clickCount}); },
    async click(x, y, {button = 'left', count = 1, ...held} = {}) {
      const before = state.modifiers;
      state.modifiers = modifierBits(held) | before;
      await input.move(x, y);
      for (let press = 1; press <= count; press++) { await input.down(button, {clickCount: press}); await input.up(button, {clickCount: press}); }
      state.modifiers = before;
    },
    /**
     * Moves the pointer along `path(t)` (t from 0 to 1, returning {x, y}) for `durationMs`, one move every 1/`hz` s,
     * with `button` held (null: a hover). The moves leave on time whether or not the app has handled the one before.
     * Resolves when the app has taken every event of the gesture, the release included.
     */
    async stroke(path, {durationMs = 1500, hz = 120, button = 'left', release = true} = {}) {
      const first = path(0), sent = [];
      await input.move(first.x, first.y);
      if (button) await input.down(button);
      const steps = Math.max(1, Math.round(durationMs / 1000 * hz)), started = performance.now();
      for (let step = 1; step <= steps; step++) {
        await until(started + step * 1000 / hz);
        const point = path(step / steps);
        state.x = point.x; state.y = point.y;
        sent.push(mouse('mouseMoved', {button: button ?? 'none'}).catch(() => {}));
      }
      await Promise.all(sent);
      if (button && release) await input.up(button);
    },
    /**
     * Turns the wheel at (x, y): `notches` events of `deltaY` each over `durationMs`, on a clock like `stroke`.
     * `ctrl: true` is the zoom gesture.
     */
    async wheel(x, y, {notches = 30, deltaY = -100, deltaX = 0, durationMs = 1000, ...held} = {}) {
      const before = state.modifiers, sent = [];
      state.modifiers = modifierBits(held) | before;
      await input.move(x, y);
      const started = performance.now();
      for (let notch = 0; notch < notches; notch++) {
        await until(started + notch * durationMs / notches);
        const delta = typeof deltaY === 'function' ? deltaY(notch) : deltaY;
        sent.push(mouse('mouseWheel', {button: 'none', deltaX, deltaY: delta}).catch(() => {}));
      }
      await Promise.all(sent);
      state.modifiers = before;
    },
    async keyDown(name, held) {
      const [key, code, virtual] = keyOf(name), modifiers = modifierBits(held) | state.modifiers;
      const printable = key.length === 1 && !(modifiers & (MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.meta));
      await send('Input.dispatchKeyEvent', {type: printable ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers, ...(printable ? {text: key} : {})});
    },
    async keyUp(name, held) {
      const [key, code, virtual] = keyOf(name);
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers: modifierBits(held) | state.modifiers});
    },
    /** One press of a key, with any of {ctrl, shift, alt, meta} held. */
    async key(name, held) { await input.keyDown(name, held); await input.keyUp(name, held); },
    /** Presses a key `count` times over `durationMs`, on a clock (a held arrow key, a run of frame steps). */
    async keys(name, {count = 20, durationMs = 1000, ...held} = {}) {
      const started = performance.now(), sent = [];
      for (let press = 0; press < count; press++) {
        await until(started + press * durationMs / count);
        sent.push(input.key(name, held).catch(() => {}));
      }
      await Promise.all(sent);
    },
    /** Holds a modifier for the moves and presses that follow, until `release(name)`. */
    async hold(name) { state.modifiers |= MODIFIERS[name]; await input.keyDown({ctrl: 'Control', shift: 'Shift', alt: 'Alt'}[name]); },
    async release(name) { state.modifiers &= ~MODIFIERS[name]; await input.keyUp({ctrl: 'Control', shift: 'Shift', alt: 'Alt'}[name]); },
  };
  return input;
}

/** Paths for `stroke`, around a centre: shapes a hand makes, which keep moving for the whole gesture. */
export const paths = {
  /** A straight line from `from` to `to`. */
  line: (from, to) => t => ({x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t}),
  /** `turns` circles of `radius` starting and ending at `centre`'s right. */
  circle: (centre, radius, turns = 1) => t => ({x: centre.x + Math.cos(t * turns * 2 * Math.PI) * radius, y: centre.y + Math.sin(t * turns * 2 * Math.PI) * radius}),
  /** Out from `start` and round an ellipse, ending away from the start (a drag that ends displaced). */
  sweep: (start, width, height) => t => ({x: start.x + Math.sin(t * Math.PI * 1.5) * width, y: start.y - (1 - Math.cos(t * Math.PI * 1.5)) * height}),
};
