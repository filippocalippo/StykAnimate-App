/**
 * The effects catalogue's preview card: what an effect or a preset does, before it is added. Hovering a card for a
 * moment, or moving to it with the keyboard, shows a still of it on a figure (drawn by the engine,
 * vfx-preset-preview.mjs), its name, one line on what it does and, for a preset, what it holds and whether it is a
 * moment or a lasting look. The card sits beside the catalogue, never over the list a person is reading, and is
 * gone when the pointer or the focus leaves. It is a manual popover, so it never closes the catalogue.
 */
import {t as interfaceText} from './localization.mjs';
import {appendLocalized} from './localization-bindings.mjs';
import {VFX_REGISTRY} from './vfx-registry.mjs';
import {VFX_PRESETS} from './vfx-presets.mjs';
import {effectMessages, presetMessages} from './vfx-localization.mjs';
import {vfxIcon} from './vfx-icons.mjs';
import {canPreview, cachedEffectPreview, requestEffectPreview} from './vfx-preset-preview.mjs';
import {isMoment, presetTiming} from './vfx-presentation.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const HOVER_MS = 220;

/** What a catalogue entry is, in words: {name, about, meta}. */
export function describeEntry(mode, key) {
  if (mode === 'presets' && VFX_PRESETS[key]) {
    const preset = VFX_PRESETS[key], timing = presetTiming(key, preset);
    const effects = preset.effects.map(([type]) => ({messageKey: effectMessages[type]?.nameKey}));
    return {
      name: interfaceText(presetMessages[key]?.nameKey ?? key),
      about: interfaceText('vfxPanel.presetHolds', {effects: {format: 'list', value: effects, options: {type: 'conjunction'}}}),
      meta: isMoment(key, preset) ? (timing ? interfaceText('vfxPanel.catalog.momentFrames', {count: timing.duration}) : interfaceText('vfxPanel.catalog.moment')) : interfaceText('vfxPanel.catalog.lookEffects', {count: preset.effects.length}),
    };
  }
  if (!VFX_REGISTRY[key]) return null;
  return {name: interfaceText(effectMessages[key]?.nameKey ?? key), about: interfaceText(`vfxPanel.about.${key}`), meta: ''};
}

/** Wires the preview card to an open catalogue `popup`; returns a function that removes it. */
export function attachCatalogPeek(popup, mode) {
  const doc = popup.ownerDocument, peek = doc.createElement('div');
  peek.className = 'vfx-peek';
  peek.setAttribute('popover', 'manual');
  peek.setAttribute('aria-hidden', 'true');
  appendLocalized(doc.body, peek);
  let timer = 0, shown = null;
  const hide = () => { clearTimeout(timer); shown = null; if (peek.matches(':popover-open')) peek.hidePopover(); };
  const place = card => {
    const box = popup.getBoundingClientRect(), row = card.getBoundingClientRect(), size = peek.getBoundingClientRect(), view = doc.defaultView;
    // Beside the catalogue: to its left when there is room (the panel is usually at the window's right), else to its right.
    const left = box.left - size.width - 8 >= 8 ? box.left - size.width - 8 : Math.min(view.innerWidth - size.width - 8, box.right + 8);
    peek.style.left = `${Math.max(8, left)}px`;
    peek.style.top = `${Math.max(8, Math.min(view.innerHeight - size.height - 8, row.top + row.height / 2 - size.height / 2))}px`;
  };
  const show = card => {
    const key = card.dataset.choice, entry = !key?.startsWith('mine:') && describeEntry(mode, key);
    if (!entry) { hide(); return; }
    shown = card;
    const url = canPreview(mode, key) ? cachedEffectPreview(mode, key) : null, glyph = mode === 'presets' ? VFX_PRESETS[key]?.icon : VFX_REGISTRY[key]?.icon;
    peek.innerHTML = `<span class="vfx-peek-still${url ? ' has-preview' : ''}">${url ? `<img alt="" src="${url}">` : vfxIcon(glyph ?? 'effects')}</span>` +
      `<span class="vfx-peek-text"><strong>${esc(entry.name)}</strong><span>${esc(entry.about)}</span>${entry.meta ? `<small>${esc(entry.meta)}</small>` : ''}</span>`;
    if (!peek.matches(':popover-open')) peek.showPopover();
    place(card);
    if (!url && canPreview(mode, key)) requestEffectPreview(mode, key, done => {
      if (shown !== card) return;
      const still = peek.querySelector('.vfx-peek-still');
      if (still) { still.classList.add('has-preview'); still.innerHTML = `<img alt="" src="${done}">`; }
    });
  };
  const soon = card => { clearTimeout(timer); if (card === shown) return; timer = setTimeout(() => show(card), shown ? 60 : HOVER_MS); };
  const events = new AbortController(), {signal} = events;
  popup.addEventListener('pointerover', event => { const card = event.target.closest?.('.vfx-catalog-card[data-choice]'); if (card && !card.disabled) soon(card); }, {signal});
  popup.addEventListener('pointerleave', hide, {signal});
  popup.addEventListener('focusin', event => { const card = event.target.closest?.('.vfx-catalog-card[data-choice]'); if (card) soon(card); else hide(); }, {signal});
  // A scroll moves the cards under a still pointer, so the card goes; but keyboard focus that scrolls its card into view
  // keeps it (or its pending card), placed beside the card again.
  popup.addEventListener('scroll', () => {
    const card = doc.activeElement?.closest?.('.vfx-catalog-card[data-choice]'), box = popup.getBoundingClientRect(), at = card?.getBoundingClientRect();
    if (card && popup.contains(card) && at.bottom > box.top && at.top < box.bottom) { if (shown === card) place(card); return; }
    hide();
  }, {signal, passive: true});
  popup.addEventListener('toggle', event => { if (event.newState === 'closed') { events.abort(); hide(); peek.remove(); } }, {signal});
  return () => { events.abort(); hide(); peek.remove(); };
}
