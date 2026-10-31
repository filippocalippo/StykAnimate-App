import {messageError} from '../localized-error.mjs';
/**
 * One owner for everything that opens above the editor: modal dialogs, menus,
 * popovers, sheets, the command palette, toasts and the tooltip.
 *
 * The manager keeps the stack of open overlays and derives from it
 *   - the hotkey gate: blocksHotkeys() is true while a modal dialog, a menu,
 *     the palette or a keyboard-scoped popover is open, and while any
 *     <dialog open> exists (today's invariant); `blocking-change` fires when
 *     that flips, and the hotkeys' held keys are released when it turns on;
 *   - close guards: requestClose(reason) asks the overlay's beforeClose(),
 *     which may veto (export progress asks "Stop exporting?");
 *   - focus return: on close, focus goes back to the invoker; when that is
 *     gone or hidden (a button inside a popover that closed), to what opened
 *     the overlay holding it, and finally to fallbackFocus() (the stage),
 *     unless the user already moved focus elsewhere;
 *   - the startup prompt queue: prompts (release notes, the privacy first run,
 *     …) open one at a time, highest priority first, only after markReady()
 *     and only while nothing blocking is open. A prompt whose ready() turns
 *     true later needs a pumpPrompts() call.
 *
 * It owns no document state and never runs commands. Components register
 * their element and hide it themselves in onClose; the manager decides when.
 * Modals stay native <dialog>s (showModal); menus, popovers, sheets and toasts
 * are [popover] elements in the top layer. A menu or popover opened from inside
 * an open modal mounts inside that dialog (overlayMount), or everything outside
 * the dialog would be inert. An overlay whose element left the document (its
 * dialog was removed) is closed the next time the manager looks at the stack.
 *
 * Key listeners registered on window in the capture phase before an overlay
 * opens (the app's Space pan chord tracker) run before any overlay's handler:
 * gate them on blocksHotkeys().
 */
export const OVERLAY_KINDS = Object.freeze(['dialog', 'menu', 'popover', 'palette', 'sheet', 'toast', 'tooltip']);
const BLOCKING_KINDS = new Set(['menu', 'palette']);
const PASSIVE_KINDS = new Set(['toast', 'tooltip']);

/**
 * Where an overlay opened from `anchor` must live: inside the nearest open
 * modal dialog or popover that holds the anchor, else the body. Outside a modal
 * it would be inert; outside an open popover, pressing it would light-dismiss
 * that popover.
 */
export function overlayMount(anchor, doc = anchor?.ownerDocument ?? globalThis.document) {
  let host = null;
  try { host = anchor?.closest?.('dialog[open], [popover]:popover-open') ?? null; } catch { host = anchor?.closest?.('dialog[open]') ?? null; }
  return host ?? doc?.body ?? null;
}

/**
 * showPopover() with the invoker as its source, so the popover joins the
 * invoker's popover ancestry: opening a menu from inside a popover or sheet
 * keeps that host open. Falls back to a plain showPopover().
 */
export function showPopoverFrom(element, source) {
  if (!element?.showPopover || element.matches?.(':popover-open')) return;
  if (source) {
    try { element.showPopover({source}); return; } catch (error) { if (error?.name === 'InvalidStateError') throw error; }
  }
  element.showPopover();
}

/**
 * True when `element` can take focus now: connected, enabled, not inert and
 * rendered. A button inside a closed popover, a hidden panel or an overflowed
 * toolbar is none of those, and focus() on it would silently do nothing.
 */
export function canTakeFocus(element) {
  return Boolean(element && typeof element.focus === 'function' && element.isConnected !== false && !element.disabled &&
    !element.closest?.('[inert]') && element.checkVisibility?.() !== false);
}

/**
 * Focuses the first candidate that takes focus and returns it (null when
 * none does). A candidate counts only if focus really landed on it, so an
 * element made inert by a modal falls through to the next one.
 */
export function focusFirst(candidates, {preventScroll = true, focusVisible, document: doc = null} = {}) {
  for (const node of candidates) {
    if (!canTakeFocus(node)) continue;
    try { node.focus(focusVisible === undefined ? {preventScroll} : {preventScroll, focusVisible}); } catch { continue; }
    const active = (node.ownerDocument ?? doc)?.activeElement;
    if (active === undefined || active === node || node.contains?.(active)) return node;
  }
  return null;
}

export class OverlayManager extends EventTarget {
  #entries = [];
  #nextId = 1;
  #blocking = false;
  #prompts = [];
  #promptOrder = 0;
  #activePrompt = null;
  #ready = false;
  #pumpQueued = false;
  #pruning = false;

  /**
   * hotkeys        anything with releaseAll() (the HotkeyManager)
   * fallbackFocus  () => element that takes focus when the invoker is gone (the stage)
   * document       the document the overlays live in
   * schedule       defers prompt pumping (queueMicrotask)
   * onError        reports errors from guards and prompts (globalThis.reportError)
   */
  constructor({hotkeys = null, fallbackFocus = null, document: doc = globalThis.document, schedule = callback => queueMicrotask(callback),
    onError = error => globalThis.reportError?.(error)} = {}) {
    super();
    this.hotkeys = hotkeys;
    this.fallbackFocus = fallbackFocus;
    this.document = doc ?? null;
    this.schedule = schedule;
    this.onError = onError;
    this.lastInput = 'keyboard';
  }

  /**
   * Adds an open overlay to the stack and returns its handle.
   *
   *   kind           one of OVERLAY_KINDS
   *   modal          a modal dialog (always blocks hotkeys)
   *   keyboardScope  the overlay takes all typing (popovers and sheets opt in)
   *   invoker        the element focus returns to (default: the focused element);
   *                  when it sits in another open overlay, that overlay's own
   *                  return targets follow it (handle.returnTo)
   *   returnFocus    false leaves focus alone on close
   *   beforeClose    (reason) => false | Promise<false> vetoes requestClose()
   *   onClose        (value, reason) hides the element; runs once
   *   closeOnEscape  false keeps the global Escape fallback away (default true)
   *   signal         closes the overlay when it aborts
   *
   * handle: {id, kind, element, signal, result, invoker, returnTo, open, close(value, reason), requestClose(reason)}.
   * `signal` aborts on close: give it to listeners, observers and timers.
   */
  register(element, {kind = 'popover', modal = false, keyboardScope = false, invoker, returnFocus = true, beforeClose = null,
    onClose = null, closeOnEscape = true, signal} = {}) {
    if (!OVERLAY_KINDS.includes(kind)) throw messageError(new TypeError(''), "errors.overlayManager.unknownOverlayKind", {kind: kind});
    const controller = new AbortController();
    let resolve;
    const entry = {
      id: this.#nextId++, kind, element, modal: Boolean(modal), keyboardScope: Boolean(keyboardScope), returnFocus, beforeClose, onClose,
      closeOnEscape, controller, open: true, closing: null,
      invoker: invoker === undefined ? this.document?.activeElement ?? null : invoker,
      result: new Promise(done => { resolve = done; }),
    };
    entry.resolve = resolve;
    entry.returnTo = Object.freeze(this.#returnChain(entry.invoker));
    const handle = entry.handle = Object.freeze({
      id: entry.id, kind, element, signal: controller.signal, result: entry.result, invoker: entry.invoker, returnTo: entry.returnTo,
      get open() { return entry.open; },
      close: (value, reason = 'close') => this.#finish(entry, value, reason),
      requestClose: reason => this.#requestClose(entry, reason),
    });
    this.#entries.push(entry);
    if (signal) {
      if (signal.aborted) { this.#finish(entry, undefined, 'abort'); return handle; }
      signal.addEventListener('abort', () => this.#finish(entry, undefined, 'abort'), {once: true, signal: controller.signal});
    }
    this.dispatchEvent(new CustomEvent('open', {detail: {handle, kind, modal: entry.modal}}));
    this.#updateBlocking();
    return handle;
  }

  /** True while typing belongs to an overlay rather than the editor's hotkeys. */
  blocksHotkeys() {
    this.#prune();
    return this.#entries.some(entry => entry.modal || entry.keyboardScope || BLOCKING_KINDS.has(entry.kind)) ||
      Boolean(this.document?.querySelector?.('dialog[open]'));
  }

  /** The open handles, bottom first. */
  list() { return this.#entries.map(entry => entry.handle); }

  /** The topmost open handle, optionally of the given kinds; passive toasts and tooltips are skipped by default. */
  top(kinds = null) {
    this.#prune();
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (kinds ? kinds.includes(entry.kind) : !PASSIVE_KINDS.has(entry.kind)) return entry.handle;
    }
    return null;
  }

  handleFor(element) { return this.#entries.find(entry => entry.element === element)?.handle ?? null; }

  /** Asks every overlay to close, top first; stops at the first veto. Resolves true when all closed. */
  async closeAll(reason = 'close-all', {kinds = null} = {}) {
    this.#prune();
    for (const entry of [...this.#entries].reverse()) {
      if (kinds && !kinds.includes(entry.kind)) continue;
      if (!(await this.#requestClose(entry, reason))) return false;
    }
    return true;
  }

  /** True when the most recent input before an overlay opened was a pointer (dialogs then focus without a ring). */
  openedByPointer() { return this.lastInput === 'pointer'; }

  /**
   * Document listeners: input modality for the focus rule, Escape for the
   * topmost overlay that has no Escape handling of its own (manual popovers,
   * sheets), and dialogs the manager does not know (the legacy #dialog)
   * opening or closing, which changes the gate and may free the prompt queue.
   * Modal dialogs handle Escape through their `cancel` event.
   */
  install({signal} = {}) {
    const doc = this.document;
    if (!doc?.addEventListener) return;
    const dialogChanged = event => {
      if (event.target?.localName !== 'dialog') return;
      this.#updateBlocking();
      this.#queuePump();
    };
    doc.addEventListener('close', dialogChanged, {capture: true, signal});
    doc.addEventListener('toggle', dialogChanged, {capture: true, signal});
    doc.addEventListener('pointerdown', () => { this.lastInput = 'pointer'; }, {capture: true, signal});
    doc.addEventListener('keydown', event => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) this.lastInput = 'keyboard';
    }, {capture: true, signal});
    doc.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const top = this.#entries.findLast(entry => !PASSIVE_KINDS.has(entry.kind));
      if (!top || top.kind === 'dialog' || top.closeOnEscape === false) return;
      event.preventDefault();
      event.stopPropagation();
      this.#requestClose(top, 'escape');
    }, {signal});
  }

  // -------------------------------------------------------------------------
  // Startup prompt queue

  /**
   * Queues a prompt that must not interrupt: `open()` shows it and returns a
   * promise that settles when it is dismissed. `ready()` is asked on every pump
   * (for example "the release notes are loaded"). Higher priority opens first;
   * equal priorities keep their queue order. Returns false for a duplicate id.
   */
  enqueuePrompt({id, priority = 0, ready = () => true, open}) {
    if (typeof open !== 'function') throw messageError(new TypeError(''), "errors.overlayManager.aPromptNeedsAnOpenFunction", {});
    if (this.#activePrompt?.id === id || this.#prompts.some(prompt => prompt.id === id)) return false;
    this.#prompts.push({id, priority, ready, open, order: this.#promptOrder++});
    this.#queuePump();
    return true;
  }

  cancelPrompt(id) {
    const before = this.#prompts.length;
    this.#prompts = this.#prompts.filter(prompt => prompt.id !== id);
    return this.#prompts.length !== before;
  }

  /** The prompt ids still waiting, in the order they would open. */
  pendingPrompts() { return this.#sortedPrompts().map(prompt => prompt.id); }

  get activePrompt() { return this.#activePrompt?.id ?? null; }

  /** Call once the first frame has rendered: prompts may open from now on. */
  markReady() { this.#ready = true; this.#queuePump(); }

  /**
   * Opens the next ready prompt if nothing blocks; returns its id or null.
   * Safe to call at any time; call it when a waiting prompt's ready() may have
   * turned true (the release notes finished loading).
   */
  pumpPrompts() {
    this.#pumpQueued = false;
    if (!this.#ready || this.#activePrompt || this.blocksHotkeys()) return null;
    const next = this.#sortedPrompts().find(prompt => {
      try { return prompt.ready() !== false; } catch (error) { this.onError(error); return false; }
    });
    if (!next) return null;
    this.#prompts.splice(this.#prompts.indexOf(next), 1);
    this.#activePrompt = next;
    let shown;
    try { shown = next.open(); } catch (error) { shown = Promise.reject(error); }
    Promise.resolve(shown).catch(this.onError).finally(() => {
      if (this.#activePrompt === next) this.#activePrompt = null;
      this.#queuePump();
    });
    this.dispatchEvent(new CustomEvent('prompt', {detail: {id: next.id}}));
    return next.id;
  }

  #sortedPrompts() { return [...this.#prompts].sort((a, b) => b.priority - a.priority || a.order - b.order); }

  #queuePump() {
    if (this.#pumpQueued || !this.#ready) return;
    this.#pumpQueued = true;
    this.schedule(() => this.pumpPrompts());
  }

  // -------------------------------------------------------------------------

  async #requestClose(entry, reason = 'request') {
    if (!entry.open) return true;
    if (entry.closing) return entry.closing;
    if (!entry.beforeClose) { this.#finish(entry, undefined, reason); return true; }
    entry.closing = (async () => {
      let allowed = true;
      try { allowed = (await entry.beforeClose(reason)) !== false; } catch (error) { this.onError(error); allowed = false; }
      entry.closing = null;
      if (allowed) this.#finish(entry, undefined, reason);
      return allowed;
    })();
    return entry.closing;
  }

  #finish(entry, value, reason) {
    if (!entry.open) return;
    entry.open = false;
    this.#entries.splice(this.#entries.indexOf(entry), 1);
    entry.controller.abort();
    try { entry.onClose?.(value, reason); } catch (error) { this.onError(error); }
    if (entry.returnFocus !== false) this.#restoreFocus(entry);
    entry.resolve(value);
    this.dispatchEvent(new CustomEvent('close', {detail: {handle: entry.handle, kind: entry.kind, value, reason}}));
    this.#updateBlocking();
    this.#queuePump();
  }

  #restoreFocus(entry) {
    const doc = this.document, active = doc?.activeElement;
    // Leave focus alone when the user moved it somewhere else (a click on another control).
    const lost = !active || active === doc.body || active === entry.element || entry.element?.contains?.(active) || active.isConnected === false;
    if (!lost) return;
    let fallback = null;
    try { fallback = this.fallbackFocus?.() ?? null; } catch (error) { this.onError(error); }
    focusFirst([...entry.returnTo, fallback], {document: doc});
  }

  /** The invoker, then the return targets of the open overlay that holds it (a button in the Document popover → the popover's anchor). */
  #returnChain(invoker) {
    if (!invoker) return [];
    const owner = this.#entries.findLast(entry => entry.element && entry.element !== invoker && entry.element.contains?.(invoker));
    return [invoker, ...(owner?.returnTo ?? []).filter(node => node !== invoker)];
  }

  /** Closes overlays whose element left the document (removed with their dialog): removal fires no close or toggle event. */
  #prune() {
    if (this.#pruning) return;
    const gone = this.#entries.filter(entry => entry.element?.isConnected === false);
    if (!gone.length) return;
    this.#pruning = true;
    try { for (const entry of gone.reverse()) this.#finish(entry, undefined, 'disconnected'); } finally { this.#pruning = false; }
  }

  #updateBlocking() {
    const blocking = this.blocksHotkeys();
    if (blocking === this.#blocking) return;
    this.#blocking = blocking;
    if (blocking) {
      try { this.hotkeys?.releaseAll?.(); } catch (error) { this.onError(error); }
    }
    this.dispatchEvent(new CustomEvent('blocking-change', {detail: {blocking}}));
  }
}

export function createOverlayManager(options) { return new OverlayManager(options); }
