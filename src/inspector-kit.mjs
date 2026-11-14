import {messageAttributes, descriptorAttributes, tupleMessages} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';

import { messageText } from './localization.mjs';
/**
 * The inspector kit: a context describes its inspector as data (sections of
 * rows) and the kit renders it to an HTML string with the .ui-* classes
 * (components.md §3-4, architecture.md §3.13). The string goes through
 * updateInspectorDOM() exactly as inspector-view.mjs's does today, so the kit
 * keeps its reconciliation contract: every control carries its identity (id,
 * data-property, data-section, data-polygon-index, data-inspector-owned),
 * number fields carry the PropertyControls hooks (data-property-row,
 * data-property-scrub, data-property-value, -precision, -display-precision,
 * -step, plus the legacy data-field) and imperative widgets live in
 * data-inspector-owned hosts. PropertyControls owns scrubbing (Shift ×0.1,
 * Alt ×0.01), typing, arrow-key steps and Escape rollback; the kit only emits
 * the markup it reads.
 *
 * The inspector never shows key state: no diamonds, no data-property-key,
 * data-property-nav or key controls.
 *
 * Stable positions. updateInspectorDOM() matches children by position, so a
 * node that appears before others would shift them and replace every one
 * (dropping focus, detaching owned hosts). The kit never drops a slot: a
 * `hidden` or falsy section renders an empty <section data-section hidden>, a
 * hidden or falsy row an empty <div hidden>, and the scope slot is always
 * there (empty and hidden while no edit reaches beyond the selection). Write
 * conditional content as `hidden: !condition` (or `condition && row`), never
 * by filtering the list.
 *
 * Tooltips. The one tooltip (src/ui/ui-tooltip.mjs) reads data-tooltip, then
 * aria-label. A descriptor's `tip` renders as data-tooltip; an icon button
 * needs nothing more (its aria-label feeds the tooltip). The kit writes no
 * `title`, which would show a second, native tooltip; `legacyTitle: true`
 * keeps today's title on a control whose browser tests still read it
 * (join-figure, until the M2 test migration, architecture.md §3.6).
 *
 * Values (a documented deviation from revision 4 for M4). Number fields stay
 * <input type=number>: PropertyControls reads valueAsNumber, so revision 4's
 * expressions (+10, *2) and a unit inside the value wait for a text input and
 * a parser in PropertyControls. Until then the unit follows the value as a
 * suffix. A Mixed value (several figures) renders empty with a "Mixed"
 * placeholder and data-mixed holding the model value PropertyControls edits
 * from; installInspectorKit() restores the empty value when a person leaves
 * the field without changing it.
 *
 * Descriptors
 *   inspector  {kind, sections, scope, quick, footer}
 *   section    {id, title, place: 'core' | 'titled', open: boolean | (ctx) => boolean,
 *               actions: [button] (at most two, a title switch included),
 *               switch: {id, label, checked, disabled, controls, tip, data} (titled only),
 *               rows: [row], hidden, data}
 *   row        {kind, hidden, ...}: number, stepper-field, stepper, slider, select,
 *               switch, field-switch, checkbox, color, swatch, swatches,
 *               segmented, text, actions, list-row, pager, preview, owned,
 *               markup (a sub-module's HTML until its milestone), meta,
 *               value, grid, group
 *   button     {action, command, shiftAction, icon, label, text, variant, size,
 *               id, tip, legacyTitle, disabled, pressed, expanded, tabindex, data, attrs}
 *
 * Core sections are always open. Titled sections fold behind their title and
 * open when their auto-open rule says their content matters now, or when the
 * person opened them before in this kind of context (SectionMemory, persisted
 * by the owner as the inspectorSections setting).
 *
 * Where things render. renderInspector() writes the sections, the only
 * content of #inspector. The scope line and the quick actions row belong to
 * the inspector header (inspector-header.mjs, renderInspectorHead()), and the
 * foot (renderFooter()) to a host pinned under the scrolling body, so neither
 * scrolls out of view; `{head: true, foot: true}` puts them in the same
 * string for a host that has nowhere else. syncQuickHost() keeps a
 * quick-actions controller bound to the rendered row. installInspectorKit()
 * is the thin DOM half: section toggles, step buttons, slider readouts,
 * Mixed values, collections, the "more below" fade and the one-time scrub hint.
 *
 * Sub-modules that still build HTML enter as `markup` rows, or as a `bare`
 * section that keeps their own edge-to-edge markup, until they move to
 * descriptors.
 *
 * Pure and DOM-free at import; strings come from locales/en-inspector.mjs
 * with an optional env.t(key, params) translator.
 */
import {icon as appIcon} from './icons.mjs';
import {formatPropertyValue} from './property-controls.mjs';
import {positionPercent, valueToPosition} from './ui/value-scale.mjs';
import {createQuickActions} from './ui/quick-actions.mjs';
import {nextRovingIndex} from './ui/roving-focus.mjs';
import TEXT from './locales/en-inspector.mjs';

export const MAX_TITLE_ACTIONS = 2;
export const SECTION_PLACES = Object.freeze(['core', 'titled']);
/**
 * The audit's inspector budget at rest (architecture.md §3.13, revision 4.1 with headroom). Core sections are two to
 * three per context, four where revision 4.1 adds a line of its own: the joint's Figure (its Layer) and several
 * figures' Arrange (their Layer and one-step order).
 */
export const INSPECTOR_BUDGET = Object.freeze({controls: 30, openSections: 5, titledSections: 8, coreSections: 4});

/** The one-time hint the message slot shows when a person first focuses a scrub-able field (English; installInspectorKit translates it). */
export const SCRUB_HINT = TEXT['inspector.scrubHint'];

function say(env, key, params = {}) { return messageText(env?.t, key, params); }

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
/** Text and attribute values are always escaped; the kit never interpolates raw markup except `html` on owned hosts and markup rows. */
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character]);

// Attributes a descriptor may add to a control through `attrs` and `data`.
// Event handler attributes and style never pass: inline style is limited to
// the custom properties the kit writes itself (--swatch, --_p, --level).
const ATTRIBUTE_NAME = /^(?:data-[a-z][a-z0-9-]*|aria-[a-z]+|role|title|tabindex|name|maxlength|minlength|placeholder|autocomplete|spellcheck|inputmode|pattern|for|form|accept|multiple|size|required)$/;
const DATA_NAME = /^[a-z][a-z0-9-]*$/;
const ID = /^[A-Za-z][\w:.-]*$/;
const SECTION_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** ` name="value"` pairs in insertion order: true renders a bare attribute, false/null/undefined skip it. */
export function attributes(pairs) {
  let html = '';
  for (const [name, value] of Object.entries(pairs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    html += value === true ? ` ${name}` : ` ${name}="${escapeHTML(value)}"`;
  }
  return html;
}
/** A descriptor's extra `data` ({'draw-setting': 'blend'} → data-draw-setting) and `attrs`, validated. */
function extras(item) {
  const pairs = {};
  for (const [name, value] of Object.entries(item?.data ?? {})) {
    if (!DATA_NAME.test(name)) throw messageError(new TypeError(''), "errors.inspectorKit.invalidDataAttribute", {name: name});
    pairs[`data-${name}`] = value;
  }
  for (const [name, value] of Object.entries(item?.attrs ?? {})) {
    if (!ATTRIBUTE_NAME.test(name)) throw messageError(new TypeError(''), "errors.inspectorKit.attributeIsNotAllowedInInspectorDescriptors", {name: name});
    pairs[name] = value;
  }
  return pairs;
}
const id = value => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!ID.test(String(value))) throw messageError(new TypeError(''), "errors.inspectorKit.invalidControlId", {value: value});
  return String(value);
};
const finite = value => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));
const span = row => (row.span === 2 ? ' ui-span-2' : '');
const glyph = (env, name, cls) => (env?.icon ?? appIcon)(name, cls);

/**
 * Each section's kind badge: its glyph and the tint that names its kind, so a
 * panel reads at a glance (visual-system.md, sections): blue geometry, orange
 * looks, violet time, mint structure, gold camera, rose effects. A section may
 * override it with `icon` and `tint`, or opt out with `icon: null`.
 */
const SECTION_GLYPHS = Object.freeze({
  transform: ['arrows-move', 'select'], placement: ['origin', 'select'], joint: ['joints', 'select'], align: ['align-horizontal-center', 'select'],
  selection: ['cursor', 'select'], framing: ['fit', 'camera'], canvas: ['frame', 'select'], figure: ['person', 'select'],
  'spatial-proportions': ['scale', 'select'], 'spatial-perspective': ['rotate', 'select'], 'spatial-exact': ['exact', 'select'],
  'spatial-choices': ['sliders', 'select'], 'figure-name': ['person', 'select'], 'joint-name': ['joints', 'select'],
  appearance: ['palette', 'draw'], colours: ['droplet', 'draw'], 'second-colour': ['droplet', 'draw'], style: ['brush', 'draw'],
  fill: ['paint-bucket', 'draw'], text: ['text', 'draw'], background: ['image', 'draw'], drawing: ['brush', 'draw'],
  'segment-gradient-enabled': ['palette', 'draw'],
  timing: ['clock', 'time'], playback: ['play', 'time'], motion: ['route', 'time'], extend: ['loop', 'time'], range: ['clock', 'time'],
  exposure: ['layers', 'time'],
  arrange: ['layers', 'library'], layer: ['layers', 'library'], connection: ['link', 'library'], connector: ['link', 'library'],
  ik: ['pin', 'library'], rig: ['nodes', 'library'], 'rig-controls': ['nodes', 'library'], 'rig-pose': ['nodes', 'library'],
  'rig-attachment': ['link', 'library'], 'rig-path-keys': ['route', 'library'],
  'rig-mechanism': ['nodes', 'library'], 'rig-limb': ['nodes', 'library'], 'rig-body': ['nodes', 'library'], slider: ['sliders', 'library'],
  'drawing-sets': ['layers', 'library'], parallax: ['layers', 'library'], bake: ['camera', 'camera'], preview: ['camera', 'camera'],
});
/** The badge before a section's title, or nothing. */
function sectionBadge(section, env) {
  const [icon, tint] = section.icon === null ? [] : [section.icon ?? SECTION_GLYPHS[section.id]?.[0], section.tint ?? SECTION_GLYPHS[section.id]?.[1] ?? 'select'];
  if (!icon) return '';
  return `<span class="ui-section-badge" data-tint="${escapeHTML(tint)}" aria-hidden="true">${glyph(env, icon, 'ui-icon')}</span>`;
}
/** The tooltip attributes: `tip` (else `fallback`) as data-tooltip, and today's title only when asked for. */
const tooltip = (item, fallback) => ({'data-tooltip': item.tip ?? fallback, title: item.legacyTitle ? item.tip ?? item.label : undefined,
  'data-i18n-tooltip': item.tipKey, 'data-i18n-tooltip-params': item.tipKey ? JSON.stringify(item.tipParams ?? {}) : undefined,
  'data-i18n-title': item.legacyTitle ? item.tipKey ?? item.labelKey : undefined});

/** Values at rest show fewer decimals than they edit with (inspector-view.mjs: 1 with a unit, 2 without, 0 for integers). */
export const restDisplayPrecision = (precision = 3, unit = '') => (precision ? (unit ? 1 : 2) : 0);

/** A field's accessible name with its unit, human: "X (px)", "Angle (degrees)" (components.md §3 Field). */
export function describeField(label, unit = '', env = {}) {
  if (!unit) return String(label ?? '');
  return say(env, 'inspector.withUnit', {label, unit: unit === '°' ? say(env, 'inspector.unit.degrees') : unit});
}

/** A control's explicitly owned accessible caption, including a displayed unit. */
function fieldNameReference(row, withUnit = false) {
  if (row.descriptionKey) return {messageKey: row.descriptionKey, messageParams: row.descriptionParams};
  if (row.description != null) return row.description;
  const label = row.labelKey ? {messageKey: row.labelKey, messageParams: row.labelParams} : row.label;
  if (withUnit && row.unit) return {messageKey: 'inspector.withUnit', messageParams: {label, unit: row.unit === '°' ? {messageKey: 'inspector.unit.degrees'} : row.unit}};
  return label;
}
function fieldNameAttributes(row, withUnit = false) {
  const reference = fieldNameReference(row, withUnit);
  return reference?.messageKey ? ' ' + messageAttributes(reference.messageKey, reference.messageParams, 'aria-label') : '';
}

const GLUED_UNITS = new Set(['%', '°', '×', '/f']);
/** A value with its unit as a person reads it: "100%", "172°", "8 px", "24 fps". */
export function formatValueWithUnit(value, {unit = '', precision = 2} = {}) {
  const text = formatPropertyValue(value, precision);
  if (!unit || text === '') return text;
  return GLUED_UNITS.has(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/** Where a slider's fill ends, as a CSS percentage (0% to 100%). */
export function sliderFill(value, min = 0, max = 100) {
  const low = Number(min), high = Number(max), current = Number(value);
  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(current) || high <= low) return '0%';
  return `${Number((Math.max(0, Math.min(1, (current - low) / (high - low))) * 100).toFixed(2))}%`;
}

const HEX = /^#[0-9a-f]{6}$/i;
const PAINT = /^[\w\s#%.,()+-]+$/;
/** A colour for --swatch: #rrggbb, #rrggbbaa or a plain rgb()/hsl() function; anything else is refused. */
function swatchColor(value) {
  const text = String(value ?? '').trim();
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) || /^(?:rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(text) ? text : null;
}
/** A paint for --swatch-paint (paintCSS output: a colour or a gradient); declarations cannot break out of the property. */
function swatchPaint(value) {
  const text = String(value ?? '').trim();
  return text && !/[;{}\\<>"'@!]|url\(/i.test(text) && PAINT.test(text) ? text : null;
}
const swatchStyle = ({color, paint}) => {
  const vars = [];
  // A solid paint is a colour: --swatch; only gradients need their own layer.
  const solid = swatchColor(paint) ?? swatchColor(color), gradient = swatchColor(paint) ? null : swatchPaint(paint);
  if (solid) vars.push(`--swatch:${solid}`);
  if (gradient) vars.push(`--swatch-paint:${gradient}`);
  return vars.length ? vars.join(';') : undefined;
};

// ---------------------------------------------------------------------------
// Buttons: title actions, action rows, stepper steps, list-row actions, footer.

/**
 * One button. An icon without `text` is a .ui-icon-button named by aria-label
 * (which also feeds its tooltip; `tip` replaces it); otherwise a .ui-button
 * with an optional leading glyph. Behaviour comes from data-action /
 * data-command / data-shift-action, which the app's delegated handlers own.
 */
export function renderButton(item, env = {}, {className = '', size} = {}) {
  if (!item?.label) throw messageError(new TypeError(''), "errors.inspectorKit.aButtonNeedsALabelItsAccessibleName", {});
  const iconOnly = Boolean(item.icon) && !item.text;
  const classes = [iconOnly ? 'ui-icon-button' : 'ui-button', className].filter(Boolean).join(' ');
  const attrs = attributes({
    type: 'button', class: classes, id: id(item.id),
    'data-variant': iconOnly ? item.variant === 'soft' ? 'soft' : undefined : item.variant,
    'data-size': item.size ?? size,
    'data-action': item.action, 'data-shift-action': item.shiftAction, 'data-command': item.command,
    'aria-label': iconOnly ? item.label : undefined,
    'data-i18n-aria-label': iconOnly ? item.labelKey : undefined,
    'data-i18n-aria-label-params': iconOnly && item.labelKey ? JSON.stringify(item.labelParams ?? {}) : undefined,
    'aria-pressed': item.pressed === undefined ? undefined : String(Boolean(item.pressed)),
    'aria-expanded': item.expanded === undefined ? undefined : String(Boolean(item.expanded)),
    'aria-haspopup': item.menu ? 'menu' : undefined,
    ...tooltip(item),
    tabindex: item.tabindex,
    disabled: Boolean(item.disabled),
    ...extras(item),
  });
  const lead = item.icon ? glyph(env, item.icon, 'ui-icon') : '';
  return `<button${attrs}>${lead}${iconOnly ? '' : `<span class="ui-label"${descriptorAttributes(item, "label")}>${escapeHTML(item.label)}</span>`}</button>`;
}

// ---------------------------------------------------------------------------
// Rows

/** The shared input attributes of a PropertyControls number (inspector-view.mjs's numericField order, kept for string tests). */
function numberInput(row, env, className) {
  const {key, label, unit = ''} = row;
  if (!key) throw messageError(new TypeError(''), "errors.inspectorKit.numberFieldNeedsAPropertyKey", {value: label ?? ''});
  const precision = row.precision ?? 3, display = row.displayPrecision ?? restDisplayPrecision(precision, unit);
  const value = finite(row.value) ?? 0;
  const description = row.description ?? describeField(label, unit, env);
  const descriptionReference = fieldNameReference(row, true);
  const legacy = row.field === false ? undefined : (row.field ?? key);
  const mixed = Boolean(row.mixed);
  // A value field (row.range, row.default, row.angle) adds what its control needs: the scale its travel follows, its
  // default for a double click's reset and the unit it speaks with. Plain fields keep today's markup.
  const scale = row.range ? {
    'data-property-scale': row.scale && row.scale !== 'linear' ? row.scale : undefined, 'data-property-knee': finite(row.knee), 'data-property-exponent': finite(row.exponent),
  } : {};
  const valueField = Boolean(row.range || row.angle || row.default !== undefined);
  const input = `<input${attributes({
    class: className, type: 'number', id: id(row.id), 'data-field': legacy, 'data-property': key,
    'data-property-value': value, 'data-property-precision': precision, 'data-property-display-precision': display,
    'data-property-step': row.step ?? 1, ...scale, 'data-property-default': finite(row.default), 'data-property-unit': valueField ? unit : undefined,
    value: mixed ? '' : formatPropertyValue(value, display), step: 'any',
    'aria-label': description, 'aria-valuetext': valueField && !mixed ? formatValueWithUnit(value, {unit, precision}) : undefined,
    'aria-description': row.help, min: finite(row.min), max: finite(row.max), disabled: Boolean(row.disabled),
    placeholder: mixed ? say(env, 'inspector.mixed') : undefined, 'data-mixed': mixed ? String(value) : undefined, ...extras(row),
  })}${fieldNameAttributes(row, true)}${row.helpKey ? descriptorAttributes(row, 'help', 'aria-description') : ''}>`;
  // In a value field the value is the keyboard's stop; its label scrubs and holds focus while dragged, out of the tab order.
  const scrub = `<span${attributes({
    class: 'ui-field-label', 'data-property-scrub': true, tabindex: row.range || row.angle ? -1 : 0, role: 'button',
    'aria-label': row.scrubLabel ?? say(env, 'inspector.scrubLabel', {name: description}), 'data-tooltip': row.tip ?? say(env, 'inspector.scrubTip'),
  })}${descriptorAttributes(row, 'label')}${row.labelKey || row.descriptionKey ? ' ' + messageAttributes('inspector.scrubLabel', {name: descriptionReference}, 'aria-label') : ''}${row.tipKey ? descriptorAttributes(row, 'tip', 'data-tooltip') : row.tip == null ? ' ' + messageAttributes('inspector.scrubTip', {}, 'data-tooltip') : ''}>${escapeHTML(label)}</span>`;
  return {input, scrub, description, value, mixed};
}

/** A value field's fill and default tick (CSS custom properties on the field), or nothing for a plain field. */
function valueFieldStyle(row, value) {
  if (!row.range || row.mixed) return undefined;
  const range = {scale: row.scale, min: finite(row.min), max: finite(row.max), knee: row.knee, exponent: row.exponent, step: row.step};
  const parts = [`--_p:${positionPercent(valueToPosition(value, range))}`];
  // A value that runs both ways fills from zero, not from its minimum.
  if (range.min < 0 && range.max > 0) parts.push(`--_z:${positionPercent(valueToPosition(0, range))}`);
  if (finite(row.default) !== undefined) parts.push(`--_d:${positionPercent(valueToPosition(row.default, range))}`);
  return parts.join(';');
}

/** An angle's dial: a small circle whose line points the way the value does; dragging it turns the value (PropertyControls). */
const dial = (row, value) => (row.angle ? `<span class="ui-field-dial" data-property-dial style="--_a:${Number(value.toFixed(2))}deg" aria-hidden="true"></span>` : '');

/**
 * A number field: the inline label scrubs (PropertyControls) and the unit
 * follows the value. A <label>, as today's, so a click anywhere in the field
 * focuses the value. Without `key` it is a plain number input (IK's target rotation).
 *
 * The value field (components.md): `range: true` makes the whole field a slider
 * for a bounded value: a quiet fill shows where the value sits on its travel
 * (`scale`: linear, log or pow, src/ui/value-scale.mjs), `default` adds the
 * default's tick and a double click's reset, `angle: true` adds a dial,
 * `scrubAnywhere` lets an unbounded value scrub from any point of its field, `trail`
 * puts small buttons inside the field's end (a key, a shuffle), and `help` is
 * the one-line description a tooltip and a screen reader give.
 */
function numberField(row, env) {
  const glue = GLUED_UNITS.has(row.unit) ? ' data-glue' : '';
  const suffix = row.unit ? `<span class="ui-field-suffix" aria-hidden="true"${glue}>${escapeHTML(row.unit)}</span>` : '';
  if (!row.key) {
    const input = `<input${attributes({
      class: 'ui-field-input', type: 'number', id: id(row.id), step: row.step ?? 'any', value: formatPropertyValue(finite(row.value) ?? 0, row.precision ?? 3),
      'aria-label': row.description ?? describeField(row.label, row.unit, env), min: finite(row.min), max: finite(row.max),
      disabled: Boolean(row.disabled), ...extras(row),
    })}${fieldNameAttributes(row, true)}>`;
    return `<label${attributes({class: `ui-field${span(row)}`, 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span class="ui-field-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${input}${suffix}</label>`;
  }
  const {input, scrub, value} = numberInput(row, env, 'ui-field-input');
  return `<label${attributes({
    class: `ui-field${span(row)}`, 'data-property-row': row.key, 'data-mixed': Boolean(row.mixed), 'data-range': Boolean(row.range && !row.mixed),
    'data-angle': Boolean(row.angle), 'data-scrub-anywhere': Boolean(row.scrubAnywhere && !row.range), 'data-default': row.range && finite(row.default) !== undefined ? true : undefined,
    'data-tooltip': row.help, style: valueFieldStyle(row, value), ...(row.fieldData ? extras({data: row.fieldData}) : {}),
  })}${row.helpKey ? descriptorAttributes(row, 'help', 'data-tooltip') : ''}>${dial(row, value)}${scrub}${input}${suffix}</label>`;
}

/**
 * A step button: a registered command (data-action) or a plain step the
 * installer applies (data-kit-step). Out of the tab order: the value is the
 * keyboard target (ArrowUp/ArrowDown step it), so focus follows the value, not
 * the drawing order. Disabled with its row and at the limit it steps towards.
 */
function stepButton(step, direction, name, env, {disabled = false} = {}) {
  const fallback = {label: say(env, direction < 0 ? 'inspector.decrease' : 'inspector.increase', {name}), labelKey: direction < 0 ? 'inspector.decrease' : 'inspector.increase', labelParams: {name}, icon: direction < 0 ? 'minus' : 'plus'};
  const item = {...fallback, ...step, tabindex: -1, disabled: Boolean(step?.disabled || disabled)};
  if (!item.action && !item.command) item.data = {...item.data, 'kit-step': direction};
  return renderButton(item, env, {size: 'sm'});
}
/** Whether stepping from `value` towards `direction` is blocked by the row's limits (never while Mixed). */
const atLimit = (row, value, direction) => {
  if (row.mixed) return false;
  const limit = finite(direction < 0 ? row.min : row.max);
  return limit !== undefined && (direction < 0 ? value <= limit : value >= limit);
};

/**
 * The stepper field (revision 4.2/4.3): an inline label and a value between two
 * step buttons, "Order ↓ 2 ↑". The label and input share a display:contents
 * property row, so PropertyControls finds the input from the label while the
 * step buttons stay outside it (Enter on a button activates the button).
 */
function stepperField(row, env) {
  const {input, scrub, description, value} = numberInput(row, env, 'ui-field-input');
  const core = `<span class="ui-field-core" data-property-row="${escapeHTML(row.key)}">${scrub}${input}</span>`;
  const step = direction => stepButton(direction < 0 ? row.down : row.up, direction, fieldNameReference(row, true), env, {disabled: row.disabled || atLimit(row, value, direction)});
  return `<div${attributes({class: `ui-field${span(row)}`, 'data-steps': true, role: 'group', 'aria-label': row.groupLabel ?? description, 'data-tooltip': row.groupTip})}${row.groupLabelKey ? descriptorAttributes(row, 'groupLabel', 'aria-label') : row.groupLabel == null ? fieldNameAttributes(row, true) : ''}${descriptorAttributes(row, 'groupTip', 'data-tooltip')}>` +
    `${core}${step(-1)}${step(1)}</div>`;
}

/** A stepper with a row label (Inbetweens, IK chain): −, a typeable value, +. */
function stepper(row, env) {
  const name = row.description ?? row.label;
  let input, value;
  if (row.key) ({input, value} = numberInput(row, env, 'ui-stepper-input'));
  else {
    value = finite(row.value) ?? 0;
    input = `<input${attributes({
      class: 'ui-stepper-input', type: 'number', id: id(row.id), min: finite(row.min), max: finite(row.max), step: row.step ?? 1,
      value: formatPropertyValue(value, row.precision ?? 0), 'aria-label': name, disabled: Boolean(row.disabled),
      'data-precision': row.precision ?? 0, ...extras(row),
    })}${fieldNameAttributes(row)}>`;
  }
  const body = row.key ? `<span class="ui-field-core" data-property-row="${escapeHTML(row.key)}">${input}</span>` : input;
  const step = direction => stepButton(direction < 0 ? row.down : row.up, direction, fieldNameReference(row), env, {disabled: row.disabled || atLimit(row, value, direction)});
  const control = `<div class="ui-stepper" role="group"${attributes({'aria-label': name})}${fieldNameAttributes(row)}>${step(-1)}${body}${step(1)}</div>`;
  return row.label ? `<div class="ui-row"><span class="ui-row-label" aria-hidden="true"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${control}</div>` : control;
}

/**
 * A bounded value on a track: label, slider, readout. With `key` the range
 * input is a PropertyControls property. A custom `valueText` is kept for the
 * value it names (data-value-text, data-value-at); other values read with
 * their unit, or through installInspectorKit's formatSlider.
 */
function slider(row, env) {
  const min = finite(row.min) ?? 0, max = finite(row.max) ?? 100, value = finite(row.value) ?? min;
  const precision = row.precision ?? 0, unit = row.unit ?? '';
  const custom = row.valueText === undefined || row.valueText === null ? undefined : String(row.valueText);
  const text = custom ?? formatValueWithUnit(value, {unit, precision});
  const property = row.key ? {
    'data-property': row.key, 'data-property-value': value, 'data-property-precision': precision, 'data-property-step': row.step ?? 1,
  } : {};
  const input = `<input${attributes({
    class: 'ui-slider', type: 'range', id: id(row.id), ...property, min, max, step: row.step ?? 'any', value,
    'aria-label': row.description ?? row.label, 'aria-valuetext': text, disabled: Boolean(row.disabled),
    'data-unit': unit || undefined, 'data-precision': precision, 'data-value-text': custom, 'data-value-at': custom === undefined ? undefined : value,
    style: `--_p:${sliderFill(value, min, max)}`, ...extras(row),
  })}${fieldNameAttributes(row)}>`;
  return `<div${attributes({class: 'ui-slider-row', 'data-property-row': row.key, 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span class="ui-slider-label" aria-hidden="true"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${input}<output class="ui-slider-value" aria-hidden="true">${escapeHTML(text)}</output></div>`;
}

/**
 * A select carries its label inside (revision 4.1: "Layer Bubble ▾"); `bare`
 * drops the visible label when the value already names its kind ("Layer 1"),
 * keeping it as the tooltip. `placeholder` shows while no option is selected ("Mixed").
 */
function select(row, env) {
  const options = row.options ?? [];
  const selected = row.value === undefined ? options.some(option => option.selected) : options.some(option => String(option.value) === String(row.value));
  const placeholder = row.placeholder && !selected ? `<option value="" disabled selected${descriptorAttributes(row, "placeholder")}>${escapeHTML(row.placeholder)}</option>` : '';
  const body = options.map(option => `<option${attributes({
    value: option.value, selected: row.value === undefined ? Boolean(option.selected) : String(option.value) === String(row.value),
    disabled: Boolean(option.disabled), ...extras(option),
  })}${descriptorAttributes(option, 'label')}>${escapeHTML(option.label ?? option.value)}</option>`).join('');
  const control = `<select${attributes({
    class: 'ui-field-input', id: id(row.id), 'aria-label': row.description ?? row.label, disabled: Boolean(row.disabled), ...extras(row),
  })}${fieldNameAttributes(row)}>${placeholder}${body}</select>`;
  const label = row.bare ? '' : `<span class="ui-field-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>`;
  return `<label${attributes({class: `ui-field${span(row)}`, 'data-select': true, 'data-bare': Boolean(row.bare), 'data-tooltip': row.bare ? row.tip ?? row.label : row.tip})}${descriptorAttributes(row, row.tipKey || row.tip != null ? 'tip' : row.bare ? 'label' : 'tip', 'data-tooltip')}>` +
    `${label}${control}${glyph(env, 'chevron-down', 'ui-icon ui-field-chev')}</label>`;
}

/**
 * A switch input. In a field switch or a switch row the wrapping <label>
 * names it with its visible text (WCAG 2.5.3: the name is the label), so
 * aria-label is written only when a description adds to that text or when
 * nothing visible names it (`named: false`, the section title's switch).
 */
const switchInput = (item, {named = true} = {}) => `<input${attributes({
  class: 'ui-switch', type: 'checkbox', role: 'switch', id: id(item.id),
  'aria-label': named ? (item.description && item.description !== item.label ? item.description : undefined) : item.description ?? item.label,
  checked: Boolean(item.checked), 'aria-controls': item.controls, disabled: Boolean(item.disabled), ...extras(item),
})}${named ? item.description && item.description !== item.label ? descriptorAttributes(item, 'description', 'aria-label') : '' : fieldNameAttributes(item)}>`;

/** The field switch (revision 4.2): the one switch pattern in inspector sections, laid out in the field grid. */
const fieldSwitch = row => `<label${attributes({class: `ui-field${span(row)}`, 'data-switch-field': true, 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span class="ui-field-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${switchInput(row)}</label>`;
/** The switch row of popovers and dialogs: the label left, the switch right, the whole row the target. */
const switchRow = row => `<label${attributes({class: 'ui-switch-row', 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${switchInput(row)}</label>`;

const checkbox = row => `<label${attributes({class: 'ui-check-row', 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><input${attributes({
  class: 'ui-checkbox', type: 'checkbox', id: id(row.id), checked: Boolean(row.checked), 'aria-label': row.description,
  'aria-checked': row.mixed ? 'mixed' : undefined, disabled: Boolean(row.disabled), ...extras(row),
})}${descriptorAttributes(row, 'description', 'aria-label')}><span${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span></label>`;

const hexCaption = value => (HEX.test(String(value ?? '')) ? String(value).slice(1).toUpperCase() : '');

/**
 * A colour field: a swatch and its hex. `picker: 'native'` keeps an
 * <input type=color> (today's #figure-color and #background-color, read by
 * their change handlers); `picker: 'paint'` is a button with data-paint-picker
 * (today's #segment-color) whose swatch can show a gradient (`paint`).
 * color-picker.mjs opens its popover for both.
 */
function color(row, env) {
  const caption = escapeHTML(row.caption ?? (row.mixed ? say(env, 'inspector.mixed') : hexCaption(row.value)));
  if (row.picker === 'paint') {
    const gradient = Boolean(row.paint) && !swatchColor(row.paint);
    const swatch = `<span${attributes({class: 'ui-swatch', 'data-size': 'sm', 'data-mixed': Boolean(row.mixed), 'data-gradient': gradient, style: swatchStyle({color: row.value, paint: row.paint})})}></span>`;
    // A value field's colour (showLabel) names itself like every field: its label, then the swatch and its hex.
    const label = row.showLabel ? `<span class="ui-field-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>` : '';
    return `<button${attributes({
      // `owned`: the owner opens its own picker (an effect's paint, with gradients), so the shared one stays away.
      type: 'button', class: `ui-field${span(row)}`, 'data-color': true, 'data-labelled': Boolean(row.showLabel), id: id(row.id), 'data-paint-picker': row.owned ? undefined : true,
      'aria-label': row.description ?? row.label, 'data-tooltip': row.tip, disabled: Boolean(row.disabled), ...extras(row),
    })}${fieldNameAttributes(row)}${descriptorAttributes(row, 'tip', 'data-tooltip')}>${label}${swatch}<span class="ui-field-hex"${row.captionKey ? descriptorAttributes(row, 'caption') : ''}>${caption}</span></button>`;
  }
  const value = HEX.test(String(row.value ?? '')) ? String(row.value).toLowerCase() : '#000000';
  return `<label${attributes({class: `ui-field${span(row)}`, 'data-color': true, 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><input${attributes({
    class: 'ui-swatch', type: 'color', id: id(row.id), value, 'aria-label': row.description ?? row.label, disabled: Boolean(row.disabled),
    'data-mixed': Boolean(row.mixed), ...extras(row),
  })}${fieldNameAttributes(row)}><span class="ui-field-hex">${caption}</span></label>`;
}

/** One swatch on its own (a list row's colour, a palette entry): a native colour input or a paint-picker button. */
function swatch(item) {
  if (item.picker === 'native') {
    const value = HEX.test(String(item.value ?? '')) ? String(item.value).toLowerCase() : '#000000';
    return `<input${attributes({
      class: 'ui-swatch', type: 'color', id: id(item.id), value, 'data-size': item.size, 'aria-label': item.label,
      'data-tooltip': item.tip, tabindex: item.tabindex, disabled: Boolean(item.disabled), ...extras(item),
    })}${descriptorAttributes(item, 'label', 'aria-label')}${descriptorAttributes(item, 'tip', 'data-tooltip')}>`;
  }
  return `<button${attributes({
    type: 'button', class: 'ui-swatch', id: id(item.id), 'data-size': item.size, 'data-paint-picker': item.picker === 'paint' ? true : undefined,
    style: swatchStyle({color: item.value, paint: item.paint}), 'aria-label': item.label, 'data-tooltip': item.tip,
    'aria-pressed': item.pressed === undefined ? undefined : String(Boolean(item.pressed)), tabindex: item.tabindex, disabled: Boolean(item.disabled), ...extras(item),
  })}${descriptorAttributes(item, 'label', 'aria-label')}${descriptorAttributes(item, 'tip', 'data-tooltip')}></button>`;
}
/**
 * A collection of swatches (the figure's palette, recent colours): one group
 * of 24px targets and one tab stop ([data-count-one], components.md
 * Collections): the pressed swatch (else the first) takes the tab stop and
 * the arrow keys move inside (installInspectorKit).
 */
function swatches(row) {
  const items = row.items ?? [];
  const current = Math.max(0, items.findIndex(item => item.pressed));
  return `<div${attributes({class: 'ui-swatch-grid', role: 'group', 'aria-label': row.label, 'data-count-one': true, ...extras(row)})}${descriptorAttributes(row, 'label', 'aria-label')}>` +
    `${items.map((item, index) => swatch({...item, tabindex: index === current ? 0 : -1})).join('')}</div>`;
}

/**
 * A segmented control, 2-4 options. `mode`: 'radio' keeps native radio inputs
 * in a radiogroup (their change handlers, as IK's bend direction; they need a
 * `name`), 'pressed' renders aria-pressed buttons (tested button groups),
 * 'tab' role=tab buttons.
 */
function segmented(row, env) {
  const mode = row.mode ?? 'radio', options = row.options ?? [];
  if (options.length < 2 || options.length > 4) throw messageError(new TypeError(''), "errors.inspectorKit.segmentedNeeds24OptionsUseASelect", {value: row.label ?? row.name});
  if (mode === 'radio' && !row.name) throw messageError(new TypeError(''), "errors.inspectorKit.segmentedInRadioModeNeedsANameOr", {value: row.label ?? ''});
  const current = option => String(option.value) === String(row.value);
  const items = options.map(option => {
    const lead = option.icon ? glyph(env, option.icon, 'ui-icon') : '';
    const text = option.iconOnly ? '' : `<span class="ui-label"${descriptorAttributes(option, "label")}>${escapeHTML(option.label)}</span>`;
    if (mode === 'radio') {
      return `<label${attributes({class: 'ui-segmented-item', 'data-tooltip': option.tip ?? (option.iconOnly ? option.label : undefined)})}${descriptorAttributes(option, option.tipKey || option.tip != null ? 'tip' : option.iconOnly ? 'label' : 'tip', 'data-tooltip')}><input${attributes({
        class: 'ui-segmented-input', type: 'radio', name: row.name, value: option.value, checked: current(option),
        'aria-label': option.description ?? (option.iconOnly ? option.label : undefined), disabled: Boolean(row.disabled || option.disabled), ...extras(option),
      })}${option.description ? descriptorAttributes(option, 'description', 'aria-label') : option.iconOnly ? fieldNameAttributes(option) : ''}>${lead}${text}</label>`;
    }
    return `<button${attributes({
      type: 'button', class: 'ui-segmented-item', id: id(option.id), role: mode === 'tab' ? 'tab' : undefined,
      'aria-selected': mode === 'tab' ? String(current(option)) : undefined, 'aria-pressed': mode === 'pressed' ? String(current(option)) : undefined,
      'aria-label': option.iconOnly ? option.label : undefined, 'data-tooltip': option.tip,
      'data-action': option.action, disabled: Boolean(row.disabled || option.disabled), ...extras(option),
    })}${option.iconOnly ? descriptorAttributes(option, 'label', 'aria-label') : ''}${descriptorAttributes(option, 'tip', 'data-tooltip')}>${lead}${text}</button>`;
  }).join('');
  const role = mode === 'tab' ? 'tablist' : mode === 'radio' ? 'radiogroup' : 'group';
  const control = `<div${attributes({
    class: 'ui-segmented', role, 'aria-label': row.description ?? row.label, 'data-size': row.size ?? 'sm', 'data-fill': Boolean(row.fill), ...extras(row),
  })}${fieldNameAttributes(row)}>${items}</div>`;
  // `field: true` (a value field's choice of two to four): its label and its segments share one field tile.
  if (row.field) return `<div${attributes({class: `ui-field${span(row)}`, 'data-segments': true, 'data-tooltip': row.tip})}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span class="ui-field-label" aria-hidden="true"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${control}</div>`;
  return row.label && !row.inline ? `<div class="ui-row"><span class="ui-row-label" aria-hidden="true"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${control}</div>` : control;
}

/** A text field (names): the inline label pattern, or `stacked` for the rare form row. */
function text(row) {
  const input = `<input${attributes({
    class: 'ui-field-input', type: 'text', id: id(row.id), value: row.value ?? '', 'aria-label': row.description ?? row.label,
    maxlength: finite(row.maxlength), placeholder: row.placeholder, ...tooltip(row), disabled: Boolean(row.disabled),
    spellcheck: row.spellcheck === undefined ? undefined : String(Boolean(row.spellcheck)), ...extras(row),
  })}${fieldNameAttributes(row)}${descriptorAttributes(row, 'placeholder', 'placeholder')}>`;
  if (row.stacked) return `<div class="ui-form-row${span(row)}"><span class="ui-form-label" aria-hidden="true"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span><div class="ui-field">${input}</div></div>`;
  return `<label class="ui-field${span(row)}" data-text><span class="ui-field-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>${input}</label>`;
}

/** An action row: a few buttons that act on the selection (Align's six, Fit view…). */
const actions = (row, env) => `<div${attributes({class: 'ui-action-row', role: 'group', 'aria-label': row.label, 'data-fill': Boolean(row.fill), ...extras(row)})}${descriptorAttributes(row, 'label', 'aria-label')}>${(row.items ?? []).map(item => renderButton(item, env, {size: row.size})).join('')}</div>`;

/** A list row: lead glyph, name, meta, and its actions in their own column (eye, lock, a swatch, delete). */
function listRow(row, env) {
  const controls = (row.actions ?? []).map(item => (item.kind === 'swatch' ? swatch(item) : renderButton(item, env, {size: 'sm'}))).join('');
  const level = Math.max(0, Math.min(16, Math.round(finite(row.level) ?? 0)));
  return `<div${attributes({
    class: 'ui-list-row', id: id(row.id), role: row.role, tabindex: row.tabindex,
    'aria-selected': row.selected === undefined ? undefined : String(Boolean(row.selected)),
    'aria-current': row.current ? 'true' : undefined, 'data-hidden': row.muted ? 'true' : undefined,
    style: level ? `--level:${level}` : undefined, ...extras(row),
  })}>${row.lead ? `<span class="ui-list-row-lead">${glyph(env, row.lead, 'ui-icon')}</span>` : ''}` +
    `<span class="ui-list-row-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>` +
    `${row.meta === undefined ? '' : `<span class="ui-list-row-meta"${descriptorAttributes(row, "meta")}>${escapeHTML(row.meta)}</span>`}` +
    `${controls ? `<span class="ui-list-row-actions">${controls}</span>` : ''}</div>`;
}

/** Pages of a long list (fills, palette colours): previous, "1–12 / 14", next. */
function pager(row, env) {
  const button = item => renderButton({size: 'sm', ...item}, env, {size: 'sm'});
  return `<div${attributes({class: 'inspector-pager', role: 'group', 'aria-label': row.label, ...extras(row)})}${descriptorAttributes(row, 'label', 'aria-label')}>${button(row.previous)}` +
    `<span class="inspector-pager-text"${descriptorAttributes(row, "text")}>${escapeHTML(row.text)}</span>${button(row.next)}</div>`;
}

/** An owned host: imperative widgets (graphs, curves, monitors) keep their live content across renders. */
function owned(row) {
  if (!row.key || !DATA_NAME.test(row.key)) throw messageError(new TypeError(''), "errors.inspectorKit.anOwnedHostNeedsAKeyItsData", {});
  const tag = row.tag === 'canvas' ? 'canvas' : 'div';
  const attrs = attributes({
    class: row.className, 'data-inspector-owned': row.key, 'data-section': row.section, role: row.role, 'aria-label': row.label,
    'data-tooltip': row.tip, ...extras(row),
  });
  const bindings = descriptorAttributes(row, 'label', 'aria-label') + descriptorAttributes(row, 'tip', 'data-tooltip');
  return tag === 'canvas' ? `<canvas${attrs}${bindings}></canvas>` : `<div${attrs}${bindings}>${row.html ?? ''}</div>`;
}

/**
 * A preview: an owned canvas or widget drawn flat in the section body with an
 * optional one-line caption (the camera monitor with its size and zoom, the
 * brush stroke). A plain element, not a card (components.md §0.6 keeps Card
 * retired); its section's title action carries what acts on it (Guides).
 */
function preview(row) {
  const media = owned({...row.media, key: row.media?.key ?? row.key, className: `inspector-preview-media${row.media?.className ? ` ${row.media.className}` : ''}`});
  const caption = (row.caption ?? []).map(part => (typeof part === 'string'
    ? `<span>${escapeHTML(part)}</span>` : `<span${attributes(extras(part))}${descriptorAttributes(part, "text")}>${escapeHTML(part.text)}</span>`)).join('');
  return `<div${attributes({class: `inspector-preview${span(row)}`, 'data-section': row.section, ...extras(row)})}>${media}${caption ? `<div class="inspector-preview-caption">${caption}</div>` : ''}</div>`;
}

/**
 * Markup a sub-module still builds as HTML (rig controls until M7a, the
 * camera's until M7e, drawing until M7b…), placed as it is and reconciled
 * like the rest of the inspector (it is not an owned host). Never document
 * text: those modules escape what they interpolate.
 */
const markup = row => String(row.html ?? '');

/**
 * A quiet line of facts ("2 figures · 48 frames · 2.0 s"). Never a <p>: the
 * audit counts paragraphs at rest as helper prose. `parts` compose the line
 * from text and hooked spans ({text, data, attrs, tag: 'span' | 'output'}),
 * for a value a module updates or a test reads by itself.
 */
function meta(row) {
  const bindings=tupleMessages(row.parts);
  const part = (item,index) => {
    if (typeof item === 'string') return bindings[index]?`<span ${messageAttributes(bindings[index].key,bindings[index].params)}>${escapeHTML(item)}</span>`:escapeHTML(item);
    const tag = item?.tag === 'output' ? 'output' : 'span';
    return `<${tag}${attributes({class: item.className, ...extras(item)})}${descriptorAttributes(item,'text')}${descriptorAttributes(item,'description','aria-label')}${descriptorAttributes(item,'tip','data-tooltip')}>${escapeHTML(item?.text)}</${tag}>`;
  };
  const body = row.parts ? row.parts.map(part).join('') : escapeHTML(row.text);
  return `<div${attributes({class: 'inspector-meta', id: id(row.id), 'data-tooltip': row.tip, ...extras(row)})}${row.parts?'':descriptorAttributes(row,'text')}${descriptorAttributes(row,'tip','data-tooltip')}>${body}</div>`;
}

/** A read-only value with its row label ("Joined to  Rival · Left hand", "Fills  No fills"). */
const value = row => `<div${attributes({class: 'ui-row', id: id(row.id), ...extras(row)})}><span class="ui-row-label"${descriptorAttributes(row, "label")}>${escapeHTML(row.label)}</span>` +
  `<span${attributes({class: 'ui-row-value', 'data-tooltip': row.tip})}${descriptorAttributes(row, "text")}>${escapeHTML(row.text)}</span></div>`;

/** Two columns of fields. With an id it can be a controlled region; `hidden` hides it in place. */
function grid(row, env) {
  return `<div${attributes({class: 'ui-field-grid', id: id(row.id), 'data-ratio': row.ratio, 'data-stack-narrow': Boolean(row.stackNarrow),
    hidden: Boolean(row.hidden), ...extras(row)})}>${renderRows(row.rows, env)}</div>`;
}

/**
 * Rows stacked as one region: IK's options (#node-ik-options), a fill's own fields. `hidden` hides it in place, keeping its id.
 * `title` shows a quiet heading over the rows (a block of a section: the rig's Second rotation), which names the group.
 */
function group(row, env) {
  const title = row.title ? `<div class="inspector-group-title" aria-hidden="true"${descriptorAttributes(row, "title")}>${escapeHTML(row.title)}</div>` : '';
  return `<div${attributes({class: 'inspector-group', id: id(row.id), role: row.role ?? (row.title ? 'group' : undefined), 'aria-label': row.label ?? row.title,
    hidden: Boolean(row.hidden), ...extras(row)})}${descriptorAttributes(row, row.labelKey || row.label != null ? 'label' : 'title', 'aria-label')}>${title}${renderRows(row.rows, env)}</div>`;
}

/**
 * A visual picker's field (looks and styles): its label, the chosen option's picture and name, and a chevron; a
 * click opens the owner's grid of options. `art` is trusted markup (an <img> or a glyph) from the owner.
 */
function picker(row, env) {
  return `<button${attributes({
    type: 'button', class: `ui-field${span(row)}`, 'data-picker': true, id: id(row.id), 'aria-label': row.description ?? row.label, 'aria-haspopup': 'dialog',
    'data-tooltip': row.tip, disabled: Boolean(row.disabled), ...extras(row),
  })}${fieldNameAttributes(row)}${descriptorAttributes(row, 'tip', 'data-tooltip')}><span class="ui-field-label"${descriptorAttributes(row, 'label')}>${escapeHTML(row.label)}</span>` +
    `<span class="ui-field-art" aria-hidden="true">${row.art ?? ''}</span><span class="ui-field-hex"${descriptorAttributes(row, 'text')}>${escapeHTML(row.text)}</span>${glyph(env, 'chevron-down', 'ui-icon ui-field-chev')}</button>`;
}

/**
 * A linked pair (width and height): two fields side by side with the link between them, a pressed toggle. While
 * linked, a pair may show one field that edits both.
 */
function pair(row, env) {
  const link = row.link ? renderButton({icon: row.link.pressed ? 'link' : 'detach', size: 'xs', ...row.link, pressed: Boolean(row.link.pressed)}, env, {className: 'ui-field-link'}) : '';
  const [first, second] = row.rows ?? [];
  return `<div${attributes({class: 'ui-field-pair', 'data-single': !second || second.hidden ? true : undefined, role: 'group', 'aria-label': row.label, ...extras(row)})}${descriptorAttributes(row, 'label', 'aria-label')}>${renderRow(first, env)}${link}${second && !second.hidden ? renderRow(second, env) : ''}</div>`;
}

const RENDERERS = {
  number: numberField, 'stepper-field': stepperField, stepper, slider, select, switch: switchRow, 'field-switch': fieldSwitch,
  checkbox, color, swatch, swatches, segmented, text, actions, 'list-row': listRow, pager, preview, owned, markup, meta, value, grid, group, pair, picker,
};
/** The row kinds a descriptor may use. */
export const ROW_KINDS = Object.freeze(Object.keys(RENDERERS));
// Regions render themselves while hidden, so an aria-controls keeps its target.
const REGIONS = new Set(['grid', 'group']);
/** The empty node a hidden or absent row leaves in its place, so the rows after it keep their positions. */
export const ROW_PLACEHOLDER = '<div hidden></div>';

/** One row of a section body. Unknown kinds throw: a silently dropped control would be a lost function. */
export function renderRow(row, env = {}) {
  if (!row || (row.hidden && !REGIONS.has(row.kind))) return ROW_PLACEHOLDER;
  const render = RENDERERS[row.kind];
  if (!render) throw messageError(new TypeError(''), "errors.inspectorKit.unknownInspectorRowKind", {value: row?.kind});
  const trail = (row.trail ?? []).filter(Boolean);
  if (!trail.length) return render(row, env);
  // Small buttons at a field's end (a value's key, a seed's shuffle) sit beside the field, never inside its <label>
  // or <button>, and are drawn over its end, which keeps room for them (data-trail).
  const buttons = trail.map(item => renderButton({size: 'xs', ...item}, env, {className: `ui-field-trail${item.className ? ` ${item.className}` : ''}`})).join('');
  return `<div class="ui-field-wrap${span(row)}" data-trail="${trail.length}">${render(row, env)}${buttons}</div>`;
}
const renderRows = (rows, env) => (rows ?? []).map(row => renderRow(row, env)).join('');

// ---------------------------------------------------------------------------
// Sections and their remembered state

const MEMORY_KINDS = 48, MEMORY_SECTIONS = 64;
/** The inspectorSections setting, cleaned: {kind: {sectionId: true}} for the titled sections a person left open. */
export function normalizeSectionMemory(saved) {
  const result = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return result;
  for (const [kind, sections] of Object.entries(saved).slice(0, MEMORY_KINDS)) {
    if (!SECTION_ID.test(kind) || !sections || typeof sections !== 'object' || Array.isArray(sections)) continue;
    const open = Object.entries(sections).filter(([section, value]) => SECTION_ID.test(section) && value === true).slice(0, MEMORY_SECTIONS);
    if (open.length) result[kind] = Object.fromEntries(open);
  }
  return result;
}

/** A titled section's auto-open rule for this render: `open` as a boolean or a function of the context. */
export function autoOpen(section, ctx) {
  return typeof section?.open === 'function' ? Boolean(section.open(ctx)) : section?.open === true;
}

/**
 * Which titled sections are open. Per context kind, a section a person opened
 * stays open (remembered and saved through onChange). A section also opens by
 * itself while its auto-open rule holds (Connection while joined, Parallax
 * while on); closing it then dismisses it until the rule stops holding, so
 * the next time its content matters it opens again, and forgets that the
 * person had opened it before: the last explicit action wins. Dismissals are
 * not saved.
 */
export class SectionMemory {
  constructor(saved = {}, {onChange} = {}) {
    this.saved = normalizeSectionMemory(saved);
    this.dismissed = new Set();
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }
  isOpen(kind, section, ctx) {
    if ((section?.place ?? 'core') !== 'titled') return true;
    const key = `${kind}\u0000${section.id}`;
    if (autoOpen(section, ctx)) return !this.dismissed.has(key);
    this.dismissed.delete(key);
    return this.saved[kind]?.[section.id] === true;
  }
  /** Records a person's toggle. `auto` is whether the section's rule held when they toggled it. */
  toggle(kind, sectionId, open, {auto = false} = {}) {
    if (!SECTION_ID.test(String(kind)) || !SECTION_ID.test(String(sectionId))) return false;
    const key = `${kind}\u0000${sectionId}`;
    if (auto) {
      if (open) { this.dismissed.delete(key); return true; }
      this.dismissed.add(key);
      this.#save(kind, sectionId, false);
      return true;
    }
    return this.#save(kind, sectionId, open);
  }
  #save(kind, sectionId, open) {
    const sections = {...this.saved[kind]};
    if (open) sections[sectionId] = true; else delete sections[sectionId];
    const next = {...this.saved};
    if (Object.keys(sections).length) next[kind] = sections; else delete next[kind];
    const normalized = normalizeSectionMemory(next);
    if (JSON.stringify(normalized) === JSON.stringify(this.saved)) return false;
    this.saved = normalized;
    this.onChange?.(this.toJSON());
    return true;
  }
  toJSON() { return structuredClone(this.saved); }
}

/** Open state for one render: core sections always; titled ones from the memory, else their auto-open rule. */
export function resolveSectionOpen(section, {kind = 'default', ctx, memory} = {}) {
  if ((section?.place ?? 'core') !== 'titled') return true;
  return memory ? memory.isOpen(kind, section, ctx) : autoOpen(section, ctx);
}

/** The body id a titled section's toggle controls, unique per context kind. */
export const sectionBodyId = (kind, sectionId) => `inspector-section-${String(kind).replace(/[^a-z0-9-]/gi, '-')}-${sectionId}`;

function titleActions(section, env) {
  const list = [...(section.actions ?? [])];
  const count = list.length + (section.switch ? 1 : 0);
  if (count > MAX_TITLE_ACTIONS) throw messageError(new TypeError(''), "errors.inspectorKit.sectionHasTitleActionsAtMost", {id: section.id, count: count, MAX_TITLE_ACTIONS: MAX_TITLE_ACTIONS});
  const buttons = list.map(item => renderButton({...item, variant: item.icon && !item.text ? item.variant : item.variant ?? 'ghost'}, env, {className: 'ui-section-action', size: 'sm'})).join('');
  return list.length > 1 ? `<div class="ui-section-actions">${buttons}</div>` : buttons;
}

/**
 * One section: a quiet title with at most two title actions and its rows. A
 * hidden section leaves an empty placeholder. A `bare` section is a
 * sub-module's own markup placed edge to edge, without a title or a body grid
 * (.inspector-bare), until that module moves to descriptors; hidden, it keeps
 * that markup (the module may read or update it while it is not shown).
 */
export function renderSection(section, env = {}) {
  if (!section) return '<section class="ui-section" hidden></section>';
  if (!SECTION_ID.test(String(section.id))) throw messageError(new TypeError(''), "errors.inspectorKit.invalidSectionId", {id: section.id});
  if (section.bare) {
    if (section.title || section.actions?.length || section.switch || (section.place ?? 'core') !== 'core') throw messageError(new TypeError(''), "errors.inspectorKit.bareSectionHasNoTitleActionsOrPlace", {id: section.id});
    return `<div class="inspector-bare" data-section="${section.id}"${section.hidden ? ' hidden' : ''}>${renderRows(section.rows, env)}</div>`;
  }
  if (section.hidden) return `<section class="ui-section" data-section="${section.id}" hidden></section>`;
  const place = section.place ?? 'core';
  if (!SECTION_PLACES.includes(place)) throw messageError(new TypeError(''), "errors.inspectorKit.sectionHasAnUnknownPlace", {id: section.id, place: place});
  const kind = env.kind ?? 'default', rows = renderRows(section.rows, env), actions = titleActions(section, env);
  // Hooks a feature reads from the section (data-parallax-layer, data-motion-id).
  const hooks = attributes(extras(section));
  if (place === 'core') {
    if (section.switch) throw messageError(new TypeError(''), "errors.inspectorKit.coreSectionCannotCarryATitleSwitchMake", {id: section.id});
    const head = section.title || actions ? `<div class="ui-section-head">${section.title ? `${sectionBadge(section, env)}<h3 class="ui-section-title"${descriptorAttributes(section, "title")}>${escapeHTML(section.title)}</h3>` : ''}${actions}</div>` : '';
    return `<section class="ui-section" data-section="${section.id}"${hooks}>${head}<div class="ui-section-body">${rows}</div></section>`;
  }
  if (!section.title) throw messageError(new TypeError(''), "errors.inspectorKit.titledSectionNeedsATitleThatSaysWhat", {id: section.id});
  const auto = autoOpen(section, env.ctx), open = resolveSectionOpen(section, env), body = sectionBodyId(kind, section.id);
  const toggle = `<button${attributes({
    type: 'button', class: 'ui-section-toggle', 'aria-expanded': String(open), 'aria-controls': body,
    'data-section-toggle': section.id, 'data-section-kind': kind, 'data-auto': auto,
  })}>${sectionBadge(section, env)}<span class="ui-section-title"${descriptorAttributes(section, "title")}>${escapeHTML(section.title)}</span>${glyph(env, 'chevron-right', 'ui-icon ui-section-chev')}</button>`;
  const titleSwitch = section.switch ? `<span class="ui-section-sizer" aria-hidden="true"${descriptorAttributes(section, "title")}>${escapeHTML(section.title)}</span>` +
    `<label${attributes({class: 'ui-section-switch', 'data-tooltip': section.switch.tip ?? section.switch.label})}>${switchInput(section.switch, {named: false})}</label>` : '';
  const head = `<div${attributes({class: 'ui-section-head', 'data-switch': Boolean(section.switch)})}>${toggle}${titleSwitch}${actions}</div>`;
  return `<section class="ui-section" data-section="${section.id}" data-collapsible${open ? ' data-open' : ''}${hooks}>${head}` +
    `<div class="ui-section-body" id="${body}"${open ? '' : ' hidden'}>${rows}</div></section>`;
}

// ---------------------------------------------------------------------------
// Scope line, quick actions slot, footer, and the whole inspector

/**
 * The scope line (revision 4): shown only while an edit reaches beyond the
 * selection ("Editing frames 22–28 · Stop"). Text, not chrome. The slot is
 * always rendered (empty, classless and hidden while inactive, so nothing
 * draws it), which keeps the nodes after it in place.
 */
export function renderScope(scope, env = {}) {
  if (!scope?.label) return '<div id="inspector-scope" role="status" hidden></div>';
  const stop = scope.stop ? renderButton({variant: 'ghost', ...scope.stop, label: scope.stop.label ?? say(env, 'inspector.stop')}, env, {size: 'sm'}) : '';
  return `<div class="ui-scope" id="inspector-scope" role="status"><span class="ui-dot" data-tint="select" aria-hidden="true"></span><span${descriptorAttributes(scope, "label")}>${escapeHTML(scope.label)}</span>${stop}</div>`;
}

/**
 * The quick actions row's host under the target's name. quick-actions.mjs fills
 * it from the command registry (pins included), so the host is owned: a
 * refresh never touches its buttons. Keyed by context, so moving to another
 * kind of selection replaces the host (syncQuickHost() rebinds the controller).
 */
export function renderQuickSlot(quick, env = {}) {
  if (!quick?.context) return '';
  if (!SECTION_ID.test(quick.context)) throw messageError(new TypeError(''), "errors.inspectorKit.invalidQuickActionsContext", {context: quick.context});
  return `<div${attributes({
    class: 'ui-quick', role: 'toolbar', 'aria-label': quick.label ?? say(env, 'inspector.actions'), 'data-quick-context': quick.context,
    'data-inspector-owned': `quick-${quick.context}`,
  })}></div>`;
}

/** The header's part of a context: the scope slot (always), then the quick actions host. For inspector-header.mjs. */
export const renderInspectorHead = (inspector, env = {}) => renderScope(inspector?.scope, env) + renderQuickSlot(inspector?.quick, env);

/** The inspector's foot: one quiet row of commands for the whole context (the figure's "Add to library"), for a host pinned under the body. */
export function renderFooter(items, env = {}) {
  if (!items?.length) return '';
  return `<div class="inspector-foot" id="inspector-foot">${items.map(item => renderButton({variant: 'ghost', text: true, ...item}, env, {size: 'sm'})).join('')}</div>`;
}

function checkSections(inspector) {
  const seen = new Set();
  for (const section of inspector?.sections ?? []) {
    if (!section) continue;
    if (seen.has(section.id)) throw messageError(new TypeError(''), "errors.inspectorKit.duplicateSectionId", {id: section.id});
    seen.add(section.id);
  }
}

/**
 * A whole context's sections, the content of #inspector. env: {ctx, memory
 * (SectionMemory), icon(name, className), t(key, params)}; the context kind
 * names the memory's bucket. Section ids must be unique. `head` and `foot`
 * add the scope slot and quick actions host before the sections and the foot
 * after them, for a host without a header or a pinned foot of its own.
 */
export function renderInspector(inspector, env = {}, {head = false, foot = false} = {}) {
  const kind = inspector?.kind ?? env.kind ?? 'default';
  if (!SECTION_ID.test(kind)) throw messageError(new TypeError(''), "errors.inspectorKit.invalidInspectorKind", {kind: kind});
  checkSections(inspector);
  const scoped = {...env, kind}, sections = inspector?.sections ?? [];
  const body = sections.map(section => renderSection(section, scoped)).join('');
  return (head ? renderInspectorHead(inspector, scoped) : '') + body + (foot ? renderFooter(inspector?.footer, scoped) : '');
}

// ---------------------------------------------------------------------------
// The budget (architecture.md §3.13; the audit's ui-budget gate)

/**
 * The controls a row shows, counted as the audit counts: every focusable
 * control, a keyed field's scrub label too (it is a tab stop), a collection
 * once, nothing for previews, owned hosts (unless `controls` says), meta and
 * values.
 */
export function rowControls(row) {
  if (!row || row.hidden) return 0;
  switch (row.kind) {
    case 'number': return row.key ? 2 : 1;
    case 'stepper-field': return 4;
    case 'stepper': return 3;
    case 'swatches': return (row.items ?? []).length ? 1 : 0;
    case 'segmented': return (row.options ?? []).length;
    case 'actions': return (row.items ?? []).length;
    case 'list-row': return row.tabindex !== undefined && Number(row.tabindex) >= 0 ? 1 : (row.actions ?? []).length;
    case 'pager': return 2;
    case 'owned': case 'preview': case 'markup': return Number(row.controls) || 0;
    case 'meta': case 'value': return 0;
    case 'grid': case 'group': return (row.rows ?? []).reduce((sum, child) => sum + rowControls(child), 0);
    default: return 1;
  }
}

/**
 * What a context's inspector breaks of the budget at rest: open and titled
 * sections, titled core sections (2–3 per context) and controls, the header's
 * (`headerControls`: its menu and quick actions) included. [] when it fits.
 */
export function inspectorBudgetProblems(inspector, {ctx, memory, kind = inspector?.kind ?? 'default', headerControls = 0, limits = INSPECTOR_BUDGET} = {}) {
  const problems = [];
  let open = 0, titled = 0, core = 0, controls = Number(headerControls) || 0;
  for (const section of inspector?.sections ?? []) {
    if (!section || section.hidden) continue;
    const place = section.place ?? 'core', isOpen = resolveSectionOpen(section, {kind, ctx, memory});
    controls += (section.actions ?? []).length + (section.switch ? 1 : 0);
    if (place === 'titled') { titled++; controls++; } else if (section.title) core++;
    if (isOpen) { open++; controls += (section.rows ?? []).reduce((sum, row) => sum + rowControls(row), 0); }
  }
  if (controls > limits.controls) problems.push(`${kind}: ${controls} controls > ${limits.controls}`);
  if (open > limits.openSections) problems.push(`${kind}: ${open} open sections > ${limits.openSections}`);
  if (titled > limits.titledSections) problems.push(`${kind}: ${titled} titled sections > ${limits.titledSections}`);
  if (core > limits.coreSections) problems.push(`${kind}: ${core} titled core sections > ${limits.coreSections}`);
  return problems;
}

// ---------------------------------------------------------------------------
// The thin DOM half

/** Sets a titled section's open state in place (the next render emits the same state from the memory). */
export function setSectionOpen(toggle, open) {
  const section = toggle.closest('.ui-section');
  const body = toggle.ownerDocument.getElementById(toggle.getAttribute('aria-controls'));
  toggle.setAttribute('aria-expanded', String(open));
  section?.toggleAttribute('data-open', open);
  body?.toggleAttribute('hidden', !open);
}

/**
 * Keeps a quick-actions controller bound to the row the last render left in
 * `root` (call it after every updateInspectorDOM of the header). The same host
 * keeps its controller; a new host (another context, or the first render)
 * gets a new one and the old one is destroyed, releasing its observers; no
 * host destroys it. Returns the controller to keep, or null. `options` go to
 * createQuickActions ({registry, pins, icon, t, commandContext, …}).
 */
export function syncQuickHost(root, controller, {create = createQuickActions, ...options} = {}) {
  const host = root?.querySelector?.('.ui-quick[data-quick-context]') ?? null;
  if (controller && controller.element === host) return controller;
  controller?.destroy?.();
  return host ? create({...options, host, context: host.dataset.quickContext}) : null;
}

/** Whether a scroller has more content below its visible part (the "more below" fade). */
export const hasMoreBelow = ({scrollTop = 0, clientHeight = 0, scrollHeight = 0} = {}) => scrollHeight - scrollTop - clientHeight > 1;

const precisionOf = input => Number(input.dataset.propertyPrecision ?? input.dataset.precision ?? 0);
/** Enables a plain stepper's step buttons by its value's limits (commands' buttons follow the next render). */
function syncStepButtons(host) {
  const input = host?.querySelector('input[type=number]');
  if (!input) return;
  const value = Number(input.value), min = input.min === '' ? -Infinity : Number(input.min), max = input.max === '' ? Infinity : Number(input.max);
  for (const button of host.querySelectorAll('[data-kit-step]')) {
    const down = Number(button.dataset.kitStep) < 0;
    button.disabled = input.disabled || (!input.hasAttribute('data-mixed') && (down ? value <= min : value >= max));
  }
}

/** Steps a stepper's input by one step within its limits, then reports it as a person's edit (input, change). */
function stepInput(button) {
  const host = button.closest('.ui-stepper, .ui-field[data-steps]');
  const input = host?.querySelector('input[type=number]');
  if (!input || input.disabled) return;
  const before = input.value, direction = Number(button.dataset.kitStep) < 0 ? -1 : 1;
  const step = Number(input.dataset.propertyStep) || (Number(input.step) > 0 ? Number(input.step) : 1);
  const min = input.min === '' ? -Infinity : Number(input.min), max = input.max === '' ? Infinity : Number(input.max);
  const current = Number(input.dataset.propertyValue ?? input.value) || 0;
  const next = Math.max(min, Math.min(max, current + direction * step));
  input.value = formatPropertyValue(next, precisionOf(input));
  syncStepButtons(host);
  if (input.value === before) return;
  const {Event} = input.ownerDocument.defaultView;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
}

/** Keeps a slider's fill and readout with its value (dragged, stepped by keys or rolled back). */
function syncSlider(input, format) {
  input.style.setProperty('--_p', sliderFill(input.value, input.min === '' ? 0 : input.min, input.max === '' ? 100 : input.max));
  const custom = input.dataset.valueText !== undefined && Number(input.value) === Number(input.dataset.valueAt) ? input.dataset.valueText : null;
  const text = custom ?? format?.(input, Number(input.value)) ??
    formatValueWithUnit(input.value, {unit: input.dataset.unit ?? '', precision: Number(input.dataset.precision ?? 0)});
  if (input.getAttribute('aria-valuetext') !== text) input.setAttribute('aria-valuetext', text);
  const output = input.parentElement?.querySelector('.ui-slider-value');
  if (output && output.textContent !== text) output.textContent = text;
}

/**
 * Wires the kit's own behaviour on the inspector root: section toggles (the
 * memory, then onToggle({kind, id, open, auto})), plain step buttons, slider
 * readouts (while dragged, stepped by keys and rolled back with Escape;
 * `formatSlider(input, value)` may name values), Mixed values that stay Mixed
 * when a person leaves them unchanged, arrow keys inside collections
 * ([data-count-one]), the "more below" fade on `scroller` (data-more-below,
 * default the root) and onScrubHint(text) once on the first focus of a
 * scrub-able field. Everything else stays with the app's delegated handlers
 * and PropertyControls. Returns {sync, destroy}: call sync() after each render.
 */
export function installInspectorKit(root, {memory, onToggle, onScrubHint, t, formatSlider, scroller = root} = {}) {
  if (!root?.addEventListener) throw messageError(new TypeError(''), "errors.inspectorKit.theInspectorKitNeedsARootElement", {});
  const doc = root.ownerDocument, view = doc.defaultView ?? globalThis, abort = new AbortController(), {signal} = abort;
  let hinted = typeof onScrubHint !== 'function';
  const fade = () => {
    if (!scroller?.toggleAttribute) return;
    const more = hasMoreBelow(scroller);
    if (scroller.hasAttribute('data-more-below') !== more) scroller.toggleAttribute('data-more-below', more);
  };
  const slide = input => syncSlider(input, formatSlider);
  const isSlider = target => target?.classList?.contains('ui-slider') && root.contains(target);

  root.addEventListener('click', event => {
    const toggle = event.target.closest?.('.ui-section-toggle[data-section-toggle]');
    if (toggle && root.contains(toggle)) {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setSectionOpen(toggle, open);
      const kind = toggle.dataset.sectionKind, id = toggle.dataset.sectionToggle, auto = toggle.hasAttribute('data-auto');
      memory?.toggle(kind, id, open, {auto});
      onToggle?.({kind, id, open, auto});
      fade();
      return;
    }
    const step = event.target.closest?.('[data-kit-step]');
    if (step && root.contains(step) && !step.disabled) stepInput(step);
  }, {signal});
  // Capture on the document runs before PropertyControls' capture listeners on
  // the root, which stop input and key events for the properties they handle.
  doc.addEventListener('input', event => {
    const input = event.target;
    if (isSlider(input)) slide(input);
    else if (input?.matches?.('.ui-stepper-input') && root.contains(input)) syncStepButtons(input.closest('.ui-stepper'));
  }, {capture: true, signal});
  // Keyboard steps and Escape rollback change a keyed slider's value without an
  // input event, after these listeners: read it once the event is done.
  for (const type of ['keydown', 'keyup']) {
    doc.addEventListener(type, event => { if (isSlider(event.target)) view.setTimeout(() => slide(event.target), 0); }, {capture: true, signal});
  }
  root.addEventListener('property-edit-end', event => {
    for (const input of root.querySelectorAll('input.ui-slider[data-property]')) if (input.dataset.property === event.detail?.key) slide(input);
  }, {signal});
  // A Mixed value stays Mixed when a person leaves it unchanged: PropertyControls
  // writes the model value back at rest (a microtask after its focusout).
  root.addEventListener('focusout', event => {
    const input = event.target;
    if (!input?.matches?.('input[data-mixed]') || !root.contains(input)) return;
    const restore = () => {
      if (doc.activeElement !== input && Number(input.dataset.propertyValue) === Number(input.dataset.mixed)) input.value = '';
    };
    restore();
    view.queueMicrotask(restore);
  }, {signal});
  // Collections are one tab stop; the arrow keys, Home and End move inside.
  root.addEventListener('keydown', event => {
    const collection = event.target.closest?.('[data-count-one]');
    if (!collection || !root.contains(collection) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = [...collection.children].filter(item => item.matches('button, input'));
    const index = items.indexOf(event.target);
    if (index < 0) return;
    const next = nextRovingIndex(event.key, index, items.length, {orientation: 'both', skip: i => items[i].disabled});
    if (next === null || next === index) return;
    event.preventDefault();
    items.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1; });
    items[next].focus();
  }, {signal});
  root.addEventListener('focusin', event => {
    if (hinted) return;
    const row = event.target.closest?.('[data-property-row]');
    if (!row || !root.contains(row) || !row.querySelector('[data-property-scrub]')) return;
    hinted = true;
    onScrubHint(say({t}, 'inspector.scrubHint'));
  }, {signal});
  scroller?.addEventListener?.('scroll', fade, {passive: true, signal});
  const resize = view.ResizeObserver && scroller ? new view.ResizeObserver(fade) : null;
  resize?.observe(scroller);
  signal.addEventListener('abort', () => resize?.disconnect(), {once: true});
  fade();
  return {sync: fade, destroy: () => abort.abort()};
}
