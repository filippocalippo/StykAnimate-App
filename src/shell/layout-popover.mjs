import {localizedText, replaceLocalized, clearTranslation, translatedElement, appendLocalized, localizedAttribute} from '../localization-bindings.mjs';

import {t as interfaceText} from '../localization.mjs';

/**
 * The Layout popover (View › Layout…, Ctrl+Alt+L; docs/DOCKING.md): the
 * workspace's layouts as small maps of their arrangement (its built-in
 * layouts, then the ones saved in this workspace, the one in use checked and
 * marked when it has been changed since), every panel of the workspace with
 * whether it is open (so a closed panel is always one click from coming
 * back), Reset, Save as…, and Import… and Export…. A saved layout's card has
 * a menu (right-click, Shift+F10 or the Menu key): Rename…, Update, Delete.
 *
 * Every control runs the dock host's workspace API; the popover keeps no
 * layout state of its own and follows every solve while it is open.
 */
import {createPopover} from '../ui/ui-popover.mjs';
import {installRovingFocus} from '../ui/roving-focus.mjs';
import {STAGE} from './dock-model.mjs';
import {presetsFor} from './dock-workspaces.mjs';
import {bandBottom} from './topbar.mjs';

/**
 * The map of an arrangement: its tree as nested rows and columns, the stage
 * lighter and collapsed groups thin. Sizes are proportional, not exact.
 */
export function dockMap(doc, layout) {
  const map = doc.createElement('span');
  map.className = 'ui-dock-map';
  map.setAttribute('aria-hidden', 'true');
  const draw = (node, parentAxis) => {
    let element;
    if (node.type === 'split') {
      element = doc.createElement('b');
      element.style.flexDirection = node.axis === 'row' ? 'row' : 'column';
      for (const child of node.children) element.append(draw(child, node.axis));
    } else {
      element = doc.createElement('i');
      if (node.type === STAGE) element.dataset.stage = '';
      if (node.collapsed) element.dataset.folded = '';
    }
    const grow = node.type === STAGE || (node.type === 'split' && node.flex) ? 3 : node.collapsed ? 0.3 : node.flex ? node.flex : 1;
    element.style.flex = `${grow} 1 0`;
    if (parentAxis === null) element.style.flex = '1 1 0';
    return element;
  };
  map.append(draw(layout.root, null));
  return map;
}

/**
 * `host` is the dock host; `openMenu(items, anchor)` shows a menu;
 * `prompt(options)` asks for a name; `anchor()` returns the element the
 * popover opens under; `notify(text)` tells a person why something did not
 * happen; `isToggleKey(event)` says whether a key is the Layout… shortcut.
 */
export function createLayoutPopover({host, document: doc = globalThis.document, window: win = globalThis.window, overlays = null, icon = null, t = null, prompt, openMenu,
  anchor = () => null, notify = () => {}, isToggleKey = () => false, onError = error => globalThis.reportError?.(error)} = {}) {
  const workspace = host.workspace;
  const presets = doc.createElement('div');
  presets.className = 'shell-layout-presets';
  presets.setAttribute('role', 'radiogroup');
  localizedAttribute(presets, 'aria-label', 'layoutPopover.layoutPresets', {});
  const rows = doc.createElement('div');
  rows.className = 'shell-layout-rows';
  rows.setAttribute('role', 'group');
  localizedAttribute(rows, 'aria-label', 'layoutPopover.panels', {});
  const note = doc.createElement('p');
  note.className = 'shell-layout-note';
  note.hidden = true;
  const body = doc.createDocumentFragment();
  appendLocalized(body, presets, rows, note);

  const button = (label, variant, run) => {
    const element = doc.createElement('button');
    element.type = 'button';
    element.className = 'ui-button';
    element.dataset.variant = variant;
    element.dataset.size = 'sm';
    element.textContent = label;
    element.addEventListener('click', () => guard(run));
    return element;
  };
  const reset = translatedElement(button(interfaceText('common.reset'), 'ghost', () => workspace.resetWorkspace()), 'common.reset', {});
  localizedAttribute(reset, 'aria-label', 'layoutPopover.resetLayout', {});
  const glyph = icon?.('reset');
  if (typeof glyph === 'string') reset.insertAdjacentHTML('afterbegin', glyph);
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'ui-icon-button';
  more.dataset.size = 'sm';
  more.setAttribute('aria-haspopup', 'menu');
  localizedAttribute(more, 'aria-label', 'layoutPopover.moreLayoutActions', {});
  if (typeof icon?.('more') === 'string') more.insertAdjacentHTML('afterbegin', icon('more'));
  more.addEventListener('click', () => openMenu([
    {label: interfaceText('layoutPopover.importLayout'), labelKey: 'layoutPopover.importLayout', icon: 'import', run: () => importFile()},
    {label: interfaceText('layoutPopover.exportLayout'), labelKey: 'layoutPopover.exportLayout', icon: 'export', run: () => exportFile()},
  ], more));
  const save = translatedElement(button(interfaceText('layoutPopover.saveAsPreset'), 'outline', () => saveAs()), 'layoutPopover.saveAsPreset', {});
  const foot = doc.createDocumentFragment();
  const spacer = doc.createElement('span');
  spacer.className = 'shell-layout-spacer';
  appendLocalized(foot, reset, more, spacer, save);

  const target = {getBoundingClientRect: () => {
    const box = (anchor() ?? doc.body).getBoundingClientRect(), edge = bandBottom(doc) || box.bottom;
    return new DOMRect(box.left, box.top, box.width, Math.max(box.bottom, edge) - box.top);
  }};
  const popover = createPopover({anchor: target, title: interfaceText('layoutPopover.layout'), titleKey: 'layoutPopover.layout', closeLabel: interfaceText('layoutPopover.closeLayout'), closeLabelKey: 'layoutPopover.closeLayout', body, foot, overlays, icon, t,
    className: 'shell-layout', placement: 'bottom-start', keyboardScope: true, topInset: () => bandBottom(doc) + 6,
    onOpen: () => { render(); (presets.querySelector('[aria-checked="true"]') ?? presets.firstElementChild)?.focus({preventScroll: true}); }, onClose: () => { unsubscribe?.(); unsubscribe = null; }, document: doc});
  popover.element.id = 'layout-popover';
  popover.element.addEventListener('keydown', event => {
    if (!event.defaultPrevented && isToggleKey(event)) { event.preventDefault(); popover.hide('toggle'); }
  });
  let unsubscribe = null;
  installRovingFocus(presets, {items: () => presets.querySelectorAll('[role="radio"]'), orientation: 'horizontal'});

  function guard(run) {
    try { return run(); } catch (error) { notify(error?.message ?? String(error)); }
    return undefined;
  }

  // -------------------------------------------------------------------
  // Layouts

  const savedLayouts = () => workspace.state.saved.filter(item => item.mode === host.mode);

  function cards() {
    const current = workspace.preset, modified = workspace.modified, focus = workspace.focusMode;
    const list = presetsFor(host.mode).map(preset => ({id: preset.id, titleKey: preset.titleKey,
      layout: preset.toggle ? null : workspace.presetLayout(preset.id), focus: Boolean(preset.toggle),
      checked: preset.toggle ? focus : !focus && current === preset.id, modified: !preset.toggle && current === preset.id && modified && !focus}));
    for (const item of savedLayouts()) {
      const id = `user:${item.id}`;
      list.push({id, saved: item, title: item.name, layout: item.layout, checked: !focus && current === id, modified: current === id && modified && !focus});
    }
    return list;
  }

  function renderPresets() {
    const list = cards();
    const key = JSON.stringify(list.map(card => [card.id, card.title, card.layout ? JSON.stringify(card.layout.root) : null]));
    if (presets.dataset.key !== key) {
      presets.dataset.key = key;
      const focused = presets.contains(doc.activeElement) ? doc.activeElement.dataset.preset : null;
      replaceLocalized(presets, ...list.map(card => {
        const choice = doc.createElement('button');
        choice.type = 'button';
        choice.className = 'ui-choice';
        choice.setAttribute('role', 'radio');
        choice.dataset.preset = card.id;
        const label = doc.createElement('span');
        label.className = 'ui-choice-label';
        if (card.titleKey) localizedText(label, card.titleKey); else label.textContent = card.title;
        const map = card.layout ? dockMap(doc, card.layout) : dockMap(doc, {root: {type: 'split', axis: 'row', children: [{type: 'group', collapsed: true}, {type: STAGE}, {type: 'group', collapsed: true}]}});
        appendLocalized(choice, map, label);
        if (card.saved) { choice.setAttribute('aria-haspopup', 'menu'); choice.title = card.title; }
        return choice;
      }));
      if (focused) presets.querySelector(`[data-preset="${CSS.escape(focused)}"]`)?.focus({preventScroll: true});
    }
    let tabbable = null;
    for (const card of list) {
      const choice = presets.querySelector(`[data-preset="${CSS.escape(card.id)}"]`);
      choice.setAttribute('aria-checked', String(card.checked));
      choice.querySelector('.ui-choice-label')?.toggleAttribute('data-modified', card.modified);
      if (card.modified) localizedAttribute(choice, 'aria-description', 'layoutPopover.modified', {}); else choice.removeAttribute('aria-description');
      if (card.checked && !tabbable) tabbable = choice;
    }
    const stop = presets.contains(doc.activeElement) ? doc.activeElement : tabbable ?? presets.firstElementChild;
    for (const choice of presets.children) choice.tabIndex = choice === stop ? 0 : -1;
  }

  presets.addEventListener('click', event => {
    const choice = event.target.closest?.('[data-preset]');
    if (!choice) return;
    const id = choice.dataset.preset;
    guard(() => (id === 'focus' ? workspace.focus() : workspace.setPreset(id)));
  });
  const refocus = () => win.setTimeout(() => {
    if (popover.isOpen && !popover.element.contains(doc.activeElement)) presets.querySelector('[tabindex="0"]')?.focus({preventScroll: true});
  }, 0);
  const savedMenu = (choice, at) => {
    const item = savedLayouts().find(saved => `user:${saved.id}` === choice.dataset.preset);
    if (!item) return;
    openMenu([
      {label: interfaceText('layoutPopover.rename'), labelKey: 'layoutPopover.rename', icon: 'file', run: () => renameSaved(item)},
      {label: interfaceText('layoutPopover.update'), labelKey: 'layoutPopover.update', icon: 'save', run: () => { guard(() => workspace.updateLayout(item.id)); refocus(); }},
      null,
      {label: interfaceText('layoutPopover.delete'), labelKey: 'common.delete', icon: 'trash', danger: true, run: () => { guard(() => workspace.deleteLayout(item.id)); refocus(); }},
    ], at ?? choice);
  };
  presets.addEventListener('contextmenu', event => {
    const choice = event.target.closest?.('[data-preset^="user:"]');
    if (!choice) return;
    event.preventDefault();
    savedMenu(choice, event.button === 0 && !event.clientX ? choice : {left: event.clientX, bottom: event.clientY, invoker: choice});
  });
  presets.addEventListener('keydown', event => {
    const choice = event.target.closest?.('[data-preset^="user:"]');
    if (!choice || !((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
    event.preventDefault();
    event.stopPropagation();
    savedMenu(choice, choice);
  });

  async function renameSaved(item) {
    const name = await prompt({title: interfaceText('layoutPopover.renamePreset'), titleKey: 'layoutPopover.renamePreset', label: interfaceText('common.name'), labelKey: 'common.name', value: item.name, confirmLabel: interfaceText('layoutPopover.rename2'), confirmLabelKey: 'layoutPopover.rename2', confirmLabelParams: {}, maxLength: 48,
      validate: value => (value.trim() ? null : interfaceText('layoutPopover.nameThePresetFirst'))});
    if (typeof name === 'string') guard(() => workspace.renameLayout(item.id, name));
  }

  async function saveAs() {
    const allowed = workspace.canSaveLayout();
    if (!allowed.ok) { notify(interfaceText('dockHost.layoutLimitReached', {count: 16})); return; }
    popover.hide('replace');
    const name = await prompt({title: interfaceText('layoutPopover.saveLayoutAsPreset'), titleKey: 'layoutPopover.saveLayoutAsPreset', label: interfaceText('common.name'), labelKey: 'common.name', placeholder: interfaceText('layoutPopover.fightSetup'), placeholderKey: 'layoutPopover.fightSetup', confirmLabel: interfaceText('layoutPopover.savePreset'), confirmLabelKey: 'layoutPopover.savePreset', confirmLabelParams: {}, maxLength: 48,
      validate: value => (value.trim() ? null : interfaceText('layoutPopover.nameThePresetFirst'))});
    if (typeof name !== 'string') return;
    if (guard(() => workspace.saveLayout(name))) show();
  }

  /** Export: the arrangement as a `.stylayout` file the browser downloads (the desktop's webview saves it the same way). */
  function exportFile() {
    const value = workspace.exportLayout();
    const blob = new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'});
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${(value.name ?? interfaceText('layoutPopover.layout')).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'layout'}.stylayout`;
    link.click();
    win.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function importFile() {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.stylayout,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file || file.size > 256 * 1024) { if (file) notify(interfaceText('dockHost.layoutFileUnreadable')); return; }
      let value;
      try { value = JSON.parse(await file.text()); } catch { notify(interfaceText('dockHost.layoutFileUnreadable')); return; }
      const name = typeof value?.name === 'string' && value.name.trim() ? value.name : file.name.replace(/\.stylayout$/i, '');
      guard(() => workspace.importLayout(value, {name}));
    }, {once: true});
    input.click();
  }

  // -------------------------------------------------------------------
  // Panels: every panel of the workspace, open or closed.

  function renderRows() {
    const panels = host.registry.list({mode: host.mode});
    const key = panels.map(panel => panel.id).join(' ');
    if (rows.dataset.key !== key) {
      rows.dataset.key = key;
      replaceLocalized(rows, ...panels.map(panel => {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'ui-check shell-layout-panel';
        row.setAttribute('role', 'menuitemcheckbox');
        row.dataset.panel = panel.id;
        const label = doc.createElement('span');
        if (panel.titleKey) localizedText(label, panel.titleKey); else label.textContent = panel.title;
        appendLocalized(row, label);
        row.addEventListener('click', () => guard(() => {
          if (host.presentation(panel.id) === 'hidden') host.showPanel(panel.id, {focus: false});
          else workspace.hide(panel.id);
        }));
        return row;
      }));
    }
    for (const row of rows.children) row.setAttribute('aria-checked', String(host.presentation(row.dataset.panel) !== 'hidden'));
    const allowed = workspace.canSaveLayout();
    save.setAttribute('aria-disabled', String(!allowed.ok));
    note.hidden = allowed.ok;
    if (allowed.ok) { clearTranslation(note); note.textContent = ''; }
    else localizedText(note, 'dockHost.layoutLimitReached', {count: 16});
  }

  function render() {
    renderPresets();
    renderRows();
    unsubscribe ??= host.onSolve(() => { if (popover.isOpen) { renderPresets(); renderRows(); } });
    popover.update();
  }

  function show() {
    renderPresets();
    renderRows();
    try { popover.show(); } catch (error) { onError(error); }
  }

  return {
    element: popover.element,
    show,
    hide: () => popover.hide('hide'),
    toggle: () => (popover.isOpen ? popover.hide('toggle') : show()),
    get isOpen() { return popover.isOpen; },
  };
}
