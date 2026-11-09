import {t as interfaceText} from '../localization.mjs';
import {appendLocalized, localizedText} from '../localization-bindings.mjs';
/**
 * Keyboard paths through the docked window (WCAG 2.5.7: every drag has one).
 *
 * - F6 and Ctrl+F6 (`focus-next-region`, `focus-previous-region`) cycle the
 *   regions in reading order: the band, the tool bar, then the arrangement's
 *   groups and the stage (its header, then the canvas) as the tree lists
 *   them, then the floats. Each region takes focus at its selected tab, the
 *   canvas, its named collection or its first control; hidden regions are
 *   skipped. It works from a text field and in the browser.
 * - Ctrl+Alt+M (`layout-arrange`) moves the focused panel: the arrow keys
 *   step through every place it may go (dock-tabs.mjs dockTargets), the
 *   exact area it would take shows with its name, Enter moves it and Escape
 *   (or Tab, or a click) cancels. While it moves, no other key reaches the
 *   editor.
 */
import {dockTargets, previewRect, zoneLabelKey} from './dock-tabs.mjs';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** A region's main collection, where focus lands before its first control. */
export const COLLECTIONS = '[role="tree"][aria-label], [role="grid"][aria-label], [role="listbox"][aria-label]';

const shown = element => Boolean(element?.isConnected && element.getClientRects().length && !element.closest('[hidden], [inert], .shell-parking'));

export function createDockKeyboard({document: doc = globalThis.document, window: win = globalThis.window, host, announce = () => {}} = {}) {
  const panelName = id => {
    const panel = host.registry.get(id);
    return panel?.titleKey ? {messageKey: panel.titleKey} : panel?.title ?? id;
  };
  const regionList = () => host.regions().ordered.filter(shown);

  /** Where a region takes focus: its selected tab, the canvas, its named collection, else its first control. */
  function entry(region) {
    const tab = [...region.querySelectorAll('[role="tab"][aria-selected="true"]')].find(shown);
    if (tab) return tab;
    if (region.matches('#viewport')) return region;
    const collection = [...region.querySelectorAll(COLLECTIONS)].find(element => shown(element) && element.tabIndex >= 0);
    if (collection) return collection;
    return [...region.querySelectorAll(FOCUSABLE)].find(element => shown(element) && !element.disabled && element.tabIndex >= 0) ?? null;
  }

  /** Moves focus `step` regions on (1: F6, -1: Ctrl+F6). */
  function focusRegion(step = 1) {
    const regions = regionList();
    if (!regions.length) return false;
    const active = doc.activeElement;
    let index = regions.findIndex(region => region.contains(active));
    for (let tries = 0; tries < regions.length; tries++) {
      index = index < 0 ? (step > 0 ? 0 : regions.length - 1) : (index + step + regions.length) % regions.length;
      const target = entry(regions[index]);
      if (target) {
        target.focus({preventScroll: true});
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Keyboard move

  let move = null;
  const zone = doc.createElement('div');
  zone.className = 'ui-drop-zone shell-drag-zone shell-drop';
  zone.hidden = true;
  const zoneLabel = doc.createElement('span');
  zoneLabel.className = 'ui-drop-label';
  appendLocalized(zone, zoneLabel);

  const panelOf = element => {
    const panel = element?.closest?.('[data-panel]');
    const id = panel?.dataset.panel ?? (element?.closest?.('#animation-timeline') ? 'timeline' : null);
    return id && host.registry.has(id) ? id : null;
  };

  /** The zone's area: the floating place for `float`, else the solved rectangle of the move. */
  function areaOf(target) {
    const s = host.solution;
    if (target.kind === 'float') {
      const width = Math.min(320, s.stage.width - 32), height = Math.min(480, s.stage.height - 32);
      return {x: s.stage.x + s.stage.width - width - 24, y: s.stage.y + 56, width, height};
    }
    return previewRect(host, {panel: move.id}, target);
  }

  function preview({announce: speak = true} = {}) {
    const target = move.targets[move.index];
    const rect = move.rects[move.index] ?? (move.rects[move.index] = areaOf(target));
    if (zone.parentElement !== doc.body) appendLocalized(doc.body, zone);
    const box = (doc.getElementById('app') ?? doc.documentElement).getBoundingClientRect();
    if (rect) Object.assign(zone.style, {left: `${Math.round(rect.x + box.left)}px`, top: `${Math.round(rect.y + box.top)}px`, width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`});
    zone.dataset.target = target.kind;
    zone.hidden = !rect;
    localizedText(zoneLabel, zoneLabelKey(target));
    if (speak) announce(interfaceText(zoneLabelKey(target)));
  }

  function finish(commit) {
    if (!move) return;
    const {id, targets, index, restore} = move;
    move = null;
    zone.hidden = true;
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('pointerdown', onPointer, true);
    if (!commit) { announce(interfaceText('dockKeyboard.moveCancelled')); restore?.focus?.({preventScroll: true}); return; }
    const target = targets[index];
    if (target.kind === 'float') host.workspace.float(id);
    else host.workspace.move(id, target);
    announce(interfaceText('dockKeyboard.panelLocation', {title: panelName(id), place: {messageKey: zoneLabelKey(target)}}));
    host.showPanel(id);
  }

  function onKey(event) {
    if (!move) return;
    const step = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1}[event.key];
    if (step) move.index = (move.index + step + move.targets.length) % move.targets.length;
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      finish(false);
      return;
    } else {
      // Any other key belongs to the move: it never reaches the editor's shortcuts (H would pick the Hand tool).
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    preview();
  }
  const onPointer = () => finish(false);

  /** Starts moving the panel that holds focus (or `id`); false when there is none. */
  function startMove(id = panelOf(doc.activeElement)) {
    if (move) finish(false);
    if (!id || host.presentation(id) === 'unavailable') { announce(interfaceText('dockKeyboard.focusAPanelToMoveIt')); return false; }
    const targets = dockTargets(host, {panel: id}).filter(target => target.kind === 'float' || previewRect(host, {panel: id}, target));
    if (!targets.length) { announce(interfaceText('dockKeyboard.thisPanelStaysWhereItIs')); return false; }
    move = {id, targets, rects: [], index: 0, restore: doc.activeElement};
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('pointerdown', onPointer, true);
    preview({announce: false});
    announce(interfaceText('dockKeyboard.moveInstructions', {title: panelName(id), place: {messageKey: zoneLabelKey(targets[0])}}));
    return true;
  }

  return {
    focusRegion,
    startMove,
    cancelMove: () => finish(false),
    get moving() { return move ? {id: move.id, target: move.targets[move.index]} : null; },
    destroy() { finish(false); zone.remove(); },
  };
}
