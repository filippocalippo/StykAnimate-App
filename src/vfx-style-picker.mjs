/**
 * The visual picker of a look or a style (a particle's look, an aura's, a beam's, smoke's or an explosion's style):
 * a popover of tiles, each a still of that option drawn by the engine (vfx-preset-preview.mjs, `style` mode) with its
 * name, opened from the option's field in the open effect. Choosing a tile is one edit through the panel
 * (VfxInspector.choose, which brings a style's suggested colours with it). Retired options are offered only to the
 * effect that already uses one. Arrow keys move between tiles, Enter or a click chooses, Escape closes.
 */
import {t as interfaceText} from './localization.mjs';
import {messageAttributes, appendLocalized} from './localization-bindings.mjs';
import {VFX_REGISTRY, resolvedVfx, vfxDescriptor} from './vfx.mjs';
import {effectMessages} from './vfx-localization.mjs';
import {vfxIcon} from './vfx-icons.mjs';
import {cachedEffectPreview, requestEffectPreview} from './vfx-preset-preview.mjs';
import {optionLabel, optionRetired, labelKey} from './vfx-presentation.mjs';
import {nextRovingIndex} from './ui/roving-focus.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** Opens the picker for binding `b` (a choice of an effect) under `anchor`; returns a function that closes it. */
export function openStylePicker(host, b, anchor) {
  host.closePopup();
  const d = vfxDescriptor(b.property), type = d.effectType, param = d.param, descriptor = VFX_REGISTRY[type].params[param];
  const effect = resolvedVfx(host.bindingEffects(b).find(e => e.id === b.id)), value = effect.params[param];
  const optionKeys = effectMessages[type]?.params?.[param]?.optionKeys;
  const indexes = descriptor.options.map((_, i) => i).filter(i => !optionRetired(descriptor, i) || i === value);
  const nameKey = labelKey(type, param), name = interfaceText(nameKey ?? '', {}) || descriptor.label;
  const popup = host.popup = document.createElement('div');
  popup.className = 'vfx-picker';
  popup.setAttribute('popover', 'auto');
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', interfaceText('vfxPanel.choose', {name}));
  const tile = i => {
    const label = interfaceText(optionKeys?.[i] ?? '', {}) || optionLabel(descriptor, i), key = `${type}:${param}:${i}`, url = cachedEffectPreview('style', key);
    return `<button type="button" class="vfx-picker-tile" role="option" aria-selected="${i === value}" tabindex="${i === value ? 0 : -1}" data-picker-value="${i}">` +
      `<span class="vfx-picker-still${url ? ' has-preview' : ''}" data-style-preview="${esc(key)}">${url ? `<img alt="" src="${url}">` : vfxIcon(VFX_REGISTRY[type].icon)}</span>` +
      `<span class="vfx-picker-name"${optionKeys?.[i] ? ` ${messageAttributes(optionKeys[i])}` : ''}>${esc(label)}</span>` +
      `${optionRetired(descriptor, i) ? `<small ${messageAttributes('vfxPanel.retired')}>${esc(interfaceText('vfxPanel.retired'))}</small>` : ''}</button>`;
  };
  popup.innerHTML = `<div class="vfx-picker-grid" role="listbox" aria-label="${esc(name)}">${indexes.map(tile).join('')}</div>`;
  appendLocalized(document.body, popup);
  popup.showPopover();
  for (const node of popup.querySelectorAll('[data-style-preview]:not(.has-preview)')) requestEffectPreview('style', node.dataset.stylePreview, url => {
    if (!node.isConnected) return;
    node.classList.add('has-preview');
    node.innerHTML = `<img alt="" src="${url}">`;
  });
  const choose = tileNode => { host.closePopup(); host.run(() => host.choose(b, Number(tileNode.dataset.pickerValue))); anchor.focus?.(); };
  popup.addEventListener('click', event => { const node = event.target.closest('[data-picker-value]'); if (node) choose(node); });
  popup.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); host.closePopup(); anchor.focus?.(); return; }
    const tiles = [...popup.querySelectorAll('[data-picker-value]')], index = tiles.indexOf(document.activeElement);
    if (event.key === 'Enter' || event.key === ' ') { if (index >= 0) { event.preventDefault(); choose(tiles[index]); } return; }
    // A grid: Up and Down move a row (its columns are counted from where the tiles sit), the others as a row of tiles.
    const columns = Math.max(1, tiles.filter(node => node.offsetTop === tiles[0].offsetTop).length);
    const next = event.key === 'ArrowDown' ? Math.min(tiles.length - 1, Math.max(0, index) + columns) : event.key === 'ArrowUp' ? Math.max(0, index - columns) : nextRovingIndex(event.key, Math.max(0, index), tiles.length, {orientation: 'horizontal'});
    if (next === null || next === index) return;
    event.preventDefault();
    tiles.forEach((node, i) => { node.tabIndex = i === next ? 0 : -1; });
    tiles[next].focus();
  });
  // Under its field, as wide as the panel, kept on screen.
  const panel = host.root.getBoundingClientRect(), from = anchor.getBoundingClientRect();
  popup.style.width = `${Math.max(240, panel.width - 16)}px`;
  const size = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(panel.left + 8, innerWidth - size.width - 8))}px`;
  popup.style.top = `${Math.max(8, from.bottom + 6 + size.height > innerHeight - 8 ? from.top - size.height - 6 : from.bottom + 6)}px`;
  (popup.querySelector('[aria-selected="true"]') ?? popup.querySelector('[data-picker-value]'))?.focus();
  return () => host.closePopup();
}
