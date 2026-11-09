import {messageError} from '../localized-error.mjs';
import {localizedText, appendLocalized, localizedAttribute, localizedMarkup} from '../localization-bindings.mjs';
import {t as interfaceText} from '../localization.mjs';

/**
 * The dock host (docs/DOCKING.md): draws the workspace's arrangement
 * (dock-model.mjs) as the solver (dock-solve.mjs) fits it, and is the only
 * owner of which panel shows where.
 *
 * - The state loads from dock-store.mjs before the first commit. Each commit
 *   solves the arrangement for the `#app` box and applies it synchronously:
 *   `:root[data-tier|data-height|data-chrome]`, the band's folds, the stage's
 *   cell (the workspace grid has one named area, the stage, where the tool
 *   bar and the stage's own overlays keep their places), and every group as
 *   an island placed by its rectangle (absolutely, inside the workspace).
 *   Writes compare first, so a commit that changes nothing restyles nothing.
 * - Panel roots (`#properties-panel`, `#vfx-panel`, `#user-library`,
 *   `#builder-outliner`, `#animation-timeline`) are moved, never re-created,
 *   and only when their place changes, so scroll positions and focus
 *   survive. A group of the timeline alone is the timeline's own island.
 * - A collapsed group is a 40px strip of icons beside the stage, or its
 *   header above or below it; an icon or a tab opens the panel as a flyout
 *   beside it. Groups the window folds to the sheet open from the band's
 *   Properties button. Flyouts and the sheet close on Escape (captured, so
 *   the editor's Cancel does not also run), on a press outside, and when
 *   focus leaves them.
 * - Dividers and floats change the arrangement live once per frame through
 *   a transient override; the release stores it once. Fitting never writes.
 */
import {icon} from '../icons.mjs';
import {PANEL_CATALOG, createPanelRegistry} from './panel-registry.mjs';
import {createDockStore, desktopDockBackend, storageDockBackend} from './dock-store.mjs';
import {
  STAGE, activatePanel, closePanel, dockFloat, findPanel, findGroup, groupsOf, moveGroup, movePanel, panelsOf, placeFloat,
  reopenPanel, resizeChildren, setCollapsed, setTools, walk,
} from './dock-model.mjs';
import {
  applyPreset, defaultLayout, deleteLayout, exportLayout, focusActive, importLayout, isModified, normalizeMode, presetLayout,
  renameLayout, resetAll, resetWorkspace, saveLayout, setLayout, toggleFocus, updateLayout, MAX_SAVED_LAYOUTS,
} from './dock-workspaces.mjs';
import {HEADER, dividerChanges, dividerReset, solveDock} from './dock-solve.mjs';
import {SHELL_METRICS} from './layout-solver.mjs';
import {MENUBAR_FOLD, watchBand} from './topbar.mjs';
import {COLLECTIONS} from './dock-keyboard.mjs';
import {groupHeaderAt} from './dock-tabs.mjs';

const DEFAULT_ROOTS = Object.freeze({properties: '#properties-panel', vfx: '#vfx-panel', library: '#user-library',
  structure: '#builder-outliner', timeline: '#animation-timeline'});
const STEP = 12, BIG_STEP = 40;
/** Tall timeline stores this share of the window (the solver's 60% maximum). */
const TALL_TIMELINE = 0.6;
/** Two presses on a header within this time collapse or expand its group. */
const DOUBLE_PRESS_MS = 500;

const px = value => `${Math.round(value)}px`;

function browserStorage(win) {
  try { return win.localStorage ?? null; } catch { return null; }
}

/**
 * Loads the stored state, then lays the shell out. Resolves to the dock host
 * (see createDockHost), whose `workspace` is `window.styk.workspace`.
 */
export async function installShell({document: doc = globalThis.document, window: win = globalThis.window, desktop,
  legacy, platform, onError, onBeforeChange, timelineRows, ready = null, catalog = PANEL_CATALOG, touch = null} = {}) {
  const registry = createPanelRegistry({catalog});
  const backend = desktop?.getWorkspacePreferences && desktop?.setWorkspacePreferences
    ? desktopDockBackend(desktop) : storageDockBackend(browserStorage(win));
  const workspace = doc.querySelector('.workspace');
  const store = createDockStore({...backend, catalog: () => registry.constraints(), legacy, onError: error => {
    workspace?.dispatchEvent(new CustomEvent('styk-workspace-persistence-error', {detail: {message: error?.message || String(error)}}));
    onError?.(error);
  }});
  await store.load();
  return createDockHost({document: doc, window: win, registry, store, platform, onBeforeChange, timelineRows, ready, touch});
}

/**
 * SHELL_METRICS with the timeline painter's own heights ({ruler, pinnedRow,
 * row} in px) in place of the solver's, so a default height holds the rows
 * the painter really draws.
 */
export function paintedMetrics(timelineRows, metrics = SHELL_METRICS) {
  if (!timelineRows) return metrics;
  const {ruler, pinnedRow, row} = timelineRows;
  const height = Object.fromEntries(Object.entries(metrics.height).map(([tier, value]) =>
    [tier, {...value, timeline: {...value.timeline, ruler: ruler ?? value.timeline.ruler, row: row ?? value.timeline.row}}]));
  return {...metrics, height, timeline: {...metrics.timeline, pinnedRow: pinnedRow ?? metrics.timeline.pinnedRow}};
}

export function createDockHost({document: doc = globalThis.document, window: win = globalThis.window, registry, store,
  platform, onBeforeChange, timelineRows, ready = null, touch = null} = {}) {
  const metrics = paintedMetrics(timelineRows);
  const root = doc.documentElement;
  const app = doc.getElementById('app');
  const workspace = doc.querySelector('.workspace');
  const stage = workspace.querySelector('.shell-stage');
  const viewport = doc.getElementById('viewport');
  const band = doc.querySelector('.titlebar');
  const footer = doc.querySelector('.statusbar');
  const timeline = doc.getElementById('animation-timeline');
  const body = doc.getElementById('timeline');
  const sheetButton = doc.querySelector('.shell-sheet-button');
  const bodyButton = doc.querySelector('.shell-timeline-sheet');
  const expandButton = doc.getElementById('expand-timeline');
  const abort = new AbortController(), signal = abort.signal;
  const listeners = {solve: new Set()};
  workspace.dataset.dock = '';
  // Panel roots and tabs that are nowhere on screen (closed, folded and not open, another workspace's) wait here.
  let parking = workspace.querySelector(':scope > .shell-parking');
  if (!parking) {
    parking = doc.createElement('div');
    parking.className = 'shell-parking';
    parking.hidden = true;
    appendLocalized(workspace, parking);
  }
  const islands = new Map(), strips = new Map(), dividerEls = new Map();
  const tabElements = new Map([...doc.querySelectorAll('[role="tab"][data-panel]')].map(tab => [tab.dataset.panel, tab]));
  const written = new WeakMap();
  /** Writes a style property only when it changes. */
  const setStyle = (element, name, value) => {
    let map = written.get(element);
    if (!map) written.set(element, map = new Map());
    if (map.get(name) === value) return;
    map.set(name, value);
    if (value === null) element.style.removeProperty(name); else element.style.setProperty(name, value);
  };
  const setAttr = (element, name, value) => {
    if (value === null || value === false) { if (element.hasAttribute(name)) element.removeAttribute(name); return; }
    const text = value === true ? '' : String(value);
    if (element.getAttribute(name) !== text) element.setAttribute(name, text);
  };
  let solution = null, override = null, frame = 0, destroyed = false, origin = {x: 0, y: 0};
  let flyout = null;          // {group, panel, invoker}
  const sheet = {open: false, active: null, invoker: null, element: null};
  let bodyOpen = false, bodyInvoker = null;
  let railColumns = 1;
  let currentMode = normalizeMode(workspace.dataset.mode);
  const headerPress = {key: null, time: 0};

  const descriptor = id => registry.get(id);
  const title = id => (descriptor(id)?.titleKey ? interfaceText(descriptor(id).titleKey) : descriptor(id)?.title ?? id);
  const rootOf = id => registry.root(id) ?? doc.querySelector(DEFAULT_ROOTS[id] ?? `[data-panel="${id}"]`);
  const report = error => { globalThis.reportError?.(error); };
  const mode = () => normalizeMode(workspace.dataset.mode);
  const catalog = () => registry.constraints();
  const layoutNow = () => store.state.workspaces[mode()].layout;
  const fallback = () => defaultLayout(mode(), {catalog: catalog()});

  // ---------------------------------------------------------------------
  // Solving

  const touchState = () => (touch?.state?.active ? touch.state : null);

  function env() {
    const head = viewport && stage && !stage.hidden ? Math.round(viewport.getBoundingClientRect().top - stage.getBoundingClientRect().top) || undefined : undefined;
    const touching = touchState();
    if (touching) {
      const widths = bandWatch?.forWidth(0);
      const bandMin = widths?.minimal ? {...widths.minimal, minimal: widths.minimal} : 0;
      return {width: workspace.offsetWidth, height: workspace.offsetHeight, mode: mode(), platform, footer: 0,
        bandMin, metrics, measured: {band: 0, stageHead: head}, railColumns, touch: touching, panels: catalog()};
    }
    const chrome = band?.offsetHeight || undefined;
    const below = footer && !footer.hidden ? footer.offsetHeight : 0;
    return {width: app.clientWidth, height: app.clientHeight, mode: mode(), platform, footer: below,
      bandMin: bandWatch?.forWidth(app.clientWidth) ?? 0, metrics, measured: {band: chrome, stageHead: head}, railColumns, panels: catalog()};
  }

  /** Solves the workspace's arrangement (or a gesture's transient one) and applies it now. */
  function commit() {
    if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
    if (destroyed) return solution;
    try {
      const layout = override ? override(layoutNow()) : layoutNow();
      const focused = doc.activeElement;
      solution = solveDock(layout, env());
      solution.layout = layout;
      apply(solution, layout);
      keepFocus(focused);
      for (const listener of [...listeners.solve]) {
        try { listener(solution); } catch (error) { report(error); }
      }
    } catch (error) { report(error); }
    return solution;
  }
  function schedule() {
    if (!frame && !destroyed) frame = win.requestAnimationFrame(() => { frame = 0; commit(); });
  }

  /** Solves an arrangement without applying it (a drop preview). */
  const solveOnly = layout => solveDock(layout, env());

  /**
   * A commit that moves or hides the focused element must not drop focus to
   * the page: focus goes to the panel's tab, its strip icon, the band's
   * Properties button where it is in the sheet, else the stage.
   */
  function keepFocus(focused) {
    if (!focused || focused === doc.body || focused === doc.documentElement) return;
    const lost = !focused.isConnected || doc.activeElement === doc.body || !doc.activeElement || Boolean(focused.closest('[hidden], .shell-parking'));
    if (!lost) return;
    const id = focused.closest?.('[data-panel]')?.dataset.panel ?? focused.dataset?.stripFor ?? null;
    const usable = element => element?.isConnected && !element.closest('[hidden], .shell-parking') && element.getClientRects().length;
    let target = null;
    const where = id ? presentation(id) : null;
    if (where === 'docked' || where === 'float') target = [tabElements.get(id), ...(rootOf(id)?.querySelectorAll(COLLECTIONS) ?? [])].find(usable) ?? null;
    else if (where === 'strip') target = [...workspace.querySelectorAll(`.shell-strip-button[data-panel="${id}"], .shell-island [role="tab"][data-panel="${id}"]`)].find(usable) ?? null;
    else if (where === 'sheet') target = usable(sheetButton) ? sheetButton : null;
    (target ?? viewport)?.focus({preventScroll: true});
  }

  // ---------------------------------------------------------------------
  // Applying

  function apply(s, layout) {
    setAttr(root, 'data-tier', s.tier);
    setAttr(root, 'data-height', s.height);
    setAttr(root, 'data-chrome', s.chrome);
    applyBand(s);
    const leftGroups = s.groups.filter(group => group.side === 'left');
    setAttr(root, 'data-left', leftGroups.some(group => group.state === 'docked') ? 'docked' : leftGroups.length ? 'strip' : 'hidden');
    setAttr(workspace, 'data-rail', s.rail.side);
    setAttr(workspace, 'data-rail-orientation', s.rail.orientation === 'horizontal' ? 'horizontal' : null);
    const tools = workspace.querySelector('.shell-rail > .tool-dock');
    if (tools) setAttr(tools, 'aria-orientation', s.rail.orientation);
    const timelineShown = s.panels.timeline?.presentation !== 'hidden' && s.panels.timeline?.presentation !== 'unavailable';
    if (s.mode === 'rig') setAttr(workspace, 'data-builder-timeline', timelineShown ? 'visible' : 'hidden');
    else setAttr(workspace, 'data-builder-timeline', null);
    origin = {x: s.rects.workspace.x, y: touchState() ? 0 : s.rects.workspace.y};
    applyGrid(s);
    applyPanels(s, layout);
    applyDividers(s);
    applyControls(s);
    applyVisibility(s);
  }

  function applyBand(s) {
    if (!band) return;
    const steps = (s.touch ? [MENUBAR_FOLD, ...s.band] : s.tier === 'minimal' ? [MENUBAR_FOLD, ...s.band] : s.band).join(' ');
    if ((band.getAttribute('data-band') ?? '') === steps) return;
    if (steps) band.setAttribute('data-band', steps); else band.removeAttribute('data-band');
  }

  /** The workspace grid: one named area, the stage's rectangle, so what sits on the stage keeps its CSS. */
  function applyGrid(s) {
    const x = Math.round(s.stage.x - origin.x), y = Math.round(s.stage.y - origin.y);
    setStyle(workspace, '--shell-columns', `${px(x)} ${px(s.stage.width)} minmax(0, 1fr)`);
    setStyle(workspace, '--shell-rows', `${px(y)} ${px(s.stage.height)} minmax(0, 1fr)`);
    setStyle(workspace, '--shell-areas', '". . ." ". stage ." ". . ."');
    setStyle(workspace, '--shell-gap', '0px');
    setStyle(workspace, '--shell-row-gap', '0px');
    for (const name of ['--shell-pad-start', '--shell-pad-end', '--shell-pad-top']) setStyle(workspace, name, '0px');
    // The touch stylesheet keeps the bottom padding for the safe area; the grid's last track takes it.
    setStyle(workspace, '--shell-pad-bottom', '0px');
    setStyle(workspace, '--shell-rail', px(s.rail.width));
    setStyle(workspace, '--shell-rail-top', px(s.rail.rect.y - s.stage.y));
    setStyle(workspace, '--shell-gutter-x', px(s.gaps.x));
    setStyle(workspace, '--shell-gutter-y', px(s.gaps.y));
  }

  const place = (element, rect) => {
    setStyle(element, 'position', 'absolute');
    setStyle(element, 'left', px(rect.x - origin.x));
    setStyle(element, 'top', px(rect.y - origin.y));
    setStyle(element, 'width', px(rect.width));
    setStyle(element, 'height', px(rect.height));
  };

  function makeIsland(key) {
    const island = doc.createElement('section');
    island.className = 'ui-island shell-island';
    island.dataset.island = key;
    const tabs = doc.createElement('div');
    tabs.className = 'ui-tabs shell-tabs';
    tabs.dataset.ui = '';
    tabs.setAttribute('role', 'tablist');
    appendLocalized(island, tabs);
    return island;
  }

  function islandFor(id) {
    let island = islands.get(id);
    if (!island) {
      island = makeIsland(id);
      island.dataset.group = id;
      islands.set(id, island);
    }
    return island;
  }

  function tabOf(id) {
    let tab = tabElements.get(id);
    if (!tab) {
      tab = doc.createElement('button');
      tab.type = 'button';
      tab.className = 'ui-tab';
      tab.id = `${id}-tab`;
      tab.setAttribute('role', 'tab');
      tab.dataset.panel = id;
      if (descriptor(id)?.titleKey) localizedText(tab, descriptor(id).titleKey); else tab.textContent = title(id);
      tabElements.set(id, tab);
    }
    localizedAttribute(tab, 'title', 'dockHost.dragToMovePanelRightClickForLayout', {});
    const target = rootOf(id);
    if (target?.id) tab.setAttribute('aria-controls', target.id);
    return tab;
  }

  /** Puts `nodes` into `parent` in order from `start`, moving only what is out of place. */
  function order(parent, nodes, start = 0) {
    nodes.forEach((node, index) => {
      const at = parent.children[start + index] ?? null;
      if (at !== node) parent.insertBefore(node, at);
    });
  }

  /** Fills an island: its tabs in order, the active one selected, then the panel roots (`roots` false: tabs only). */
  function fill(island, ids, active, {roots = true} = {}) {
    const tablist = island.querySelector(':scope > .shell-tabs');
    const tabs = ids.map(tabOf);
    order(tablist, tabs);
    for (const tab of [...tablist.children]) if (!tabs.includes(tab)) parking.append(tab);
    tablist.hidden = !ids.length;
    tablist.setAttribute('aria-label', ids.map(title).join(', '));
    island.setAttribute('aria-label', ids.map(title).join(', '));
    for (const id of ids) {
      const tab = tabOf(id), selected = id === active;
      tab.hidden = false;
      setAttr(tab, 'aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (roots) order(island, ids.map(rootOf).filter(Boolean), 1);
    island.dataset.panels = ids.join(' ');
  }

  function stripFor(id) {
    let strip = strips.get(id);
    if (!strip) {
      strip = doc.createElement('div');
      strip.className = 'ui-strip shell-strip';
      strip.dataset.ui = '';
      strip.dataset.group = id;
      strip.setAttribute('role', 'toolbar');
      strip.setAttribute('aria-orientation', 'vertical');
      strips.set(id, strip);
    }
    return strip;
  }

  // A folded panel's own one-click actions ([data-strip-action="order"] in its root) stay one click away as
  // strip buttons under its icon. Each one clicks its source and mirrors its name, glyph and state.
  const stripMirrors = new Map();
  const MIRRORED = ['aria-pressed', 'aria-expanded', 'aria-controls', 'disabled'];
  function stripActions(id) {
    const sources = [...(rootOf(id)?.querySelectorAll('[data-strip-action]') ?? [])]
      .sort((a, b) => Number(a.dataset.stripAction) - Number(b.dataset.stripAction));
    return sources.map(source => {
      let mirror = stripMirrors.get(source);
      if (!mirror) {
        mirror = doc.createElement('button');
        mirror.type = 'button';
        mirror.className = 'ui-icon-button shell-strip-action';
        mirror.dataset.stripFor = id;
        mirror.addEventListener('click', () => source.click(), {signal});
        const copy = () => {
          const name = source.getAttribute('aria-label') || source.textContent.trim();
          mirror.setAttribute('aria-label', name);
          mirror.dataset.tooltip = name;
          for (const attribute of MIRRORED) {
            if (source.hasAttribute(attribute)) mirror.setAttribute(attribute, source.getAttribute(attribute));
            else mirror.removeAttribute(attribute);
          }
          const glyph = source.querySelector('svg')?.outerHTML ?? '';
          if (mirror.innerHTML !== glyph) localizedMarkup(mirror, glyph);
        };
        copy();
        const watch = new win.MutationObserver(copy);
        watch.observe(source, {attributes: true, attributeFilter: [...MIRRORED, 'aria-label'], childList: true});
        signal.addEventListener('abort', () => watch.disconnect(), {once: true});
        stripMirrors.set(source, mirror);
      }
      return mirror;
    });
  }

  function syncStrip(strip, ids, group) {
    const buttons = ids.flatMap(id => {
      let button = strip.querySelector(`:scope > [data-panel="${id}"]`);
      if (!button) {
        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'ui-icon-button shell-strip-button';
        button.dataset.panel = id;
        button.setAttribute('aria-haspopup', 'dialog');
        localizedMarkup(button, icon(descriptor(id)?.icon ?? 'panel-right'));
      }
      if (descriptor(id)?.titleKey) localizedAttribute(button, 'aria-label', descriptor(id).titleKey); else button.setAttribute('aria-label', title(id));
      button.dataset.tip = title(id);
      button.dataset.group = group;
      return [button, ...stripActions(id)];
    });
    order(strip, buttons);
    for (const button of [...strip.children]) if (!buttons.includes(button)) button.remove();
  }

  function sheetIsland() {
    if (!sheet.element) {
      const element = makeIsland('right-sheet');
      element.classList.add('ui-sheet', 'shell-sheet');
      element.setAttribute('popover', 'manual');
      element.setAttribute('role', 'dialog');
      localizedAttribute(element, 'aria-label', 'dockHost.inspector', {});
      element.id = 'right-sheet';
      element.dataset.side = 'right';
      appendLocalized(workspace, element);
      element.addEventListener('focusout', event => {
        if (sheet.open && leaves(event, [element, sheet.invoker])) closeSheet({restoreFocus: false});
      }, {signal});
      sheet.element = element;
    }
    return sheet.element;
  }

  let flyoutElement = null;
  function flyoutIsland() {
    if (!flyoutElement) {
      flyoutElement = makeIsland('flyout');
      flyoutElement.classList.add('ui-sheet', 'shell-sheet', 'shell-flyout');
      flyoutElement.setAttribute('popover', 'manual');
      flyoutElement.setAttribute('role', 'dialog');
      appendLocalized(workspace, flyoutElement);
      flyoutElement.addEventListener('focusout', event => {
        if (flyout && leaves(event, [flyoutElement, flyout.invoker])) closeFlyout({restoreFocus: false});
      }, {signal});
    }
    return flyoutElement;
  }

  /** Where every panel root and island goes for a solution; moves only what changed. */
  function applyPanels(s, layout) {
    const live = new Set();
    const parked = new Set(registry.list().map(item => item.id));
    const show = element => { if (element.hidden) element.hidden = false; };
    // Docked and folded groups.
    for (const group of s.groups) {
      const timelineAlone = group.timeline;
      if (timelineAlone && group.state !== 'strip') {
        // The timeline's own island: docked, or its header with the body as a sheet.
        if (timeline.parentElement !== workspace) workspace.insertBefore(timeline, parking);
        show(timeline);
        setAttr(timeline, 'data-group', group.id);
        setAttr(timeline, 'data-state', group.state === 'header' ? 'strip' : 'docked');
        timeline.classList.add('shell-placed');
        place(timeline, group.rect);
        parked.delete('timeline');
        continue;
      }
      if (group.state === 'strip') {
        const strip = stripFor(group.id);
        live.add(strip);
        if (strip.parentElement !== workspace) workspace.insertBefore(strip, parking);
        localizedAttribute(strip, 'aria-label', 'dockHost.folded', {value: group.tabs.map(title).join(', ')});
        setAttr(strip, 'data-side', group.side);
        syncStrip(strip, group.tabs, group.id);
        place(strip, group.rect);
        continue;
      }
      const island = islandFor(group.id);
      live.add(island);
      if (island.parentElement !== workspace) workspace.insertBefore(island, parking);
      setAttr(island, 'data-state', group.state);
      setAttr(island, 'data-side', group.side);
      setAttr(island, 'data-floating', null);
      setAttr(island, 'role', 'region');
      island.hidden = false;
      const docked = group.state === 'docked';
      fill(island, group.tabs, group.active, {roots: docked});
      if (docked) for (const id of group.tabs) { parked.delete(id); prepare(id, island); }
      place(island, group.rect);
    }
    // Floats.
    for (const float of s.floats) {
      const island = islandFor(float.group);
      live.add(island);
      if (island.parentElement !== workspace) workspace.insertBefore(island, parking);
      setAttr(island, 'data-state', float.collapsed ? 'header' : 'docked');
      setAttr(island, 'data-floating', float.id);
      setAttr(island, 'role', 'dialog');
      island.hidden = false;
      fill(island, float.tabs, float.active, {roots: !float.collapsed});
      if (!float.collapsed) for (const id of float.tabs) { parked.delete(id); prepare(id, island); }
      let grip = island.querySelector(':scope > .shell-float-grip');
      if (!grip) {
        grip = doc.createElement('span');
        grip.className = 'shell-float-grip';
        grip.setAttribute('aria-hidden', 'true');
        appendLocalized(island, grip);
      } else if (island.lastElementChild !== grip) island.append(grip);
      grip.hidden = float.collapsed;
      place(island, float.rect);
    }
    // The open flyout keeps its panel; a flyout whose group is no longer folded closes.
    if (flyout) {
      const group = s.groups.find(item => item.id === flyout.group && item.state !== 'docked');
      if (!group || !group.tabs.includes(flyout.panel)) closeFlyout({restoreFocus: false, recommit: false});
    }
    if (flyout) {
      const group = s.groups.find(item => item.id === flyout.group);
      const element = flyoutIsland();
      fill(element, group.tabs, flyout.panel, {roots: true});
      for (const id of group.tabs) { parked.delete(id); prepare(id, element); }
      element.dataset.group = group.id;
      element.dataset.side = group.side;
      placeFlyout(group);
    }
    // The sheet: every panel the window folded there.
    const sheetIds = s.sheet;
    if (!sheetIds.includes(sheet.active)) sheet.active = sheetIds[0] ?? null;
    if (sheet.open && !sheet.active) closeSheet({restoreFocus: false, recommit: false});
    if (sheetIds.length || sheet.element) {
      const element = sheetIsland();
      fill(element, sheetIds, sheet.active, {roots: true});
      for (const id of sheetIds) { parked.delete(id); prepare(id, element); }
      if (sheet.open) placeSheet();
    }
    // Everything else waits in the parking.
    for (const id of parked) {
      const panel = rootOf(id);
      if (panel && panel.parentElement !== parking) parking.append(panel);
      const tab = tabElements.get(id);
      const inUse = tab && s.groups.some(group => group.tabs.includes(id) && group.state === 'header') || s.floats.some(float => float.tabs.includes(id));
      if (tab && !inUse && tab.parentElement !== parking && !tab.closest('.shell-flyout, .shell-sheet')) parking.append(tab);
      if (id === 'timeline') {
        timeline.classList.remove('shell-placed');
        setAttr(timeline, 'data-state', 'hidden');
      }
    }
    arrangeDom(s, layout);
    for (const [id, island] of islands) if (!live.has(island) && island.parentElement !== parking) { island.hidden = true; parking.append(island); if (!findGroup(layout, id)) islands.delete(id); }
    for (const [id, strip] of strips) if (!live.has(strip)) { strip.remove(); if (!findGroup(layout, id)) strips.delete(id); }
    applyBody(s);
  }

  /**
   * Keeps the islands in reading order in the DOM (the order of Tab), around
   * the stage, which never moves: only an element out of order is moved.
   */
  function arrangeDom(s, layout) {
    const before = [], after = [];
    let seen = false;
    walk(layout.root, node => {
      if (node.type === STAGE) { seen = true; return; }
      if (node.type !== 'group') return;
      const group = s.groups.find(item => item.id === node.id);
      if (!group) return;
      const element = group.timeline && group.state !== 'strip' ? timeline : group.state === 'strip' ? strips.get(group.id) : islands.get(group.id);
      if (element?.parentElement === workspace) (seen ? after : before).push(element);
    });
    for (const float of s.floats) { const element = islands.get(float.group); if (element) after.push(element); }
    const FOLLOWING = 4;
    let anchor = stage;
    for (const element of before.reverse()) {
      if (!(element.compareDocumentPosition(anchor) & FOLLOWING)) workspace.insertBefore(element, anchor);
      anchor = element;
    }
    anchor = stage;
    for (const element of after) {
      if (!(anchor.compareDocumentPosition(element) & FOLLOWING)) anchor.after(element);
      anchor = element;
    }
  }

  /** A panel root that moves into an island: the timeline loses its own island look there. */
  function prepare(id, island) {
    if (id !== 'timeline') return;
    timeline.classList.remove('shell-placed');
    setAttr(timeline, 'data-state', 'docked');
    setAttr(timeline, 'data-group', island.dataset.group ?? null);
    for (const name of ['position', 'left', 'top', 'width', 'height']) setStyle(timeline, name, null);
  }

  function applyBody(s) {
    const group = s.groups.find(item => item.timeline && item.state === 'header');
    const folded = Boolean(group);
    if (!folded && bodyOpen) closeBody({restoreFocus: false, recommit: false});
    if (folded && !body.hasAttribute('popover')) body.setAttribute('popover', 'manual');
    if (!folded && body.hasAttribute('popover')) body.removeAttribute('popover');
    if (bodyButton) {
      if (bodyButton.hidden !== !folded) bodyButton.hidden = !folded;
      bodyButton.setAttribute('aria-expanded', String(bodyOpen));
    }
    if (bodyOpen) placeBody();
  }

  function applyControls(s) {
    if (sheetButton) {
      const none = !s.sheet.length;
      if (sheetButton.hidden !== none) sheetButton.hidden = none;
      sheetButton.setAttribute('aria-expanded', String(sheet.open));
      if (sheet.element) sheetButton.setAttribute('aria-controls', sheet.element.id);
    }
    if (expandButton) {
      const tall = isTall();
      expandButton.setAttribute('aria-pressed', String(tall));
      localizedAttribute(expandButton, 'aria-label', tall ? 'dockHost.restoreTimelineHeight' : 'dockHost.expandTimeline', {});
    }
    for (const strip of strips.values()) {
      for (const button of strip.children) {
        if (!button.dataset.panel) continue;
        const open = flyout?.panel === button.dataset.panel;
        setAttr(button, 'aria-expanded', String(open));
        setAttr(button, 'aria-pressed', String(open));
      }
    }
  }

  function applyVisibility(s) {
    const open = [];
    if (sheet.open && sheet.active) open.push(sheet.active);
    if (flyout) open.push(flyout.panel);
    if (bodyOpen) open.push('timeline');
    registry.applySolution(s, {open});
    for (const item of registry.list()) {
      const {id} = item;
      if (id === 'timeline') continue;
      const panel = rootOf(id);
      if (!panel) continue;
      const visible = registry.isVisible(id);
      if (panel.hidden === visible) panel.hidden = !visible;
    }
  }

  // ---------------------------------------------------------------------
  // Dividers

  function applyDividers(s) {
    const live = new Set();
    for (const divider of s.dividers) {
      live.add(divider.key);
      let el = dividerEls.get(divider.key);
      if (!el) {
        el = makeDivider(divider.key);
        dividerEls.set(divider.key, el);
        workspace.insertBefore(el, parking);
      }
      el.hidden = false;
      el.dataset.axis = divider.axis;
      setAttr(el, 'aria-orientation', divider.axis === 'row' ? 'vertical' : 'horizontal');
      setAttr(el, 'aria-valuemin', String(divider.min));
      setAttr(el, 'aria-valuemax', String(divider.max));
      setAttr(el, 'aria-valuenow', String(divider.now));
      localizedAttribute(el, 'aria-valuetext', 'dockHost.sizePixels', {count: divider.now});
      const names = divider.tabs.map(id => (descriptor(id)?.titleKey ? {messageKey: descriptor(id).titleKey} : title(id)));
      localizedAttribute(el, 'aria-label', 'dockHost.resizePanels', {panels: {format: 'list', value: names.length ? names : [{messageKey: 'dockHost.stage'}]}});
      place(el, divider.rect);
    }
    for (const [key, el] of dividerEls) if (!live.has(key)) { if (dragging?.key === key) continue; el.remove(); dividerEls.delete(key); }
  }

  let dragging = null;
  const dividerOf = key => solution?.dividers.find(item => item.key === key) ?? null;
  function makeDivider(key) {
    const el = doc.createElement('div');
    el.className = 'ui-splitter shell-splitter';
    el.dataset.splitter = key;
    el.dataset.ui = '';
    el.tabIndex = 0;
    el.setAttribute('role', 'separator');
    const coordinate = (event, axis) => (axis === 'row' ? event.clientX : event.clientY);
    const finish = cancel => {
      if (!dragging || dragging.key !== key) return;
      const {pointerId, divider, value} = dragging;
      dragging = null;
      delete el.dataset.dragging;
      override = null;
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
      if (!cancel && value !== undefined) edit(layout => resizeChildren(layout, divider.path, dividerChanges(divider, value)));
      else commit();
    };
    el.addEventListener('pointerdown', event => {
      const divider = dividerOf(key);
      if (event.button !== 0 || dragging || !divider) return;
      event.preventDefault();
      el.focus({preventScroll: true});
      onBeforeChange?.();
      dragging = {key, pointerId: event.pointerId, origin: coordinate(event, divider.axis), divider};
      el.setPointerCapture(event.pointerId);
      el.dataset.dragging = 'true';
    }, {signal});
    el.addEventListener('pointermove', event => {
      if (dragging?.key !== key || dragging.pointerId !== event.pointerId) return;
      event.preventDefault();
      const {divider} = dragging;
      const delta = coordinate(event, divider.axis) - dragging.origin;
      dragging.value = divider.now + (divider.control === 'a' ? delta : -delta);
      const changes = dividerChanges(divider, dragging.value);
      override = layout => resizeChildren(layout, divider.path, changes);
      schedule();
    }, {signal});
    el.addEventListener('pointerup', event => { if (dragging?.pointerId === event.pointerId) finish(false); }, {signal});
    el.addEventListener('pointercancel', () => finish(true), {signal});
    el.addEventListener('lostpointercapture', () => finish(true), {signal});
    el.addEventListener('dblclick', event => {
      event.preventDefault();
      const divider = dividerOf(key);
      if (divider) edit(layout => resizeChildren(layout, divider.path, dividerReset(divider)));
    }, {signal});
    el.addEventListener('keydown', event => {
      if (event.key === 'Escape' && dragging?.key === key) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      const divider = dividerOf(key);
      if (!divider) return;
      const forward = divider.control === 'a' ? 1 : -1;
      const grow = divider.axis === 'row' ? {ArrowRight: forward, ArrowLeft: -forward} : {ArrowDown: forward, ArrowUp: -forward};
      if (event.key === 'Home' || event.key === 'Enter') edit(layout => resizeChildren(layout, divider.path, dividerReset(divider)));
      else if (grow[event.key] || event.key === 'End') {
        const value = event.key === 'End' ? divider.max : divider.now + grow[event.key] * (event.shiftKey ? BIG_STEP : STEP);
        edit(layout => resizeChildren(layout, divider.path, dividerChanges(divider, value)));
      } else return;
      event.preventDefault();
      event.stopPropagation();
    }, {signal});
    return el;
  }

  // ---------------------------------------------------------------------
  // Flyouts, the sheet and the timeline body

  function placeFlyout(group) {
    const element = flyoutElement;
    if (!element) return;
    const area = workspace.getBoundingClientRect();
    const box = {x: group.rect.x - origin.x + area.left, y: group.rect.y - origin.y + area.top, w: group.rect.width, h: group.rect.height};
    const preferred = Math.max(256, ...group.tabs.map(id => (id === 'timeline' ? 480 : descriptor(id)?.pref ?? 320)));
    const room = {left: box.x - area.left - 8, right: area.right - (box.x + box.w) - 8};
    let left, top, width, height;
    if (group.state === 'strip') {
      width = Math.min(preferred, Math.max(room.left, room.right));
      left = group.side === 'right' || room.right < width ? box.x - 8 - width : box.x + box.w + 8;
      top = box.y;
      height = box.h;
    } else {
      width = Math.max(320, box.w);
      left = Math.min(box.x, area.right - width - 8);
      height = Math.min(group.tabs.includes('timeline') ? 360 : 480, Math.max(160, (group.side === 'top' ? area.bottom - box.y - box.h : box.y - area.top) - 16));
      top = group.side === 'top' ? box.y + box.h + 8 : box.y - 8 - height;
    }
    // Inline: the sheet component's own inset (the window's right edge) would beat the layout layer's.
    setStyle(element, 'inset', 'auto');
    setStyle(element, 'top', px(Math.max(area.top, top)));
    setStyle(element, 'left', px(Math.max(area.left + 4, left)));
    setStyle(element, 'inline-size', px(width));
    setStyle(element, 'block-size', px(Math.max(120, height)));
    setStyle(element, 'max-block-size', px(Math.max(120, height)));
  }

  function openFlyout(groupId, panel, {invoker = doc.activeElement, focus = true} = {}) {
    onBeforeChange?.();
    closeSheet({restoreFocus: false, recommit: false});
    flyout = {group: groupId, panel, invoker: invoker instanceof win.HTMLElement ? invoker : null};
    const element = flyoutIsland();
    commit();
    if (!element.matches(':popover-open')) {
      try { element.showPopover(); } catch (error) { report(error); }
    }
    const group = solution.groups.find(item => item.id === groupId);
    if (group) placeFlyout(group);
    if (focus) focusPanel(panel);
  }

  function closeFlyout({restoreFocus = true, recommit = true} = {}) {
    if (!flyout) return;
    const element = flyoutElement;
    const hadFocus = element?.contains(doc.activeElement);
    const {invoker} = flyout;
    flyout = null;
    if (element?.matches(':popover-open')) {
      try { element.hidePopover(); } catch (error) { report(error); }
    }
    if (recommit) commit();
    if (restoreFocus && hadFocus && invoker?.isConnected) invoker.focus({preventScroll: true});
  }

  function placeSheet() {
    const element = sheet.element;
    if (!element) return;
    if (touchState()) {
      for (const name of ['--sheet-top', '--sheet-start', 'max-block-size', 'block-size']) element.style.removeProperty(name);
      return;
    }
    const area = workspace.getBoundingClientRect();
    const floor = Math.min(area.bottom - 8, stage.getBoundingClientRect().bottom);
    element.style.setProperty('--sheet-top', px(area.top));
    element.style.setProperty('max-block-size', px(Math.max(120, floor - area.top)));
  }

  function openSheet(id, {invoker = doc.activeElement, focus = true} = {}) {
    onBeforeChange?.();
    closeFlyout({restoreFocus: false, recommit: false});
    if (!sheet.open) sheet.invoker = invoker instanceof win.HTMLElement ? invoker : null;
    sheet.active = id ?? sheet.active ?? solution?.sheet[0] ?? null;
    sheet.open = true;
    const element = sheetIsland();
    commit();
    if (!element.matches(':popover-open')) {
      try { element.showPopover(); } catch (error) { report(error); }
    }
    placeSheet();
    if (focus && sheet.active) focusPanel(sheet.active);
  }

  function closeSheet({restoreFocus = true, recommit = true} = {}) {
    if (!sheet.open) return;
    const element = sheet.element;
    const hadFocus = element?.contains(doc.activeElement);
    sheet.open = false;
    if (element?.matches(':popover-open')) {
      try { element.hidePopover(); } catch (error) { report(error); }
    }
    if (recommit) commit();
    if (restoreFocus && hadFocus && sheet.invoker?.isConnected) sheet.invoker.focus({preventScroll: true});
    sheet.invoker = null;
  }

  function placeBody() {
    const rect = timeline.getBoundingClientRect(), area = workspace.getBoundingClientRect();
    const above = rect.top - area.top > area.bottom - rect.bottom;
    const room = Math.max(120, (above ? rect.top - area.top : area.bottom - rect.bottom) - 12);
    body.style.setProperty('--sheet-bottom', px(above ? win.innerHeight - rect.top + 6 : Math.max(8, win.innerHeight - rect.bottom - 6 - Math.min(room, 360))));
    body.style.setProperty('--sheet-block', px(Math.min(room, 360)));
  }

  function openBody({invoker = doc.activeElement, focus = true} = {}) {
    if (!solution?.groups.some(group => group.timeline && group.state === 'header')) return false;
    onBeforeChange?.();
    bodyOpen = true;
    bodyInvoker = invoker instanceof win.HTMLElement ? invoker : null;
    if (!body.hasAttribute('popover')) body.setAttribute('popover', 'manual');
    placeBody();
    if (!body.matches(':popover-open')) {
      try { body.showPopover(); } catch (error) { report(error); }
    }
    commit();
    if (focus) focusPanel('timeline');
    return true;
  }

  function closeBody({restoreFocus = true, recommit = true} = {}) {
    if (!bodyOpen) return;
    const hadFocus = body.contains(doc.activeElement);
    bodyOpen = false;
    if (body.matches?.(':popover-open')) {
      try { body.hidePopover(); } catch (error) { report(error); }
    }
    if (recommit) commit();
    if (restoreFocus && hadFocus && bodyInvoker?.isConnected) bodyInvoker.focus({preventScroll: true});
    bodyInvoker = null;
  }

  /** A press or key inside another overlay (a menu, a picker, a dialog) leaves the shell's sheets alone. */
  const insideOverlay = target => Boolean(target?.closest?.('dialog[open], #menu, [popover]:popover-open:not(.shell-sheet, .shell-timeline-body)'));
  const leaves = (event, keep) => {
    const next = event.relatedTarget;
    return next instanceof win.Element && !keep.some(element => element?.contains?.(next)) && !insideOverlay(next);
  };
  doc.addEventListener('pointerdown', event => {
    const target = event.target;
    if (sheet.open && !sheet.element?.contains(target) && !target.closest?.('.shell-sheet-button') && !insideOverlay(target)) closeSheet({restoreFocus: false});
    if (flyout && !flyoutElement?.contains(target) && !target.closest?.(`.shell-strip-button, [data-group="${flyout.group}"] [role="tab"]`) && !insideOverlay(target)) closeFlyout({restoreFocus: false});
    if (bodyOpen && !body.contains(target) && !target.closest?.('.shell-timeline-sheet') && !insideOverlay(target)) closeBody({restoreFocus: false});
  }, {capture: true, signal});
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || insideOverlay(event.target)) return;
    if (sheet.open && (sheet.element?.contains(event.target) || event.target === sheet.invoker)) { event.preventDefault(); closeSheet(); return; }
    if (flyout && (flyoutElement?.contains(event.target) || event.target === flyout.invoker)) { event.preventDefault(); closeFlyout(); return; }
    if (bodyOpen && (timeline.contains(event.target) || event.target === bodyInvoker)) { event.preventDefault(); closeBody(); }
  }, {capture: true, signal});
  body.addEventListener('focusout', event => {
    if (bodyOpen && leaves(event, [timeline, bodyInvoker])) closeBody({restoreFocus: false});
  }, {signal});

  // ---------------------------------------------------------------------
  // Tabs, strips, headers and floats

  workspace.addEventListener('click', event => {
    const tab = event.target.closest?.('.shell-island [role="tab"][data-panel]');
    if (tab) {
      const id = tab.dataset.panel;
      const island = tab.closest('.shell-island');
      if (island?.classList.contains('shell-sheet')) {
        if (island === sheet.element) { sheet.active = id; commit(); }
        else if (flyout) { flyout.panel = id; commit(); }
        return;
      }
      if (island?.dataset.state === 'header') {
        if (flyout?.panel === id) closeFlyout(); else openFlyout(island.dataset.group, id, {invoker: tab});
        return;
      }
      showPanel(id, {focus: false});
      return;
    }
    const strip = event.target.closest?.('.shell-strip-button[data-panel]');
    if (strip) {
      if (flyout?.panel === strip.dataset.panel) closeFlyout();
      else openFlyout(strip.dataset.group, strip.dataset.panel, {invoker: strip});
    }
  }, {signal});
  doc.addEventListener('keydown', event => {
    const tab = event.target.closest?.('.shell-tabs [role="tab"]');
    if (!tab || !workspace.contains(tab) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll(':scope > [role="tab"]:not([hidden])')];
    const index = tabs.indexOf(tab);
    const rtl = win.getComputedStyle(tab).direction === 'rtl';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + ((event.key === 'ArrowRight') !== rtl ? 1 : tabs.length - 1)) % tabs.length;
    event.preventDefault();
    event.stopPropagation();
    tabs[next].click();
    tabs[next].focus();
  }, {signal});
  // Double-press on a group's header (outside its tabs) collapses or expands it; on a float's, docks it back.
  workspace.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const groupId = groupHeaderAt(event)?.group;
    if (!groupId) return;
    const now = event.timeStamp;
    if (headerPress.key === groupId && now - headerPress.time < DOUBLE_PRESS_MS) {
      headerPress.key = null;
      const float = solution?.floats.find(item => item.group === groupId);
      if (float) workspaceApi.dockFloat(float.id);
      else workspaceApi.collapse(groupId);
      return;
    }
    headerPress.key = groupId;
    headerPress.time = now;
  }, {signal});
  expandButton?.addEventListener('click', () => toggleTall(), {signal});

  // ---------------------------------------------------------------------
  // Editing the arrangement

  /** Replaces the workspace's arrangement with `change(layout)` and commits. */
  function edit(change, {m = mode()} = {}) {
    let changed = false;
    store.update(state => {
      const current = state.workspaces[m].layout;
      const next = change(current);
      if (!next || next === current) return state;
      changed = true;
      return setLayout(state, m, next);
    });
    commit();
    return changed;
  }
  const options = () => ({mode: mode(), catalog: catalog(), fallback: fallback()});
  const presentation = id => solution?.panels[id]?.presentation ?? 'unavailable';

  /** Shows a panel: activates its tab, opens its flyout, the sheet or the timeline's body, or reopens it; `focus` moves focus to it. */
  function showPanel(id, {focus = true, invoker} = {}) {
    if (!registry.has(id) || presentation(id) === 'unavailable') return false;
    onBeforeChange?.();
    const current = presentation(id);
    if (current === 'hidden') {
      edit(layout => reopenPanel(layout, id, options()));
      return showPanel(id, {focus, invoker});
    }
    if (current === 'sheet') { openSheet(id, {invoker, focus}); return true; }
    if (current === 'strip') {
      const group = solution.groups.find(item => item.tabs.includes(id));
      if (group?.timeline && group.state === 'header') { openBody({invoker, focus}); return true; }
      const float = solution.floats.find(item => item.tabs.includes(id));
      if (float) { edit(layout => setCollapsed(activatePanel(layout, id), float.group, false)); if (focus) focusPanel(id); return true; }
      if (group) { openFlyout(group.id, id, {invoker, focus}); return true; }
    }
    if (current === 'float') {
      const float = solution.floats.find(item => item.tabs.includes(id));
      edit(layout => (float?.collapsed ? setCollapsed(activatePanel(layout, id), float.group, false) : activatePanel(layout, id)));
    } else edit(layout => activatePanel(layout, id));
    if (focus) focusPanel(id);
    return true;
  }

  /** Focuses a panel: its tab, else its main collection, else its first control. */
  function focusPanel(id) {
    const tab = tabElements.get(id);
    const usable = element => element?.isConnected && element.getClientRects().length && !element.closest('[hidden], .shell-parking') && !element.disabled && element.tabIndex >= 0;
    if (id !== 'timeline' && usable(tab)) { tab.focus({preventScroll: true}); return; }
    const panel = rootOf(id);
    const target = [...(panel?.querySelectorAll(COLLECTIONS) ?? [])].find(usable)
      ?? [...(panel?.querySelectorAll('[tabindex="0"], button, input, select, textarea') ?? [])].find(usable);
    target?.focus({preventScroll: true});
  }

  const focusedIn = id => {
    const active = doc.activeElement;
    if (!active || active === doc.body) return false;
    return Boolean(rootOf(id)?.contains(active) || tabElements.get(id) === active);
  };

  /**
   * The panel toggles (Ctrl+1–5, the band's Properties button): shows and
   * focuses the panel, and collapses its group when it is already shown and
   * focused. The timeline toggles docked and collapsed (Build: closed).
   */
  function togglePanel(id, state) {
    if (!registry.has(id) || presentation(id) === 'unavailable') return false;
    if (state) {
      onBeforeChange?.();
      if (state === 'hidden') return workspaceApi.hide(id);
      if (state === 'strip') return workspaceApi.fold(id);
      return showPanel(id);
    }
    const current = presentation(id);
    if (id === 'timeline') {
      const group = solution.groups.find(item => item.tabs.includes('timeline'));
      if (group?.timeline && group.state === 'header' && !group.collapsed) return bodyOpen ? (closeBody(), true) : openBody();
      onBeforeChange?.();
      if (current === 'docked') return mode() === 'rig' ? workspaceApi.hide(id) : workspaceApi.fold(id);
      return showPanel(id);
    }
    if (current === 'sheet') { if (sheet.open && sheet.active === id) closeSheet(); else openSheet(id); return true; }
    if (current === 'strip' && flyout?.panel === id) { closeFlyout(); return true; }
    if (registry.isVisible(id) && focusedIn(id) && current === 'docked') { onBeforeChange?.(); return workspaceApi.fold(id); }
    return showPanel(id);
  }

  function toggleTimelineSheet() {
    if (bodyOpen) { closeBody(); return true; }
    return openBody();
  }

  const timelineGroup = () => groupsOf(layoutNow()).find(group => group.tabs.includes('timeline')) ?? null;
  const tallSize = () => Math.floor(TALL_TIMELINE * (app.clientHeight || win.innerHeight));
  let beforeTall = null;
  function isTall() {
    const group = timelineGroup();
    return Boolean(group?.size) && group.size >= tallSize() - 1;
  }
  /** Tall timeline ↔ the height it had before: a size only, so playback and edits carry on. */
  function toggleTall() {
    const group = timelineGroup();
    if (!group) return false;
    const tall = isTall();
    if (!tall) beforeTall = group.size ?? null;
    const next = tall ? beforeTall : tallSize();
    if (tall) beforeTall = null;
    setGroupSize(group.id, next);
    return !tall;
  }
  /** Sets a group's stored size along its split (null: the default). */
  function setGroupSize(groupId, size) {
    return edit(layout => {
      const path = [];
      let found = null;
      const search = (node, at) => {
        if (found) return;
        if (node.type === 'group' && node.id === groupId) { found = at; return; }
        if (node.type === 'split') node.children.forEach((child, index) => search(child, [...at, index]));
      };
      search(layout.root, path);
      if (!found?.length) return layout;
      return resizeChildren(layout, found.slice(0, -1), {[found.at(-1)]: size == null ? null : {size}});
    });
  }

  /** The zone a side name stands for: a split beside the stage (left, right, top, bottom). */
  const sideZone = side => ({kind: 'split', target: STAGE, side: side === 'bottom' || side === 'top' ? side : side === 'left' ? 'left' : 'right'});

  const workspaceApi = {
    get sizes() {
      const s = solution ?? commit();
      const width = id => s.groups.find(group => group.tabs.includes(id) && group.state === 'docked')?.rect.width ?? 0;
      const tl = s.groups.find(group => group.tabs.includes('timeline'));
      return {left: width('structure'), right: width('properties'), timeline: tl?.rect.height ?? 0};
    },
    get preferences() { return store.stored ?? {}; },
    /** The workspace's arrangement (dock-model.mjs). */
    get layout() { return layoutNow(); },
    get state() { return store.state; },
    get solution() { return solution; },
    get tier() { return solution?.tier; },
    get height() { return solution?.height; },
    get stageInsets() { return {...(solution?.stageInsets ?? {top: 0, right: 0, bottom: 0, left: 0})}; },
    get floating() { return (solution?.floats ?? []).map(item => ({id: item.id, panels: [...item.tabs], panel: item.active, x: item.rect.x, y: item.rect.y - origin.y, w: item.rect.width, h: item.rect.height})); },
    get layouts() { return store.state.saved.map(item => ({id: item.id, name: item.name, mode: item.mode})); },
    get readOnly() { return store.readOnly; },
    get preset() { return store.state.workspaces[mode()].preset; },
    get modified() { return isModified(store.state, mode(), {catalog: catalog()}); },
    get focusMode() { return focusActive(store.state, mode()); },
    /** Every workspace at its default; saved layouts stay (Settings › Reset workspace). */
    reset() {
      onBeforeChange?.();
      closeAll();
      store.update(state => resetAll(state, {catalog: catalog()}));
      commit();
    },
    resize: () => commit(),
    flushPreferences: () => store.flush(),
    setPreset(id) {
      onBeforeChange?.();
      closeAll();
      const m = mode();
      store.update(state => applyPreset(state, m, id, {catalog: catalog(), workspaceHeight: workspace.clientHeight}));
      commit();
    },
    togglePanel,
    show: showPanel,
    activate: id => showPanel(id, {focus: false}),
    /** Collapses the panel's group (a float rolls up to its header). */
    fold(id) {
      const place = findPanel(layoutNow(), id);
      if (!place?.group) return false;
      onBeforeChange?.();
      if (flyout?.panel === id) closeFlyout({restoreFocus: false, recommit: false});
      return edit(layout => setCollapsed(layout, place.group.id, true));
    },
    /** Closes a panel; View › Panels and Reset layout bring it back. */
    hide(id) {
      if (!findPanel(layoutNow(), id) || findPanel(layoutNow(), id).where === 'closed') return false;
      onBeforeChange?.();
      if (flyout?.panel === id) closeFlyout({restoreFocus: false, recommit: false});
      return edit(layout => closePanel(layout, id, options()));
    },
    close: id => workspaceApi.hide(id),
    reopen: id => showPanel(id, {focus: false}),
    /** Collapses (`on`, or the opposite of now) or expands a group. */
    collapse(groupId, on) {
      const group = findGroup(layoutNow(), groupId);
      if (!group) return false;
      onBeforeChange?.();
      if (flyout?.group === groupId) closeFlyout({restoreFocus: false, recommit: false});
      return edit(layout => setCollapsed(layout, groupId, on ?? !group.collapsed));
    },
    /**
     * Docks a panel beside the stage on `side` (left, right, top, bottom), as
     * a tab of the panel `tabInto`'s group, or expands it where it already is.
     */
    dock(id, side, {tabInto, index, split} = {}) {
      onBeforeChange?.();
      const layout = layoutNow();
      if (tabInto) {
        const target = findPanel(layout, tabInto)?.group;
        if (!target) return false;
        if (split) return edit(next => movePanel(next, id, {kind: 'split', target: target.id, side: split === 'before' ? 'top' : 'bottom'}, options()));
        return edit(next => movePanel(next, id, {kind: 'tab', group: target.id, index}, options()));
      }
      const place = findPanel(layout, id);
      const group = place?.group ? solution?.groups.find(item => item.id === place.group.id) : null;
      if (group && (group.side === side || (side === 'bottom' && group.side === 'top'))) {
        return edit(next => setCollapsed(activatePanel(next, id), group.id, false));
      }
      return edit(next => movePanel(next, id, sideZone(side), options()));
    },
    /** Moves a panel to a drop zone (dock-model.mjs ZONE_KINDS). */
    move(id, zone) {
      onBeforeChange?.();
      closeFlyout({restoreFocus: false, recommit: false});
      return edit(layout => movePanel(layout, id, zone, options()));
    },
    moveGroup(groupId, zone) {
      onBeforeChange?.();
      closeFlyout({restoreFocus: false, recommit: false});
      return edit(layout => moveGroup(layout, groupId, zone, options()));
    },
    /** Floats a panel at `rect` (relative to the workspace), by default over the stage near its right edge. */
    float(id, rect) {
      const panel = registry.has(id) ? id : null;
      if (!panel) return false;
      onBeforeChange?.();
      const s = solution ?? commit();
      const width = Math.min(320, s.stage.width - 32), height = Math.min(520, s.stage.height - 32);
      const at = rect ?? {x: Math.round(s.stage.x + s.stage.width - width - 24), y: Math.round(s.stage.y - origin.y + 56), w: width, h: height};
      return edit(layout => movePanel(layout, id, {kind: 'float', rect: at}, options()));
    },
    placeFloat(floatId, rect) { return edit(layout => placeFloat(layout, floatId, rect)); },
    /** Docks a float back where it came from (its panels' home when that place is gone). */
    dockFloat(floatId) {
      onBeforeChange?.();
      return edit(layout => dockFloat(layout, floatId, options()));
    },
    focus(on) {
      onBeforeChange?.();
      closeAll();
      const m = mode();
      store.update(state => toggleFocus(state, m, {on}));
      commit();
    },
    /** Re-applies the workspace's layout (built-in or saved): always works. */
    resetWorkspace() {
      onBeforeChange?.();
      closeAll();
      const m = mode();
      store.update(state => resetWorkspace(state, m, {catalog: catalog()}));
      commit();
    },
    saveLayout(name) {
      const m = mode();
      let result;
      store.update(state => (result = saveLayout(state, {name, mode: m})).state);
      commit();
      if (result?.error) throw messageError(new Error(''), result.error === 'limit' ? 'dockHost.layoutLimitReached' : 'dockHost.nameThePresetFirst', {count: MAX_SAVED_LAYOUTS});
      return result.id;
    },
    deleteLayout(id) { store.update(state => deleteLayout(state, id)); commit(); },
    renameLayout(id, name) {
      let result;
      store.update(state => (result = renameLayout(state, id, name)).state);
      commit();
      if (result?.error) throw messageError(new Error(''), result.error === 'name' ? 'dockHost.nameThePresetFirst' : 'dockHost.thisPresetNoLongerExists');
    },
    updateLayout(id) { store.update(state => updateLayout(state, id).state); commit(); },
    canSaveLayout: () => (store.state.saved.length >= MAX_SAVED_LAYOUTS ? {ok: false, reason: 'limit'} : {ok: true}),
    /** The workspace's arrangement as a layout file's JSON value. */
    exportLayout: () => exportLayout(store.state, mode()),
    /** Saves a layout file's value as a named layout of this workspace and applies it. */
    importLayout(value, {name} = {}) {
      const m = mode();
      let result;
      store.update(state => (result = importLayout(state, value, {mode: m, name, catalog: catalog()})).state);
      commit();
      if (result?.error) throw messageError(new Error(''), result.error === 'newer' ? 'dockHost.layoutFromNewerVersion' : result.error === 'limit' ? 'dockHost.layoutLimitReached' : 'dockHost.layoutFileUnreadable', {count: MAX_SAVED_LAYOUTS});
      return result.id;
    },
    presetLayout: id => presetLayout(id, mode(), {catalog: catalog(), state: store.state}),
    setRail(side) {
      if (side !== 'left' && side !== 'right') return false;
      onBeforeChange?.();
      return edit(layout => setTools(layout, side));
    },
    /** The timeline across the window (`full`) or under the stage only (`stage`). */
    setTimelineSpan(span) {
      if (span !== 'full' && span !== 'stage') return false;
      onBeforeChange?.();
      return edit(layout => movePanel(layout, 'timeline', span === 'full' ? {kind: 'edge', side: 'bottom'} : sideZone('bottom'), options()));
    },
    /** Timeline ⋯ › Default height: the stored height goes, so the window's default applies again. */
    defaultTimelineHeight() {
      const group = timelineGroup();
      return group ? setGroupSize(group.id, null) : false;
    },
    toggleTall,
    get tall() { return isTall(); },
    timelineSheet: toggleTimelineSheet,
    destroy: () => destroy(),
  };

  function closeAll() {
    closeSheet({restoreFocus: false, recommit: false});
    closeFlyout({restoreFocus: false, recommit: false});
    closeBody({restoreFocus: false, recommit: false});
  }

  // ---------------------------------------------------------------------
  // Lifecycle

  function modeChanged() {
    const next = mode();
    if (next === currentMode) return;
    currentMode = next;
    closeAll();
    // Entering Draw or Build shows Properties; Animate keeps its own last tab.
    const place = findPanel(layoutNow(), 'properties');
    if (next !== 'animate' && place?.group && place.group.active !== 'properties' && !place.group.collapsed) edit(layout => activatePanel(layout, 'properties'));
    else commit();
  }

  const resizeObserver = new win.ResizeObserver(() => commit());
  resizeObserver.observe(app);
  resizeObserver.observe(workspace);
  const stopTouch = touch?.on?.(() => {
    closeAll();
    bandWatch?.refresh();
    commit();
  });
  if (band) resizeObserver.observe(band);
  const rail = workspace.querySelector('.shell-rail');
  const railFit = () => {
    const dock = rail.querySelector(':scope > .tool-dock');
    if (solution?.rail?.orientation === 'horizontal') {
      if (railColumns !== 1) { railColumns = 1; rail.toggleAttribute('data-columns', false); schedule(); }
    } else if (dock && solution?.rail?.rect) {
      const items = [...dock.children].filter(node => node.offsetParent !== null);
      const box = win.getComputedStyle(rail), gap = parseFloat(win.getComputedStyle(dock).rowGap) || 0;
      const add = dock.querySelector(':scope > .rail-add');
      const apart = add && add.offsetParent !== null ? parseFloat(win.getComputedStyle(add).marginBlockEnd) || 0 : 0;
      const natural = items.reduce((sum, node) => sum + node.offsetHeight, 0) + gap * Math.max(0, items.length - 1)
        + (parseFloat(box.paddingTop) || 0) + (parseFloat(box.paddingBottom) || 0) + apart
        + [...rail.children].filter(node => node !== dock && node.offsetParent !== null).reduce((sum, node) => {
          const style = win.getComputedStyle(node);
          return sum + node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        }, 0);
      const columns = mode() === 'rig' || items.length > 1 && natural > solution.rail.rect.height + 0.5 ? 2 : 1;
      if (columns !== railColumns) {
        railColumns = columns;
        rail.toggleAttribute('data-columns', columns === 2);
        schedule();
      }
    }
    const horizontal = solution?.rail?.orientation === 'horizontal';
    const more = !horizontal && rail.scrollHeight - rail.scrollTop - rail.clientHeight > 1;
    if (rail.hasAttribute('data-more-below') !== more) rail.toggleAttribute('data-more-below', more);
    const after = horizontal && rail.scrollWidth - rail.scrollLeft - rail.clientWidth > 1;
    if (rail.hasAttribute('data-more-after') !== after) rail.toggleAttribute('data-more-after', after);
  };
  const railObserver = rail ? new win.ResizeObserver(railFit) : null;
  if (rail) {
    for (const element of [rail, ...rail.children]) railObserver.observe(element);
    rail.addEventListener('scroll', railFit, {passive: true, signal});
    listeners.solve.add(() => railFit());
  }
  const bandWatch = band ? watchBand(band, {window: win, document: doc, storage: browserStorage(win), start: ready, onChange: () => schedule()}) : null;
  const modeObserver = new win.MutationObserver(modeChanged);
  modeObserver.observe(workspace, {attributes: true, attributeFilter: ['data-mode']});
  registry.on('define', () => schedule(), {signal});
  store.on('change', ({origin: from}) => { if (from === 'merge') schedule(); });
  win.addEventListener('blur', () => { if (dragging) dividerEls.get(dragging.key)?.dispatchEvent(new win.Event('pointercancel')); }, {signal});
  win.addEventListener('pagehide', () => { void store.flush(); }, {signal});

  function destroy() {
    if (destroyed) return store.flush();
    destroyed = true;
    abort.abort();
    stopTouch?.();
    resizeObserver.disconnect();
    railObserver?.disconnect();
    modeObserver.disconnect();
    bandWatch?.stop();
    if (frame) win.cancelAnimationFrame(frame);
    for (const el of dividerEls.values()) el.remove();
    return store.destroy();
  }

  commit();

  return {
    registry,
    store,
    workspace: workspaceApi,
    get solution() { return solution; },
    stageInsets: () => ({...(solution?.stageInsets ?? {top: 24, right: 28, bottom: 24, left: 28})}),
    define: descriptorInput => registry.define(descriptorInput),
    showPanel,
    togglePanel,
    toggleTimelineSheet,
    toggleTall,
    closeSheets({restoreFocus = false} = {}) {
      closeSheet({restoreFocus, recommit: false});
      closeFlyout({restoreFocus, recommit: false});
      closeBody({restoreFocus, recommit: false});
      commit();
    },
    /** True when the panel exists in this workspace (every panel may go anywhere). */
    canPlace: id => panelsOf(mode(), catalog()).includes(id),
    presentation,
    get mode() { return mode(); },
    commit,
    solveOnly,
    /** The offset of solution rectangles from the workspace's box (the band above it). */
    get origin() { return {...origin}; },
    onSolve(listener) {
      listeners.solve.add(listener);
      return () => listeners.solve.delete(listener);
    },
    /** The elements of the regions, in reading order, for F6 (dock-keyboard.mjs). */
    regions() {
      const s = solution;
      const list = [];
      const head = stage?.querySelector(':scope > .stage-head');
      walk(s?.layout?.root, node => {
        if (node.type === STAGE) list.push(head, viewport);
        else if (node.type === 'group') {
          const group = s.groups.find(item => item.id === node.id);
          if (!group) return;
          list.push(group.timeline && group.state !== 'strip' ? timeline : group.state === 'strip' ? strips.get(group.id) : islands.get(group.id));
        }
      });
      const floats = s?.floats.map(float => islands.get(float.group)).filter(Boolean) ?? [];
      return {band, rail, stage, viewport, timeline, ordered: [band, rail, ...list, ...floats].filter(Boolean), floats, islands, strips, flyout: flyoutElement, sheet: sheet.element};
    },
    get flyout() { return flyout ? {...flyout} : null; },
    destroy,
  };
}
