import {t as interfaceText} from '../localization.mjs';
import {localizedAttribute, localizedText, clearTranslation, appendLocalized, connectTranslations} from '../localization-bindings.mjs';
/**
 * Arranging panels by hand (docs/DOCKING.md):
 *
 * - Drag a tab, a strip's icon or a group's header past a 4px slop: the place
 *   a release gives it shows as a soft area of the exact size the panel will
 *   take (the arrangement is solved with the move applied; nothing else
 *   moves while you drag), named by a small label. Drop zones: a group's tab
 *   row (add as a tab, at the insertion bar), the edges of a group (split
 *   it), the edges of the stage (dock beside it), the window's edges (dock
 *   across the window); anywhere else floats it. Shift floats; Escape or
 *   leaving the window cancels, and the arrangement stays as it was.
 * - A float's header moves it (and docks it, over a zone); its corner grip
 *   resizes it; a double press on its header docks it back.
 * - The tool bar's grip moves it between the stage's sides.
 * - Right-click a tab, a strip icon or a header (or Shift+F10, or the Menu
 *   key) for the panel's menu: dock left, right or below the stage, float,
 *   collapse or expand its group, close.
 *
 * Every change runs the dock host's workspace API, so a drag, a menu, the
 * Layout popover and the keyboard move (dock-keyboard.mjs) agree.
 */
import {STAGE, findPanel, movePanel, moveGroup} from './dock-model.mjs';

const SLOP = 4;
const EDGE = 16;
const PANEL_HANDLE = '.shell-tabs [role="tab"][data-panel], .shell-strip-button[data-panel]';
const CONTROLS = 'button, input, select, textarea, a[href], [role="slider"], [role="tab"], [contenteditable], .shell-panel, .shell-float-grip';

/**
 * The group whose header a pointer event is on, or null: the empty part of an
 * island's tab row (the island's top 40px outside its tabs), a strip outside
 * its icons, or the empty part of the timeline's own header.
 */
export function groupHeaderAt(event) {
  const target = event.target;
  const island = target?.closest?.('.shell-island[data-group], .shell-strip[data-group], .shell-placed[data-group]');
  if (!island || island.closest('.shell-sheet')) return null;
  if (target.closest(CONTROLS) && !target.matches('.shell-tabs')) return null;
  if (island.matches('.shell-strip')) return {element: island, group: island.dataset.group};
  if (island.matches('.shell-placed')) return target.closest('.timeline-toolbar') ? {element: target.closest('.timeline-toolbar'), group: island.dataset.group} : null;
  const top = island.getBoundingClientRect().top;
  return event.clientY - top <= 40 ? {element: island.querySelector(':scope > .shell-tabs') ?? island, group: island.dataset.group} : null;
}
const LABEL_KEYS = Object.freeze({
  tab: 'dockTabs.addAsATab', float: 'dockTabs.floatHere',
  'split-left': 'dockTabs.splitLeft', 'split-right': 'dockTabs.splitRight', 'split-top': 'dockTabs.splitAbove', 'split-bottom': 'dockTabs.splitBelow',
  'stage-left': 'dockTabs.dockLeft', 'stage-right': 'dockTabs.dockRight', 'stage-top': 'dockTabs.dockAbove', 'stage-bottom': 'dockTabs.dockBelow',
  'edge-left': 'dockTabs.dockLeftEdge', 'edge-right': 'dockTabs.dockRightEdge', 'edge-top': 'dockTabs.dockTopEdge', 'edge-bottom': 'dockTabs.dockBottomEdge',
  'rail-left': 'dockTabs.moveToolsLeft', 'rail-right': 'dockTabs.moveToolsRight',
});
export const zoneLabelKey = zone => LABEL_KEYS[zone.kind === 'split' ? `${zone.target === STAGE ? 'stage' : 'split'}-${zone.side}` : zone.kind === 'edge' ? `edge-${zone.side}` : zone.kind];

const inside = (rect, x, y) => rect && rect.width > 0 && rect.height > 0 && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
const zoneKey = zone => (zone ? JSON.stringify([zone.kind, zone.group, zone.index, zone.target, zone.side, zone.kind === 'float' ? null : 0]) : '');

/**
 * Every place a panel (or a group, `source.group`) can go, for the keyboard
 * move: each other group's tabs, each side of each group and of the stage,
 * each window edge, and floating. In reading order.
 */
export function dockTargets(host, source) {
  const s = host.solution;
  if (!s) return [];
  const own = source.group ?? findPanel(s.layout, source.panel)?.group?.id ?? null;
  const zones = [];
  for (const side of ['left', 'right', 'bottom', 'top']) zones.push({kind: 'split', target: STAGE, side});
  for (const group of s.groups) {
    if (group.id !== own) zones.push({kind: 'tab', group: group.id});
    if (group.id !== own || (!source.group && group.tabs.length > 1)) for (const side of ['left', 'right', 'top', 'bottom']) zones.push({kind: 'split', target: group.id, side});
  }
  for (const float of s.floats) if (float.group !== own) zones.push({kind: 'tab', group: float.group});
  for (const side of ['left', 'right', 'bottom', 'top']) zones.push({kind: 'edge', side});
  zones.push({kind: 'float'});
  return zones;
}

/**
 * The arrangement a zone gives `source` ({panel} or {group}), or null when
 * it changes nothing; floats land at `rect` (workspace coordinates).
 */
export function applyZone(host, source, zone) {
  const layout = host.solution?.layout;
  if (!layout || !zone) return null;
  const options = {mode: host.mode, catalog: host.registry.constraints()};
  const next = source.group ? moveGroup(layout, source.group, zone, options) : movePanel(layout, source.panel, zone, options);
  return next === layout ? null : next;
}

/** Where `source` ends up under a zone, in #app coordinates: the exact rectangle of its group, solved. */
export function previewRect(host, source, zone) {
  const next = applyZone(host, source, zone);
  if (!next) return null;
  const solved = host.solveOnly(next);
  const id = source.panel ?? host.solution.groups.find(group => group.id === source.group)?.tabs[0] ?? host.solution.floats.find(float => float.group === source.group)?.tabs[0];
  const float = solved.floats.find(item => item.tabs.includes(id));
  if (float) return float.rect;
  const group = solved.groups.find(item => item.tabs.includes(id));
  return group?.rect ?? null;
}

/** A float's rect for a drop at (x, y) in #app coordinates. */
function floatRectAt(host, drag, x, y) {
  const s = host.solution;
  const float = drag.source.group ? s.floats.find(item => item.group === drag.source.group) : null;
  const ids = drag.source.panel ? [drag.source.panel] : s.groups.find(group => group.id === drag.source.group)?.tabs ?? [];
  const wide = ids.includes('timeline');
  const width = Math.round(Math.min(float?.rect.width ?? (wide ? 720 : Math.max(...ids.map(id => host.registry.get(id)?.pref ?? 320), 320)), s.inner.width));
  const height = Math.round(Math.min(float?.rect.height ?? (wide ? 320 : 480), s.inner.height));
  const left = Math.round(x - Math.min(drag.grabX, width - 24));
  const top = Math.round(y - Math.min(drag.grabY, 20));
  return {x: left, y: top - host.origin.y, w: width, h: height, app: {x: left, y: top, width, height}};
}

/**
 * `host` is the dock host; `openMenu(items, anchor, {label})` shows a menu;
 * `announce(text)` speaks a short status.
 */
export function installDockTabs({host, document: doc = globalThis.document, window: win = globalThis.window, openMenu, announce = () => {}} = {}) {
  const workspaceElement = doc.querySelector('.workspace');
  const app = doc.getElementById('app') ?? doc.documentElement;
  const abort = new AbortController(), signal = abort.signal;
  const workspace = host.workspace;
  const title = id => (id === 'tools' ? interfaceText('dockTabs.tools') : host.registry.get(id)?.titleKey ? interfaceText(host.registry.get(id).titleKey) : host.registry.get(id)?.title ?? id);
  const titleMessage = id => (id === 'tools' ? {messageKey: 'dockTabs.tools'} : host.registry.get(id)?.titleKey ? {messageKey: host.registry.get(id).titleKey} : title(id));
  const railHandle = doc.createElement('button');
  railHandle.type = 'button'; railHandle.className = 'shell-rail-handle'; railHandle.dataset.panel = 'tools';
  localizedAttribute(railHandle, 'aria-label', 'dockTabs.moveTools', {});
  localizedAttribute(railHandle, 'title', 'dockTabs.dragToEitherSideLeftAndRightArrows', {});
  host.regions().rail?.prepend(railHandle);
  connectTranslations(railHandle);
  let press = null, drag = null, suppressClick = false;

  // -------------------------------------------------------------------
  // The panel menu

  const groupOf = id => host.solution?.groups.find(group => group.tabs.includes(id)) ?? null;
  const floatOf = id => host.solution?.floats.find(float => float.tabs.includes(id)) ?? null;
  /** The panel's menu: the places it may go from where it is, its group's collapse, close. */
  function menuItems(id) {
    if (id === 'tools') return ['left', 'right'].map(side => ({label: interfaceText(LABEL_KEYS[`rail-${side}`]), labelKey: LABEL_KEYS[`rail-${side}`],
      icon: `panel-${side}`, run: () => { workspace.setRail(side); announce(interfaceText(LABEL_KEYS[`rail-${side}`])); }}));
    const group = groupOf(id), float = floatOf(id);
    const items = [];
    const dock = (side, labelKey, glyph) => ({label: interfaceText(labelKey), labelKey, icon: glyph, run: () => moveTo(id, {kind: 'split', target: STAGE, side})});
    if (!(group?.side === 'left' && group.state === 'docked')) items.push(dock('left', 'dockTabs.dockLeft', 'panel-left'));
    if (!(group?.side === 'right' && group.state === 'docked')) items.push(dock('right', 'dockTabs.dockRight', 'panel-right'));
    if (!(group?.side === 'bottom' && group.state === 'docked')) items.push(dock('bottom', 'dockTabs.dockBelow', 'panel-bottom'));
    if (!float) items.push({label: interfaceText('dockTabs.float'), labelKey: 'dockTabs.float', icon: 'layout', run: () => { workspace.float(id); announce(interfaceText('dockTabs.floatingPanel', {title: titleMessage(id)})); }});
    else items.push({label: interfaceText('dockTabs.dockBack'), labelKey: 'dockTabs.dockBack', icon: 'panel-right', run: () => workspace.dockFloat(float.id)});
    items.push(null);
    const collapsed = group ? group.state !== 'docked' : float?.collapsed;
    if (group || float) {
      const groupId = group?.id ?? float.group;
      items.push(collapsed
        ? {label: interfaceText('dockTabs.expand'), labelKey: 'dockTabs.expand', icon: 'maximize', run: () => { workspace.collapse(groupId, false); host.showPanel(id); }}
        : {label: interfaceText('dockTabs.collapse'), labelKey: 'dockTabs.collapse', icon: 'minimize', run: () => { workspace.collapse(groupId, true); announce(interfaceText('dockTabs.foldedPanel', {title: titleMessage(id)})); }});
    }
    items.push({label: interfaceText('dockTabs.close'), labelKey: 'dockTabs.close', icon: 'x', run: () => { workspace.hide(id); announce(interfaceText('dockTabs.hiddenPanel', {title: titleMessage(id)})); }});
    return items;
  }

  function moveTo(id, zone) {
    workspace.move(id, zone);
    announce(interfaceText('dockKeyboard.panelLocation', {title: titleMessage(id), place: {messageKey: zoneLabelKey(zone)}}));
    host.showPanel(id, {focus: false});
  }

  function showMenu(handle, at) {
    const id = handle.dataset.panel ?? host.solution?.groups.find(group => group.id === handle.closest('[data-group]')?.dataset.group)?.active
      ?? host.solution?.floats.find(float => float.group === handle.closest('[data-group]')?.dataset.group)?.active;
    if (!id || (id !== 'tools' && !host.registry.has(id))) return;
    const box = handle.getBoundingClientRect();
    const point = at && at.nodeType !== 1 ? at : {left: box.left, bottom: box.bottom, invoker: handle};
    openMenu(menuItems(id), point, {label: interfaceText('dockTabs.panel', {value: titleMessage(id)}), labelKey: 'dockTabs.panel', labelParams: {value: titleMessage(id)}});
  }

  const MENU_HANDLE = `${PANEL_HANDLE}, .shell-rail-handle, .shell-island > .shell-tabs`;
  workspaceElement.addEventListener('contextmenu', event => {
    const handle = event.target.closest?.(MENU_HANDLE);
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    const keyboard = !event.clientX && !event.clientY;
    showMenu(handle, keyboard ? null : {left: event.clientX, bottom: event.clientY, invoker: handle});
  }, {signal});
  doc.addEventListener('keydown', event => {
    const handle = event.target.closest?.(`${PANEL_HANDLE}, .shell-rail-handle`);
    if (!handle || !workspaceElement.contains(handle) && !handle.closest('.shell-sheet')) return;
    if (handle === railHandle && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const side = event.key === 'ArrowLeft' ? 'left' : 'right';
      workspace.setRail(side); announce(interfaceText(LABEL_KEYS[`rail-${side}`]));
      return;
    }
    if (!((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
    event.preventDefault();
    event.stopPropagation();
    showMenu(handle);
  }, {signal, capture: true});

  // -------------------------------------------------------------------
  // Dragging

  const zone = doc.createElement('div');
  zone.className = 'ui-drop-zone shell-drag-zone';
  zone.hidden = true;
  const zoneLabel = doc.createElement('span');
  zoneLabel.className = 'ui-drop-label';
  appendLocalized(zone, zoneLabel);
  const ghost = doc.createElement('div');
  ghost.className = 'shell-drag-ghost';
  ghost.hidden = true;
  ghost.setAttribute('aria-hidden', 'true');

  const appBox = () => app.getBoundingClientRect();
  const toApp = (x, y) => { const box = appBox(); return {x: x - box.left, y: y - box.top}; };

  /** The tab insertion index in a group's island at x (client), and the bar's x inside the island. */
  function insertion(groupId, x) {
    const island = workspaceElement.querySelector(`.shell-island[data-group="${groupId}"]`);
    const tabs = [...(island?.querySelectorAll(':scope > .shell-tabs > [role="tab"]:not([hidden])') ?? [])];
    if (!tabs.length) return {index: undefined, at: null};
    const box = island.getBoundingClientRect();
    let index = tabs.length, at = tabs.at(-1).getBoundingClientRect().right - box.left + 2;
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      if (x < rect.left + rect.width / 2) { index = i; at = rect.left - box.left - 2; break; }
    }
    // A tab dropped back on its own group moves past itself.
    const own = drag.source.panel ? tabs.findIndex(tab => tab.dataset.panel === drag.source.panel) : -1;
    if (own >= 0 && index > own) index -= 1;
    return {index, at};
  }

  /** The zone under the pointer (client coordinates). */
  function zoneAt(cx, cy, shift) {
    const s = host.solution;
    if (!s) return null;
    const {x, y} = toApp(cx, cy);
    if (drag.source.panel === 'tools') {
      if (!inside(s.stage, x, y)) return null;
      return {kind: x < s.stage.x + s.stage.width / 2 ? 'rail-left' : 'rail-right'};
    }
    const own = drag.source.group;
    const ownPanel = drag.source.panel ? findPanel(s.layout, drag.source.panel) : null;
    const alone = ownPanel?.group && ownPanel.group.tabs.length === 1 ? ownPanel.group.id : null;
    if (shift) return {kind: 'float'};
    // The window's edges.
    const window = s.rects.workspace;
    if (inside(window, x, y)) {
      if (x <= window.x + EDGE) return {kind: 'edge', side: 'left'};
      if (x >= window.x + window.width - EDGE) return {kind: 'edge', side: 'right'};
      if (y >= window.y + window.height - EDGE) return {kind: 'edge', side: 'bottom'};
    }
    // Floats, topmost first.
    for (const float of [...s.floats].reverse()) {
      if (!inside(float.rect, x, y)) continue;
      if (float.group === own || float.group === alone) return {kind: 'float'};
      return {kind: 'tab', group: float.group, index: y <= float.rect.y + 40 ? insertion(float.group, cx).index : undefined, bar: y <= float.rect.y + 40};
    }
    for (const group of s.groups) {
      if (!inside(group.rect, x, y)) continue;
      const self = group.id === own || group.id === alone;
      if (group.state !== 'docked') return self ? {kind: 'float'} : {kind: 'tab', group: group.id};
      const head = group.timeline ? 40 : 40;
      if (y <= group.rect.y + head && !self) {
        const {index} = group.timeline ? {index: undefined} : insertion(group.id, cx);
        return {kind: 'tab', group: group.id, index, bar: !group.timeline};
      }
      const fx = (x - group.rect.x) / group.rect.width, fy = (y - group.rect.y) / group.rect.height;
      const edges = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((a, b) => a[1] - b[1]);
      if (edges[0][1] < 0.25 && !(self && !drag.source.panel)) {
        if (self && group.tabs.length === 1) return null;
        return {kind: 'split', target: group.id, side: edges[0][0]};
      }
      if (self) return group.id === alone || group.id === own ? null : {kind: 'tab', group: group.id};
      return {kind: 'tab', group: group.id};
    }
    if (inside(s.stage, x, y)) {
      // The stage's edges (a fifth of it, at most 96px) dock beside it; its middle floats.
      const band = axis => Math.min(96, (axis === 'x' ? s.stage.width : s.stage.height) * 0.2);
      const edges = [['left', x - s.stage.x, band('x')], ['right', s.stage.x + s.stage.width - x, band('x')],
        ['top', y - s.stage.y, band('y')], ['bottom', s.stage.y + s.stage.height - y, band('y')]].filter(([, d, limit]) => d < limit).sort((a, b) => a[1] - b[1]);
      if (edges.length) return {kind: 'split', target: STAGE, side: edges[0][0]};
    }
    return {kind: 'float'};
  }

  /** Shows the zone: the exact rectangle the source would take, cached per zone. */
  function show(target, cx, cy) {
    const s = host.solution;
    if (target?.kind === 'float') {
      const {x, y} = toApp(cx, cy);
      target.rect = floatRectAt(host, drag, x, y);
    }
    drag.target = target;
    if (!target) { zone.hidden = true; return; }
    let rect;
    if (target.kind === 'rail-left' || target.kind === 'rail-right') {
      const left = target.kind === 'rail-left';
      rect = {x: left ? s.viewport.x + 12 : s.viewport.x + s.viewport.width - s.rail.width - 12, y: s.viewport.y + 12, width: s.rail.width, height: Math.max(0, s.viewport.height - 24)};
    } else if (target.kind === 'float') {
      rect = target.rect.app;
      // A float being moved follows the pointer itself; its zone is the float.
      if (drag.floatIsland) { zone.hidden = true; moveFloatIsland(rect); setLabel(target); return; }
    } else {
      const key = zoneKey(target);
      if (drag.cache.has(key)) rect = drag.cache.get(key);
      else { rect = previewRect(host, drag.source, target); drag.cache.set(key, rect); }
      if (!rect) { drag.target = null; zone.hidden = true; return; }
    }
    if (drag.floatIsland) moveFloatIsland(null);
    const box = appBox();
    if (zone.parentElement !== doc.body) doc.body.insertBefore(zone, ghost.parentElement === doc.body ? ghost : null);
    Object.assign(zone.style, {left: `${Math.round(rect.x + box.left)}px`, top: `${Math.round(rect.y + box.top)}px`,
      width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`});
    zone.dataset.target = target.kind;
    zone.dataset.kind = target.kind;
    if (target.kind === 'tab' && target.bar && target.index !== undefined) {
      const {at} = insertion(target.group, cx);
      if (at !== null) zone.style.setProperty('--insert-at', `${Math.round(at)}px`);
    } else zone.style.removeProperty('--insert-at');
    zone.toggleAttribute('data-bar', Boolean(target.bar));
    setLabel(target);
    zone.hidden = false;
  }

  function setLabel(target) {
    const key = target.kind.startsWith('rail-') ? LABEL_KEYS[target.kind] : zoneLabelKey(target);
    if (zoneLabel.getAttribute('data-i18n') !== key) { localizedText(zoneLabel, key); announce(interfaceText(key)); }
  }

  /** A float being dragged by its header follows the pointer (a transform only; nothing is solved). */
  function moveFloatIsland(rect) {
    const island = drag.floatIsland;
    if (!rect) { island.style.translate = ''; island.style.opacity = '0.5'; return; }
    island.style.opacity = '';
    const start = drag.floatStart;
    island.style.translate = `${Math.round(rect.x - start.x)}px ${Math.round(rect.y - start.y)}px`;
  }

  function begin(event) {
    const {handle, source, pointerId} = press;
    const islandBox = (handle.closest('.shell-island, .shell-strip, .shell-placed') ?? handle).getBoundingClientRect();
    drag = {handle, source, pointerId, target: null, shift: event.shiftKey, cache: new Map(),
      grabX: Math.max(16, press.x - islandBox.left), grabY: Math.max(12, press.y - islandBox.top), floatIsland: null};
    press = null;
    try { handle.setPointerCapture(pointerId); } catch { /* the pointer is gone */ }
    handle.dataset.dragging = 'true';
    const float = source.group ? host.solution?.floats.find(item => item.group === source.group) : null;
    if (float) {
      drag.floatIsland = handle.closest('.shell-island');
      drag.floatStart = {...float.rect};
      drag.floatId = float.id;
    }
    const id = source.panel ?? host.solution?.groups.find(group => group.id === source.group)?.active ?? float?.active;
    const name = titleMessage(id);
    if (name?.messageKey) localizedText(ghost, name.messageKey, name.messageParams);
    else { clearTranslation(ghost); ghost.textContent = name; }
    if (ghost.parentElement !== doc.body) appendLocalized(doc.body, ghost);
    ghost.hidden = Boolean(drag.floatIsland);
    follow(event);
    win.addEventListener('keydown', onKey, {capture: true, signal});
  }

  function follow(event) {
    ghost.style.translate = `${Math.round(event.clientX + 12)}px ${Math.round(event.clientY + 12)}px`;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const target = zoneAt(event.clientX, event.clientY, event.shiftKey || drag.shift);
    // A float dragged over open space is moved, not re-docked.
    show(target, event.clientX, event.clientY);
  }

  function end(commit) {
    if (!drag) return;
    const {handle, source, pointerId, target, floatIsland, floatId} = drag;
    drag = null;
    delete handle.dataset.dragging;
    zone.hidden = true;
    ghost.hidden = true;
    if (floatIsland) { floatIsland.style.translate = ''; floatIsland.style.opacity = ''; }
    win.removeEventListener('keydown', onKey, {capture: true});
    try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* released */ }
    suppressClick = true;
    win.setTimeout(() => { suppressClick = false; }, 0);
    if (!commit || !target) { if (!commit) announce(interfaceText('dockTabs.moveCancelled')); return; }
    if (target.kind === 'rail-left' || target.kind === 'rail-right') {
      const side = target.kind.slice(5);
      workspace.setRail(side);
      announce(interfaceText(LABEL_KEYS[target.kind]));
      return;
    }
    const zoneValue = target.kind === 'float' ? {kind: 'float', rect: {x: target.rect.x, y: target.rect.y, w: target.rect.w, h: target.rect.h}} : target;
    if (floatId && target.kind === 'float') { workspace.placeFloat(floatId, zoneValue.rect); return; }
    if (source.group) workspace.moveGroup(source.group, zoneValue);
    else {
      workspace.move(source.panel, zoneValue);
      host.showPanel(source.panel, {focus: false});
    }
    announce(interfaceText('dockKeyboard.panelLocation', {title: titleMessage(source.panel ?? host.solution?.groups.find(group => group.id === source.group)?.active ?? ''), place: {messageKey: zoneLabelKey(target)}}));
  }

  function onKey(event) {
    if (!drag) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(false); return; }
    if (event.key === 'Shift') { drag.shift = true; show(zoneAt(drag.x, drag.y, true), drag.x, drag.y); }
  }

  // Resizing a float by its corner grip: the island follows the pointer; the release stores the size.
  let resize = null;
  workspaceElement.addEventListener('pointerdown', event => {
    const grip = event.target.closest?.('.shell-float-grip');
    if (grip && event.button === 0) {
      const island = grip.closest('.shell-island');
      const float = host.solution?.floats.find(item => item.id === island?.dataset.floating);
      if (!float) return;
      event.preventDefault();
      resize = {pointerId: event.pointerId, island, float, x: event.clientX, y: event.clientY};
      grip.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0 || drag) return;
    const handle = event.target.closest?.(`${PANEL_HANDLE}, .shell-rail-handle`);
    if (handle) {
      const panel = handle.dataset.panel;
      if (panel !== 'tools' && !host.registry.has(panel)) return;
      if (handle.closest('.shell-sheet:not(.shell-flyout)')) return;
      press = {handle, source: {panel}, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
      return;
    }
    const header = groupHeaderAt(event);
    if (!header) return;
    press = {handle: header.element, source: {group: header.group}, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
  }, {signal});
  win.addEventListener('pointermove', event => {
    if (resize?.pointerId === event.pointerId) {
      const width = Math.max(200, resize.float.rect.width + event.clientX - resize.x);
      const height = Math.max(120, resize.float.rect.height + event.clientY - resize.y);
      resize.size = {width: Math.round(width), height: Math.round(height)};
      resize.island.style.width = `${resize.size.width}px`;
      resize.island.style.height = `${resize.size.height}px`;
      return;
    }
    if (drag?.pointerId === event.pointerId) { follow(event); return; }
    if (!press || press.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= SLOP) begin(event);
  }, {signal});
  const endResize = commit => {
    if (!resize) return;
    const {float, size} = resize;
    resize = null;
    if (commit && size) {
      const origin = host.origin;
      workspace.placeFloat(float.id, {x: float.rect.x, y: float.rect.y - origin.y, w: size.width, h: size.height});
    } else host.commit();
  };
  win.addEventListener('pointerup', event => {
    if (resize?.pointerId === event.pointerId) endResize(true);
    if (drag?.pointerId === event.pointerId) end(true);
    if (press?.pointerId === event.pointerId) press = null;
  }, {signal});
  win.addEventListener('pointercancel', () => { press = null; end(false); endResize(false); }, {signal});
  win.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) end(false); }, {signal});
  win.addEventListener('blur', () => { press = null; end(false); endResize(false); }, {signal});
  win.addEventListener('keyup', event => {
    if (drag && event.key === 'Shift') { drag.shift = false; show(zoneAt(drag.x, drag.y, false), drag.x, drag.y); }
  }, {signal});
  // The click that ends a drag is not a tab press.
  workspaceElement.addEventListener('click', event => {
    if (suppressClick && (event.target.closest?.(`${PANEL_HANDLE}, .shell-rail-handle`) || groupHeaderAt(event))) { event.stopImmediatePropagation(); event.preventDefault(); }
  }, {signal, capture: true});

  return {
    menuItems,
    showMenu,
    get dragging() { return drag ? {source: {...drag.source}, target: drag.target?.kind ?? null} : null; },
    destroy() { end(false); abort.abort(); zone.remove(); ghost.remove(); railHandle.remove(); },
  };
}

