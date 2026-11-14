/**
 * One open effect in the VFX panel (docs/VFX-DESIGN.md, "The open effect"): its notice, the few values that define
 * it, then its titled sections, each value drawn by the shared value control (src/inspector-kit.mjs,
 * src/property-controls.mjs) as src/vfx-presentation.mjs says. Effect clips and the per-pose effects of older
 * projects use the same view; a clip's values carry their key at the field's end.
 *
 * Each value registers its binding on the host (`host.bindings`, keyed `${owner}-${effect}-${param}`), the address
 * VfxInspector's PropertyControls, change and click handlers edit through. Pure markup otherwise: nothing here
 * edits the document.
 */
import {renderRow, escapeHTML} from './inspector-kit.mjs';
import {t as interfaceText} from './localization.mjs';
import {messageAttributes} from './localization-bindings.mjs';
import {VFX_REGISTRY, vfxProperty} from './vfx.mjs';
import {effectMessages} from './vfx-localization.mjs';
import {clipTime} from './vfx-clips.mjs';
import {vfxPaint} from './vfx-paint.mjs';
import {paintCSS} from './paint.mjs';
import {icon} from './icons.mjs';
import {vfxIcon} from './vfx-icons.mjs';
/** The kit draws app glyphs; a seed's shuffle is the effects' own dice. */
const ENV = {icon: (name, className) => (name === 'dice' ? vfxIcon('dice') : icon(name, className))};
import {findFigureType} from './figure-types.mjs';
import {presentEffect, labelKey, helpKey, sectionKey, optionLabel, optionRetired, PRESENTATION} from './vfx-presentation.mjs';

/** The key of a clip's keys at or before `tick` (binary search over the sorted ticks). */
export const keyIndex = (clip, keys, tick) => { let low = 0, high = keys.length - 1; const time = clipTime(clip, tick); while (low < high) { const mid = (low + high + 1) >>> 1; if (keys[mid].tick <= time) low = mid; else high = mid - 1; } return low; };
export const currentKey = (clip, keys, tick) => keys[keyIndex(clip, keys, tick)];
/** Whether a clip has a key of `property` exactly at `tick`. */
export const keyAt = (clip, property, tick) => { const keys = clip?.keys?.[property] ?? []; return keys.length > 0 && currentKey(clip, keys, tick)?.tick === Math.floor(clipTime(clip, tick)); };

/** Which titled sections a person left open, per effect type, for the session (a section's title row toggles it). */
const openSections = new Map();
export const sectionOpen = (type, id) => openSections.get(`${type}:${id}`) === true;
export function rememberSection(type, id, open) { if (open) openSections.set(`${type}:${id}`, true); else openSections.delete(`${type}:${id}`); }

const text = (key, fallback = '', params) => (key ? interfaceText(key, params) : fallback);
/** Units as a person reads them; the value's own suffix follows it. */
const UNIT = {'/f': '/f'};
const decimals = step => (step >= 1 || !(step > 0) ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));

/** Shadow distance and angle: views of the saved offsets, never stored. */
export function derivedValue(name, params) {
  return name === 'angle' ? Math.atan2(params.offsetY, params.offsetX) * 180 / Math.PI : Math.hypot(params.offsetX, params.offsetY);
}
/** The offsets that give `value` for the derived view `name`, the other view held. */
export function derivedOffsets(name, value, params) {
  const angle = name === 'angle' ? value * Math.PI / 180 : Math.atan2(params.offsetY, params.offsetX), distance = name === 'distance' ? value : Math.hypot(params.offsetX, params.offsetY);
  const clamp = v => Math.max(-256, Math.min(256, v));
  return {offsetX: clamp(Math.cos(angle) * distance), offsetY: clamp(Math.sin(angle) * distance)};
}

/**
 * The open effect's values and sections. `ctx`: {target, effect (resolved), clip (the clip record, for keys) or null
 * for a per-pose effect, ownerIndex, locked, group (a member of a group), notices ([{key, params, tone}])}.
 */
export function effectSettingsHTML(host, ctx) {
  const {effect} = ctx, scene = ctx.target?.kind === 'scene';
  const view = presentEffect(effect.type, effect.params, {scene, group: ctx.group});
  const notices = (ctx.notices ?? []).map(notice => `<p class="vfx-notice" data-tone="${notice.tone ?? 'info'}" role="status">${icon(notice.tone === 'warning' ? 'warning' : 'alert', 'ui-icon')}<span ${messageAttributes(notice.key, notice.params ?? {})}>${escapeHTML(interfaceText(notice.key, notice.params ?? {}))}</span></p>`).join('');
  const primary = view.primary.map(item => itemHTML(host, ctx, item)).join('');
  const sections = view.sections.map(section => sectionHTML(host, ctx, section)).join('');
  return `${notices}<div class="vfx-fields">${primary}</div>${sections}`;
}

/** A titled section: one line that opens in place, with a quiet dot when a value inside is animated. */
function sectionHTML(host, ctx, section) {
  const {effect} = ctx, open = sectionOpen(effect.type, section.id);
  const animated = ctx.clip && section.items.some(item => (item.kind === 'pair' ? item.params : item.kind === 'derived' ? item.params : [item.param]).some(param => param && ctx.clip.keys[vfxProperty(effect.type, effect.id, param)]?.length));
  const title = section.id === 'more' ? 'vfxPanel.section.more' : sectionKey(section.id);
  return `<details class="vfx-section" data-section="vfx-section-${ctx.ownerIndex}-${effect.id}-${section.id}" data-vfx-section="${section.id}" data-vfx-type="${effect.type}"${open ? ' open' : ''}>` +
    `<summary><span class="vfx-section-title" ${messageAttributes(title)}>${escapeHTML(interfaceText(title))}</span>${animated ? '<span class="vfx-section-dot" aria-hidden="true"></span>' : ''}${icon('chevron-right', 'vfx-section-chevron')}</summary>` +
    `<div class="vfx-fields">${section.items.map(item => itemHTML(host, ctx, item)).join('')}</div></details>`;
}

function itemHTML(host, ctx, item) {
  if (item.kind === 'aim') return aimHTML(host, ctx);
  if (item.kind === 'pair') return pairHTML(host, ctx, item);
  if (item.kind === 'derived') return derivedHTML(host, ctx, item);
  return paramHTML(host, ctx, item);
}

/** What a value is called, its accessible name ("Glow Radius") and its one-line help. */
function names(type, param, fallback) {
  const key = labelKey(type, param), label = text(key, fallback), help = helpKey(type, param), nameKey = effectMessages[type]?.nameKey;
  return {
    label, labelKey: key ?? undefined,
    description: `${text(nameKey, VFX_REGISTRY[type]?.name)} ${label}`,
    descriptionKey: nameKey && key ? 'vfxInspector.effectParameterLabel' : undefined,
    descriptionParams: nameKey && key ? {effect: {messageKey: nameKey}, parameter: {messageKey: key}} : undefined,
    help: help ? interfaceText(help) : undefined, helpKey: help ?? undefined,
    tip: help ? interfaceText(help) : undefined, tipKey: help ?? undefined,
  };
}

/** The key at a clip value's end: quiet until hovered, an outline once animated, filled on a key at this frame. */
function keyButton(host, ctx, key, properties, label, labelMessage) {
  if (!ctx.clip) return null;
  const animated = properties.some(property => ctx.clip.keys[property]?.length), on = properties.some(property => keyAt(ctx.clip, property, host.editor.tick));
  const action = on ? 'vfxClipInspector.removeKey' : 'vfxClipInspector.addKey', verb = on ? 'vfxClipInspector.remove' : 'vfxClipInspector.add';
  // "Add Radius key": the verb, the value's name, and what it makes.
  return {label: interfaceText('vfxClipInspector.key', {value: {messageKey: verb}, label: labelMessage ?? label}), labelKey: 'vfxClipInspector.key', labelParams: {value: {messageKey: verb}, label: labelMessage ?? label},
    icon: 'diamond', tip: interfaceText(action), tipKey: action, className: `vfx-key${animated ? ' is-animated' : ''}${on ? ' is-keyed' : ''}`,
    data: {'clip-key': key}, disabled: ctx.locked};
}

/** The binding a value edits through: its address, the factor between saved and shown values, and its clip. */
function bind(host, ctx, param, extra = {}) {
  const {effect} = ctx, key = `${ctx.ownerIndex}-${effect.id}-${extra.derived ?? param}`;
  const binding = {target: ctx.target, id: effect.id, param: extra.derived ?? param, property: vfxProperty(effect.type, effect.id, param), factor: extra.factor ?? 1, derived: extra.derived ?? false, clip: ctx.clip?.id ?? null, pose: !ctx.clip, ...extra.binding};
  host.bindings.set(key, binding);
  return {key, binding};
}

function paramHTML(host, ctx, item) {
  const {effect} = ctx, {param, d, control} = item, value = effect.params[param];
  // A share (0 to 1) and a share a frame read in percent.
  const unit = item.unit ?? d.unit ?? '', factor = unit === '%' || unit === '%/f' ? 100 : 1;
  const {key, binding} = bind(host, ctx, param, {factor});
  const n = names(effect.type, param, d.label), disabled = ctx.locked;
  const trail = [keyButton(host, ctx, key, [binding.property], n.label, n.labelKey ? {messageKey: n.labelKey} : undefined)];
  let row;
  if (control === 'color') {
    const paint = vfxPaint(value), solid = paint.type === 'solid', stop = paint.stops[0], hex = `#${stop.color.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const caption = solid ? `${hex.slice(1).toUpperCase()}${stop.opacity < 1 ? ` · ${Math.round(stop.opacity * 100)}%` : ''}` : interfaceText('vfxInspector.gradient');
    row = {kind: 'color', picker: 'paint', owned: true, showLabel: true, ...n, value: hex, paint: solid ? undefined : paintCSS(paint), caption, captionKey: solid ? undefined : 'vfxInspector.gradient', data: {'vfx-paint': key}, disabled};
  } else if (control === 'switch') {
    row = {kind: 'field-switch', ...n, id: `vfx-field-${key}`, checked: Boolean(value), data: {'vfx-toggle': key}, disabled};
  } else if (control === 'segments' || control === 'menu' || control === 'picker') {
    const count = d.options ? d.options.length : Math.round((d.max - d.min) / (d.step || 1)) + 1;
    const indexes = [...Array(count).keys()].filter(i => !optionRetired(d, i) || i === value);
    const optionKeys = effectMessages[effect.type]?.params?.[param]?.optionKeys;
    const option = i => {
      const label = d.options ? text(optionKeys?.[i], optionLabel(d, i)) : String(d.min + i * (d.step || 1));
      return optionRetired(d, i) ? {label: interfaceText('vfxPanel.retiredOption', {name: label}), labelKey: 'vfxPanel.retiredOption', labelParams: {name: optionKeys?.[i] ? {messageKey: optionKeys[i]} : label}} : {label, labelKey: d.options ? optionKeys?.[i] : undefined};
    };
    const valueOf = i => (d.options ? i : d.min + i * (d.step || 1));
    // Segments only while their words are short in the person's language; longer words get a menu, never cut words.
    const words = indexes.map(i => option(i).label), short = words.reduce((n, word) => n + word.length, 0) <= 18 && words.every(word => word.length <= 10);
    if (control === 'segments' && indexes.length <= 4 && short) row = {kind: 'segmented', field: true, mode: 'pressed', ...n, value, data: {'vfx-segments': key},
      options: indexes.map(i => ({value: valueOf(i), ...option(i), data: {'vfx-option': valueOf(i)}})), disabled};
    else if (control === 'picker') {
      const current = option(value);
      row = {kind: 'picker', ...n, text: current.label, textKey: current.labelKey, art: host.pickerArt?.(effect.type, param, value) ?? '', data: {'vfx-picker': key}, disabled};
    } else row = {kind: 'select', ...n, id: `vfx-field-${key}`, value, data: {'vfx-choice': key}, options: indexes.map(i => ({value: valueOf(i), ...option(i)})), disabled};
    if (row.kind === 'select') return valueWrap(host, key, binding, choiceHTML({...row, trail}, ENV));
  } else {
    // A number: a slider field for a bounded value, an angle's dial, or a typed and scrubbed number.
    const step = (d.step || 1) * factor, places = decimals(step);
    row = {kind: 'number', ...n, key, id: `vfx-field-${key}`, value: value * factor, min: d.min * factor, max: d.max * factor, step, unit: UNIT[unit] ?? unit,
      precision: d.discrete ? 0 : places + 2, displayPrecision: d.discrete ? 0 : places, default: d.default * factor, field: false,
      range: control === 'value', angle: control === 'angle', scrubAnywhere: true, scale: item.scale, knee: item.knee, exponent: item.exponent, disabled};
    // Every seed draws a new pattern with the same settings (VfxInspector's shuffle).
    if (param === 'seed') trail.push({label: interfaceText('vfxPanel.shuffleTip'), labelKey: 'vfxPanel.shuffleTip', icon: 'dice', className: 'vfx-shuffle', data: {'vfx-shuffle': key}, disabled});
  }
  return valueWrap(host, key, binding, renderRow({...row, trail}, ENV));
}

/** A choice's option this long (in characters, in the person's language) no longer fits a native menu on a narrow panel. */
const LONG_CHOICE = 16;
/**
 * A choice: the kit's select, or, when one of its options is long in the person's language, a field whose words wrap
 * and which opens a menu of the options (VfxInspector.openChoiceMenu). The select stays in the page, hidden, and the
 * menu sets it, so a change takes the select's own path whichever control made it.
 */
export function choiceHTML(row, env) {
  if (!row.options.some(option => String(option.label ?? '').length > LONG_CHOICE)) return renderRow(row, env);
  const {trail, ...select} = row, current = row.options.find(option => String(option.value) === String(row.value)) ?? row.options[0];
  const button = renderRow({kind: 'picker', label: row.label, labelKey: row.labelKey, labelParams: row.labelParams, description: row.description, descriptionKey: row.descriptionKey,
    tip: row.tip, tipKey: row.tipKey, bare: row.bare, id: `${row.id}-menu`, text: current?.label ?? '', textKey: current?.labelKey, textParams: current?.labelParams, art: '', popup: 'menu',
    data: {'vfx-menu-for': row.id}, disabled: row.disabled, trail}, env);
  return `${button}<div hidden>${renderRow(select, env)}</div>`;
}

/** Shadow distance and angle: one control each that writes both offsets. */
function derivedHTML(host, ctx, item) {
  const {effect} = ctx, {key, binding} = bind(host, ctx, item.params[0], {derived: item.name, binding: {properties: item.params.map(param => vfxProperty(effect.type, effect.id, param))}});
  const n = names(effect.type, item.name, interfaceText(item.name === 'angle' ? 'vfxInspector.angle' : 'vfxInspector.distance'));
  const row = {kind: 'number', ...n, key, id: `vfx-field-${key}`, value: derivedValue(item.name, effect.params), min: item.min, max: item.max, step: item.step, unit: item.unit,
    precision: 2, displayPrecision: 0, default: item.default, field: false, range: item.control !== 'angle', angle: item.control === 'angle', scrubAnywhere: true, scale: item.name === 'distance' ? 'pow' : undefined, disabled: ctx.locked};
  return valueWrap(host, key, binding, renderRow({...row, trail: [keyButton(host, ctx, key, binding.properties, n.label, n.labelKey ? {messageKey: n.labelKey} : undefined)]}));
}

/** Two values side by side (a centre, a grid offset, a cell size with its link). */
function pairHTML(host, ctx, item) {
  const {effect} = ctx, linked = item.link ? Boolean(effect.params[item.link]) : false;
  const members = item.items.map((member, index) => {
    const html = paramHTML(host, ctx, member);
    // While linked, the first value edits both and takes the pair's name.
    if (linked && index === 0) return html.replace(/(<span class="ui-field-label"[^>]*>)[^<]*(<\/span>)/, `$1${escapeHTML(text(labelKey(effect.type, item.name), member.d.label))}$2`);
    return html;
  });
  const pairName = text(labelKey(effect.type, item.name), item.name);
  let link = '';
  if (item.link) {
    const {key} = bind(host, ctx, item.link);
    link = `<button type="button" class="ui-icon-button ui-field-link" data-size="xs" data-vfx-link="${escapeHTML(key)}" aria-pressed="${linked}" aria-label="${escapeHTML(interfaceText('vfxPanel.linkTip'))}" data-tooltip="${escapeHTML(interfaceText('vfxPanel.linkTip'))}" ${messageAttributes('vfxPanel.linkTip', {}, 'aria-label')} ${messageAttributes('vfxPanel.linkTip', {}, 'data-tooltip')}${ctx.locked ? ' disabled' : ''}>${icon(linked ? 'link' : 'detach')}</button>`;
  }
  const shown = linked ? members.slice(0, 1) : members;
  return `<div class="ui-field-pair vfx-pair"${shown.length === 1 ? ' data-single' : ''} role="group" aria-label="${escapeHTML(pairName)}">${shown[0]}${shown[1] ?? ''}${link}</div>`;
}

/** A beam's target: a node or figure locked on the stage, or a point (its X and Y below). */
function aimHTML(host, ctx) {
  const e = host.editor, {effect} = ctx, p = effect.params, clip = ctx.clip;
  if (!clip) return '';
  const picking = e._vfxAimPick?.clip === clip.id && e._vfxAimPick.effect === effect.id;
  let aim = {messageKey: 'vfxClipInspector.pointOnStage'};
  if (p.aimUid) {
    const object = e.evaluatedFrame?.objects.find(o => o.unique_id === p.aimUid), figure = object && findFigureType(e.report.figure_types, object.figure_type_id);
    aim = {messageKey: 'vfxChannels.aimTarget', messageParams: {figure: figure?.name || {messageKey: 'vfxChannels.figure', messageParams: {id: p.aimUid}}, node: p.aimHandle ? {messageKey: 'vfxChannels.node', messageParams: {id: p.aimHandle}} : {messageKey: 'vfxChannels.origin'}}};
  }
  const label = interfaceText(aim.messageKey, aim.messageParams), locked = ctx.locked ? ' disabled' : '';
  const field = `<div class="ui-field vfx-aim" data-aim><span class="ui-field-label" ${messageAttributes('vfxClipInspector.aimAt')}>${escapeHTML(interfaceText('vfxClipInspector.aimAt'))}</span><span class="vfx-aim-target" data-tooltip="${escapeHTML(label)}" ${messageAttributes(aim.messageKey, aim.messageParams)} ${messageAttributes(aim.messageKey, aim.messageParams, 'data-tooltip')}>${escapeHTML(label)}</span>` +
    `${p.aimUid ? `<button type="button" class="ui-icon-button" data-size="xs" data-clip-action="aim-clear" data-effect-id="${effect.id}" aria-label="${escapeHTML(interfaceText('vfxClipInspector.aimAtAStagePointInstead'))}" ${messageAttributes('vfxClipInspector.aimAtAStagePointInstead', {}, 'aria-label')}${locked}>${icon('close')}</button>` : ''}` +
    `<button type="button" class="ui-button vfx-aim-pick" data-size="xs" data-variant="${picking ? 'accent' : 'ghost'}" data-clip-action="aim-pick" data-effect-id="${effect.id}" aria-pressed="${picking}" data-tooltip="${escapeHTML(interfaceText('vfxClipInspector.clickANodeAFigureOriginOrAny'))}" ${messageAttributes('vfxClipInspector.clickANodeAFigureOriginOrAny', {}, 'data-tooltip')}${locked}><span class="ui-label" ${messageAttributes(picking ? 'vfxClipInspector.clickTheStage' : 'vfxClipInspector.pick')}>${escapeHTML(interfaceText(picking ? 'vfxClipInspector.clickTheStage' : 'vfxClipInspector.pick'))}</span></button></div>`;
  // Unlocked, the stage point is two values; locked onto a node they wait (they still hold the point to come back to).
  const point = p.aimUid ? '' : pairHTML(host, ctx, {name: 'aim', params: ['aimX', 'aimY'], link: null, items: ['aimX', 'aimY'].map(param => ({kind: 'param', param, d: VFX_REGISTRY.beam.params[param], control: 'value'}))});
  return field + point;
}

/** A value's wrapper: the binding it edits (a click selects its key channel) and whether its channel is the selected one. */
function valueWrap(host, key, binding, html) {
  const selected = host.selectedChannel && host.selectedChannel === binding.property;
  return `<div class="vfx-value${selected ? ' is-channel-selected' : ''}" data-vfx-binding="${escapeHTML(key)}">${html}</div>`;
}

/** Which values an effect type's presentation names (for tests and the catalogue's preview). */
export const presentationOf = type => PRESENTATION[type] ?? null;
