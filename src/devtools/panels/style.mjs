/**
 * The developer panel's and the overlay's look (developer build only): one stylesheet over the app's design tokens,
 * each with a fallback for a page without them, and the colours the canvas charts read from it.
 *
 * Colours come from the tokens, so both follow the light and the dark theme: the panel sits on the app's raised
 * surface; the overlay is a small inverse pill (dark on the light theme, light on the dark one) over the stage, whose
 * own colours could be anything. A frame's phases use the concept tints (input orange, script blue, rendering violet).
 */

export const STYLE = `
#styk-devtools, #styk-devtools-overlay { --dt-bg: var(--surface-raised, #1b1c23); --dt-fg: var(--text-1, #e8e9ee); --dt-dim: var(--text-3, #8b90a0);
  --dt-line: var(--line-2, #3a3f4f); --dt-faint: var(--line-1, #2a2e3a); --dt-sunken: var(--surface-sunken, rgba(0,0,0,.2)); --dt-hover: var(--surface-hover, rgba(127,127,127,.18));
  --dt-accent: var(--accent, #0d99ff); --dt-warn: var(--warning-text, #e0a400); --dt-bad: var(--danger-text, #ff5c5c); --dt-good: var(--success-text, #3fb950);
  --dt-late: var(--danger-dot, #e5484d); --dt-handlers: var(--tint-draw, #f5822a); --dt-script: var(--tint-select, #0d99ff); --dt-render: var(--tint-time, #7c5cff);
  --dt-mono: var(--font-mono, ui-monospace, monospace);
  font: 12px/1.4 var(--font-ui, system-ui, sans-serif); color: var(--dt-fg); }
#styk-devtools { position: fixed; z-index: 2147483000; right: 12px; bottom: 12px; width: min(760px, calc(100vw - 24px)); height: min(560px, calc(100vh - 24px));
  display: flex; flex-direction: column; background: var(--dt-bg); border: 1px solid var(--dt-line); border-radius: var(--radius-md, 8px);
  box-shadow: 0 12px 40px rgba(0,0,0,.35); resize: both; overflow: hidden; min-width: 320px; min-height: 200px; contain: layout paint style; }
#styk-devtools[hidden], #styk-devtools-overlay[hidden], #styk-devtools [hidden] { display: none; }
#styk-devtools.dt-docked { position: static; width: 100%; height: 100%; min-width: 0; min-height: 0; border: 0; border-radius: 0; box-shadow: none; resize: none; background: transparent; }
#styk-devtools.dt-docked header { cursor: default; }
#styk-devtools header { display: flex; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--dt-line); cursor: move; user-select: none; flex-wrap: wrap; }
#styk-devtools .dt-mark { font-weight: 700; font-size: 10px; letter-spacing: .06em; color: #111; background: var(--dt-warn); border-radius: 4px; padding: 1px 6px; margin-right: 4px; }
#styk-devtools header button { all: unset; cursor: pointer; padding: 3px 7px; border-radius: 5px; color: var(--dt-dim); }
#styk-devtools header button:focus-visible, #styk-devtools button.dt-button:focus-visible { outline: 2px solid var(--focus-ring, var(--dt-accent)); outline-offset: 1px; }
#styk-devtools header button[aria-selected="true"] { color: var(--dt-fg); background: var(--dt-hover); }
#styk-devtools header .dt-close { margin-left: auto; }
#styk-devtools .dt-body { flex: 1; overflow: auto; padding: 8px; }
#styk-devtools .dt-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
#styk-devtools button.dt-button { all: unset; cursor: pointer; padding: 2px 9px; border: 1px solid var(--dt-line); border-radius: 5px; white-space: nowrap; }
#styk-devtools button.dt-button:hover:not(:disabled) { border-color: var(--dt-accent); }
#styk-devtools button.dt-button:disabled { cursor: default; opacity: .45; }
#styk-devtools button.dt-button[data-recording="true"] { border-color: var(--dt-bad); color: var(--dt-bad); }
#styk-devtools button.dt-button[aria-pressed="true"] { background: var(--dt-hover); }
#styk-devtools input, #styk-devtools select { font: inherit; color: inherit; background: var(--dt-sunken); border: 1px solid var(--dt-line); border-radius: 4px; padding: 1px 4px; }
#styk-devtools table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
#styk-devtools th, #styk-devtools td { text-align: left; padding: 1px 6px; border-bottom: 1px solid var(--dt-faint); white-space: nowrap; }
#styk-devtools th { color: var(--dt-dim); font-weight: 500; }
#styk-devtools td.num, #styk-devtools th.num { text-align: right; }
#styk-devtools .dt-mono, #styk-devtools pre { font-family: var(--dt-mono); font-size: 11px; }
#styk-devtools pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
#styk-devtools .dt-dim { color: var(--dt-dim); }
#styk-devtools .dt-warn { color: var(--dt-warn); } #styk-devtools .dt-error { color: var(--dt-bad); }
#styk-devtools .dt-link { cursor: pointer; color: var(--dt-accent); }
#styk-devtools h4 { margin: 10px 0 4px; font-size: 12px; }
#styk-devtools .dt-section { margin-bottom: 12px; contain: layout paint; }
#styk-devtools .dt-section > h3 { display: flex; gap: 8px; align-items: baseline; margin: 0 0 4px; font-size: 12px; font-weight: 600; }
#styk-devtools .dt-section > h3 > span { font-weight: 400; color: var(--dt-dim); font-size: 11px; }
#styk-devtools .dt-status { color: var(--dt-dim); font-variant-numeric: tabular-nums; }
#styk-devtools canvas.dt-frames { width: 100%; height: 132px; display: block; border-radius: 4px; background: var(--dt-sunken); cursor: crosshair; touch-action: none; }
#styk-devtools canvas.dt-timeline { width: 100%; height: 150px; display: block; border: 1px solid var(--dt-line); border-radius: 4px; cursor: crosshair; }
#styk-devtools canvas.dt-spark { width: 100%; height: 22px; display: block; }
#styk-devtools .dt-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; color: var(--dt-dim); font-size: 11px; }
#styk-devtools .dt-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
#styk-devtools .dt-frame-detail { min-height: 2.8em; margin-top: 4px; font-family: var(--dt-mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
#styk-devtools .dt-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 6px; }
#styk-devtools .dt-tile { padding: 5px 8px; border: 1px solid var(--dt-faint); border-radius: 6px; min-width: 0; }
#styk-devtools .dt-tile-label { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#styk-devtools .dt-tile-row { display: flex; align-items: baseline; gap: 6px; }
#styk-devtools .dt-tile-value { font: 600 16px/1.3 var(--dt-mono); white-space: nowrap; }
#styk-devtools .dt-tile-sub { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
#styk-devtools .dt-grade { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
#styk-devtools .dt-grade[data-grade="good"] { color: var(--dt-good); } #styk-devtools .dt-grade[data-grade="fair"] { color: var(--dt-warn); }
#styk-devtools .dt-grade:is([data-grade="poor"], [data-grade="bad"]) { color: var(--dt-bad); }
#styk-devtools .dt-verdict { padding: 6px 8px; border: 1px solid var(--dt-line); border-radius: 6px; margin-bottom: 12px; }
#styk-devtools .dt-verdict .dt-grade { font-size: 13px; margin-right: 8px; }
#styk-devtools table.dt-ranked { table-layout: fixed; }
#styk-devtools table.dt-ranked .dt-col-num { width: 3.7em; }
#styk-devtools table.dt-ranked th, #styk-devtools table.dt-ranked td { padding: 1px 3px; }
#styk-devtools td.dt-name { position: relative; overflow: hidden; text-overflow: ellipsis; }
#styk-devtools td.dt-name > .dt-label { position: relative; }
#styk-devtools .dt-bar-fill { position: absolute; inset: 2px 0; border-radius: 2px; background: var(--dt-accent); opacity: .24; transform-origin: left; transform: scaleX(0); }
#styk-devtools .dt-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 2px 10px; }
#styk-devtools .dt-fact { display: flex; flex-direction: column; min-width: 0; padding: 1px 0; border-bottom: 1px solid var(--dt-faint); }
#styk-devtools .dt-fact > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#styk-devtools .dt-fact > .dt-dim { font-size: 11px; }
#styk-devtools .dt-fact-value { font-family: var(--dt-mono); font-variant-numeric: tabular-nums; }
#styk-devtools .dt-scroll { overflow-x: auto; }
#styk-devtools .dt-empty { padding: 2px 6px; }
#styk-devtools .dt-memory { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
#styk-devtools-overlay { position: fixed; z-index: 2147482999; pointer-events: none; --dt-bg: var(--surface-inverse, #0c0d12); --dt-fg: var(--text-inverse, #f2f3f7);
  --dt-dim: var(--text-inverse-2, rgba(255,255,255,.68)); --dt-line: var(--inverse-line, rgba(255,255,255,.16)); --dt-bad: var(--inverse-danger, #ff8a8a);
  --dt-good: var(--inverse-success, #6ee7b7); --dt-late: var(--inverse-danger, #ff8a8a); contain: strict; width: 236px; height: 112px; }
#styk-devtools-overlay canvas { display: block; width: 236px; height: 112px; }
`;

/** The custom properties a canvas reads, by the name the charts use. */
const COLOURS = {fg: '--dt-fg', dim: '--dt-dim', line: '--dt-line', faint: '--dt-faint', bg: '--dt-bg', sunken: '--dt-sunken', accent: '--dt-accent', good: '--dt-good',
  warn: '--dt-warn', bad: '--dt-bad', late: '--dt-late', handlers: '--dt-handlers', script: '--dt-script', render: '--dt-render', mono: '--dt-mono'};
const read = new WeakMap();

/**
 * The colours of `root` (the panel or the overlay) for a canvas, read once per theme: the app switches themes by its
 * root's `data-theme`, so a refresh reads no style unless that changed.
 */
export function palette(root) {
  const theme = document.documentElement.getAttribute('data-theme') ?? '';
  const known = read.get(root);
  if (known?.theme === theme) return known.colours;
  const style = getComputedStyle(root), colours = {};
  for (const [name, property] of Object.entries(COLOURS)) colours[name] = style.getPropertyValue(property).trim();
  read.set(root, {theme, colours});
  return colours;
}
