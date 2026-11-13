/**
 * The top band (experience.md §2): its measurement for the layout solver
 * (architecture §3.11.4) and its sessions (syncBandSession, at the end).
 *
 * The band folds its labels and spacing in a fixed order (the solver's
 * BAND_FOLDS) before the menubar folds into the mark, and the menubar folds
 * only where even the last step does not fit (the minimal tier). Each step
 * is a token of the band's `data-band` attribute that the band's stylesheet
 * (styles/layout/topbar.css) turns into a fold; `menus` folds the menubar.
 *
 * measureBand() reads the band's narrowest unwrapped width with no step,
 * then after each step that makes it narrower (a step the band has no rule
 * for, or one that frees nothing, such as the window controls in a browser,
 * is left out), with the menubar docked and, when asked, folded. The band is
 * a grid of three clusters whose side columns share the room left of and
 * right of the workspace switch but never take less than their content, so
 * its min-content width is its clusters side by side (its max-content width
 * would count the wider side twice). It changes only the band's own
 * attribute and inline size and restores both before it returns, so the page
 * never paints a measuring state. The widths do not depend on
 * the window, so the band is measured again only when its content changes
 * (a name, a language, a session's buttons, the window controls), never on
 * a resize. A part that reserves the width of its widest text
 * ([data-band-reserve]: the save state) counts by what it reserves, so
 * editing and saving never measure the band again.
 *
 * Startup (the +25 ms gate): the first commit uses the widths this band had
 * last time (localStorage, keyed by the band's content, language and pixel
 * ratio) and measures again in idle time once `start` (the editor ready)
 * and the fonts have settled; a wide window with nothing stored waits the
 * same way, since nothing folds there. The pass with the menubar folded runs
 * only once a window is narrow enough to need it.
 */
import {BAND_FOLDS, TIER_THRESHOLDS} from './layout-solver.mjs';

/**
 * The lowest top a floating box opened under the band may take (a menu, a
 * popover, a message): the band's bottom edge while it is a row across the
 * window, 0 where the touch interface turns it into a wing down the window's
 * side (docs/TOUCH.md). A wing is taller than it is wide.
 */
export function bandBottom(doc = globalThis.document) {
  const box = doc?.querySelector?.('.titlebar')?.getBoundingClientRect();
  if (!box || !(box.width > 0)) return 0;
  return box.width >= box.height ? box.bottom : 0;
}

/** The band token that folds the menubar into the mark (the minimal tier). */
export const MENUBAR_FOLD = 'menus';
const CACHE_KEY = 'stykanimate.band-widths.v1';
/** A window at least this wide folds nothing, so its first commit need not wait for the band's measurement. */
const WIDE = TIER_THRESHOLDS.width.regular + 1;

/**
 * The solver's `bandMin` from a width function: `width(tokens)` is the
 * band's width with those `data-band` tokens applied. Pure, so the fold
 * logic is testable without a DOM. `docked` and `folded` choose the passes
 * (the widths, and `minimal` with the menubar folded).
 */
export function collectBandWidths(width, steps = BAND_FOLDS, {docked = true, folded = true} = {}) {
  const run = base => {
    const applied = [...base];
    const widths = {none: width(applied)};
    let last = widths.none;
    for (const step of steps) {
      const after = width([...applied, step]);
      if (!(after < last)) continue;
      applied.push(step);
      widths[step] = last = after;
    }
    return widths;
  };
  const widths = docked ? run([]) : {};
  if (folded) widths.minimal = run([MENUBAR_FOLD]);
  return widths;
}

/** Measures `band` (the `.titlebar`) for the solver; see the module comment. */
export function measureBand(band, {steps = BAND_FOLDS, docked = true, folded = true} = {}) {
  const live = band.getAttribute('data-band'), inline = band.style.inlineSize;
  const width = tokens => {
    if (tokens.length) band.setAttribute('data-band', tokens.join(' '));
    else band.removeAttribute('data-band');
    return Math.ceil(band.getBoundingClientRect().width);
  };
  band.style.inlineSize = 'min-content';
  try {
    return collectBandWidths(width, steps, {docked, folded});
  } finally {
    band.style.inlineSize = inline;
    if (live === null) band.removeAttribute('data-band');
    else band.setAttribute('data-band', live);
  }
}

/**
 * Whether a font face's `unicode-range` (`U+0000-00FF, U+0131, U+4??`) covers a character of `text`; a range that
 * cannot be read covers everything. The interface fonts come in subsets per script (base/fonts.css) that load as text
 * needs them: a subset that covers none of the band's characters cannot change the band's width.
 */
export function rangeCoversText(range, text) {
  const spans = [];
  for (const part of String(range ?? '').split(',')) {
    const match = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(part);
    if (!match) return true;
    const [, first, last] = match;
    spans.push(last ? [parseInt(first, 16), parseInt(last, 16)] : [parseInt(first.replace(/\?/g, '0'), 16), parseInt(first.replace(/\?/g, 'f'), 16)]);
  }
  if (!spans.length) return true;
  for (const character of String(text ?? '')) {
    const code = character.codePointAt(0);
    if (spans.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

/** A cheap fingerprint of what can change the band's width: its text and which parts show. */
function signature(band) {
  let text = '';
  const walker = band.ownerDocument.createTreeWalker(band, 4);   // NodeFilter.SHOW_TEXT
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (!node.parentElement?.closest('[data-band-reserve]')) text += node.data;
  for (const element of band.querySelectorAll('*')) {
    // A reserved part counts by what it reserves, not by its current words or state class.
    if (element.hasAttribute('data-band-reserve')) text += `|${element.hidden ? 1 : 0}${element.getAttribute('data-band-reserve')}`;
    else text += `|${element.hidden ? 1 : 0}${element.getAttribute('class') ?? ''}`;
  }
  return text;
}

/** A short, stable key for a fingerprint (FNV-1a). */
function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return (value >>> 0).toString(36);
}

/**
 * Keeps the band's measurement current. `current` is the latest `bandMin`
 * (null until the band is known); `forWidth(width)` returns it with the
 * folded pass measured first when a window that narrow needs it;
 * `onChange()` runs after a change that alters it. It measures again after
 * the band's text or parts change (once per frame at most, and only when the
 * fingerprint differs) and when fonts load after it measured.
 */
export function watchBand(band, {window: win = globalThis.window, document: doc = band.ownerDocument, onChange = () => {},
  storage = null, start = null, margin = 24, minimalWidth = TIER_THRESHOLDS.width.minimal} = {}) {
  let current = null, key = '', printed = '', frame = 0, idle = 0, stopped = false;
  // The touch interface sizes the band's controls for a finger: its widths are its own.
  const cacheId = print => hash(`${print}|${doc.documentElement.lang}|${win.devicePixelRatio ?? 1}|${doc.documentElement.dataset.input ?? ''}`);
  const readCache = id => {
    try { return JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null')?.[id] ?? null; } catch { return null; }
  };
  const writeCache = (id, widths) => {
    try { storage?.setItem(CACHE_KEY, JSON.stringify({[id]: widths})); } catch { /* storage full or unavailable */ }
  };
  const narrowest = widths => Math.min(...Object.entries(widths).filter(([step]) => step !== 'minimal').map(([, value]) => value));
  // The folded pass matters where the tier is minimal: a narrow window, or one the docked band does not fit.
  const needsFolded = (width, widths) => width <= minimalWidth || narrowest(widths) + margin > width;
  const apply = (next, {quiet = false} = {}) => {
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;
    current = next;
    key = nextKey;
    if (!quiet) onChange(current);
  };
  /** Measures the band now; the folded pass too when `folded` or the window needs it. `quiet`: before the first commit. */
  const measure = ({folded = false, quiet = false} = {}) => {
    frame = 0;
    if (stopped || !band.isConnected) return;
    printed = signature(band);
    const next = measureBand(band, {folded: false});
    if (folded || needsFolded(win.innerWidth, next)) next.minimal = measureBand(band, {docked: false}).minimal;
    writeCache(cacheId(printed), next);
    apply(next, {quiet});
  };
  // While the first measurement waits (startup), changes wait for it too.
  let deferred = false;
  const schedule = () => { if (!frame && !stopped && !deferred) frame = win.requestAnimationFrame(() => measure()); };
  const observer = new win.MutationObserver(() => { if (!deferred && signature(band) !== printed) schedule(); });
  observer.observe(band, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-band-reserve']});
  const fonts = doc.fonts;
  // Fonts that load after the band was measured refit it (a deferred first measurement waits for them instead), unless
  // none of them covers a character the band shows: another script's subset, loaded for text elsewhere (a window resize
  // that lays out new text loads them), which made the band measure itself again at every step of the fold.
  const refit = event => {
    const faces = event?.fontfaces ? [...event.fontfaces] : [];
    if (faces.length && !faces.some(face => rangeCoversText(face.unicodeRange, band.textContent))) return;
    printed = '';
    schedule();
  };
  fonts?.addEventListener?.('loadingdone', refit);

  // The first commit: the stored widths, or nothing to fold on a wide window, else a measurement now.
  printed = signature(band);
  const stored = readCache(cacheId(printed));
  if (stored || win.innerWidth >= WIDE) {
    if (stored) { current = stored; key = JSON.stringify(stored); }
    deferred = true;
    const later = () => { idle = 0; deferred = false; measure(); };
    // Once the fonts are ready, in idle time: one measurement, off the startup path.
    const whenIdle = () => { if (!stopped) idle = win.requestIdleCallback ? win.requestIdleCallback(later, {timeout: 2000}) : win.setTimeout(later, 200); };
    Promise.all([start, fonts?.status === 'loaded' ? null : fonts?.ready]).then(whenIdle, whenIdle);
  } else {
    measure({quiet: true});
    if (fonts && fonts.status !== 'loaded') fonts.ready?.then(refit, () => {});
  }
  return {
    get current() { return current; },
    /** `current`, with the folded pass measured first when a window `width` px wide needs it. */
    forWidth(width) {
      if (current && !current.minimal && needsFolded(width, current)) measure({folded: true});
      return current;
    },
    /** Measures now (a language or scale change the fingerprint cannot see). */
    refresh() { if (frame) win.cancelAnimationFrame(frame); measure(); },
    stop() {
      stopped = true;
      observer.disconnect();
      fonts?.removeEventListener?.('loadingdone', refit);
      if (frame) win.cancelAnimationFrame(frame);
      if (idle) (win.cancelIdleCallback && win.requestIdleCallback ? win.cancelIdleCallback(idle) : win.clearTimeout(idle));
    },
  };
}

/** The sessions the band shows (experience.md §2): Build, a movieclip and the camera; '' at rest. */
export const BAND_SESSIONS = Object.freeze(['build', 'movieclip', 'camera']);

/**
 * Shows the band's buttons for `session` (a BAND_SESSIONS name, or '' at
 * rest): the buttons marked `data-band-session` with that name show (Build's
 * Test rig and Done, a movieclip's Cancel and Done, the camera's Done), and
 * the one Export turns from the ink primary into a quiet button beside the
 * session's Done, so every session keeps Export in one click. Writes only
 * when the session changes; showing or hiding a button re-measures the band
 * (watchBand sees `hidden` change), so its folds follow the session's buttons.
 */
export function syncBandSession(band, session = '') {
  if (!band) return false;
  const next = BAND_SESSIONS.includes(session) ? session : '';
  if ((band.getAttribute('data-session') ?? '') === next) return false;
  if (next) band.setAttribute('data-session', next);
  else band.removeAttribute('data-session');
  for (const button of band.querySelectorAll('[data-band-session]')) {
    const shown = button.dataset.bandSession.split(' ').includes(next);
    if (button.hidden === shown) button.hidden = !shown;
  }
  const exportButton = band.querySelector('.band-export');
  if (exportButton) exportButton.dataset.variant = next ? 'ghost' : 'primary';
  return true;
}
