/**
 * How the effects panel presents each effect (docs/VFX-DESIGN.md, "The open effect"): which few values define it and
 * in what order, the titled sections that hold the rest, which control each value gets (a slider field on its own
 * scale, an angle's dial, a choice in a field, a menu, a visual picker, a seed with its shuffle), when a value is
 * shown at all, and how the catalogue groups effects and presets.
 *
 * The registry (src/vfx-registry.mjs) owns what is saved: names, defaults, ranges, options. This module owns only
 * presentation, keyed by effect type and parameter name, and is combined with the registry's descriptors at render
 * time. A parameter it does not mention still appears: in "More settings" at the end, with a control chosen from its
 * descriptor, so parameters added to the registry later are never lost. Names this module mentions that the
 * registry does not have (yet) are skipped.
 *
 * Words: a parameter's label is `vfxPanel.label.<type>.<param>` when that message exists (a clearer name than the
 * registry's), else the registry's own; its one-line description is `vfxPanel.help.<type>.<param>`, else
 * `vfxPanel.help.common.<param>`. Section titles are `vfxPanel.section.<id>`.
 */
import english from './locales/en.mjs';
import {VFX_REGISTRY} from './vfx-registry.mjs';
import {effectMessages} from './vfx-localization.mjs';

const has = key => Object.hasOwn(english, key);

// Shared parts. `when` shows a value only while it does something: {param: [values]} or (params) => boolean.
// A generated effect's own clock: when it starts in its clip, its drawing rhythm and (coming) how fast it plays,
// `timeScale` on all five. Particles call their launch speed `speed`, so only the others may list it here.
const GENERATOR_TIMING = ['delay', 'step', 'timeScale', 'speed', 'timeSpeed'];
const PARTICLE_TIMING = ['delay', 'step', 'timeScale', 'timeSpeed'];
const VARIATION = ['seed'];
const SCENE_POSITION = ['x', 'y'];

/** Per effect type: `primary` (three to five values, in the order a person thinks of them), `sections` ([id, params]),
 * and per parameter: `control`, `scale` (log, pow), `knee`, `exponent`, `unit` (shown), `when`. */
export const PRESENTATION = Object.freeze({
  glow: {
    primary: ['color', 'source', 'radius', 'intensity', 'mode'],
    sections: [['core', ['coreMix', 'coreColor']], ['shape', ['spread', 'falloff']], ['blend', ['blend', 'effectStrength']]],
    params: {color: {when: {source: [0]}}, radius: {scale: 'pow'}, spread: {scale: 'pow'}, coreColor: {when: p => p.coreMix > 0}},
  },
  outline: {
    primary: ['color', 'width', 'softness', 'mode'],
    sections: [['style', ['opacity', 'rounded', 'only']], ['blend', ['effectStrength']]],
    params: {width: {scale: 'pow'}},
  },
  shadow: {
    primary: ['color', 'distance', 'angle', 'radius', 'opacity'], strength: false,
    sections: [['style', ['mode', 'spread']], ['offset', ['offsetX', 'offsetY']], ['blend', ['effectStrength']]],
    params: {radius: {scale: 'pow'}, spread: {scale: 'pow'}},
    // Distance and angle are views of the saved offsets (never stored): they write offsetX and offsetY together.
    derived: {distance: {params: ['offsetX', 'offsetY'], min: 0, max: 256, step: 1, unit: 'px', default: Math.hypot(8, 8)}, angle: {params: ['offsetX', 'offsetY'], min: -180, max: 180, step: 1, unit: '°', default: 45, control: 'angle'}},
  },
  blur: {
    primary: ['mode', 'radius', 'angle', 'center'],
    sections: [['blend', ['effectStrength']]],
    params: {mode: {control: 'menu'}, radius: {scale: 'pow'}},
    pairs: {center: {params: ['centerX', 'centerY'], when: {mode: [2, 3]}}},
  },
  tint: {
    primary: ['color', 'blend', 'mix'], strength: false,
    sections: [['blend', ['effectStrength']]],
  },
  grade: {
    primary: ['exposure', 'contrast', 'saturation', 'temperature', 'hue'],
    sections: [['balance', ['tint', 'shadows', 'highlights', 'gamma']], ['blend', ['effectStrength']]],
  },
  pixelate: {
    primary: ['cell'],
    sections: [['grid', ['grid']], ['blend', ['effectStrength']]],
    params: {size: {scale: 'pow'}, sizeY: {scale: 'pow'}},
    pairs: {cell: {params: ['size', 'sizeY'], link: 'linked'}, grid: {params: ['offsetX', 'offsetY']}},
  },
  noise: {
    primary: ['amount', 'size', 'pattern', 'colored', 'speed'],
    sections: [['detail', ['contrast', 'softness']], ['variation', ['phase', 'seed']], ['blend', ['effectStrength']]],
    params: {size: {scale: 'pow'}},
  },
  vignette: {
    primary: ['amount', 'softness', 'color', 'radius'],
    sections: [['shape', ['roundness', 'aspect', 'center']], ['blend', ['effectStrength']]],
    pairs: {center: {params: ['centerX', 'centerY']}},
  },
  dissolve: {
    primary: ['progress', 'size', 'edge', 'color'],
    sections: [['direction', ['directional', 'angle']], ['edge', ['softness']], ['variation', ['seed']], ['blend', ['effectStrength']]],
    params: {angle: {when: {directional: [1]}}, softness: {unit: '%'}, size: {scale: 'pow'}},
  },
  rgbSplit: {
    primary: ['amount', 'angle'],
    sections: [['channels', ['red', 'green', 'blue']], ['blend', ['effectStrength']]],
    params: {amount: {scale: 'pow'}},
  },
  wave: {
    primary: ['strength', 'wavelength', 'angle', 'speed'],
    sections: [['phase', ['phase']], ['blend', ['effectStrength']]],
    params: {strength: {scale: 'pow'}, wavelength: {scale: 'pow'}},
  },
  shockwave: {
    primary: ['radius', 'thickness', 'strength'],
    sections: [['shape', ['center', 'falloff']], ['blend', ['effectStrength']]],
    params: {radius: {scale: 'pow'}, thickness: {scale: 'pow'}},
    pairs: {center: {params: ['centerX', 'centerY']}},
  },
  bloom: {
    primary: ['threshold', 'intensity', 'radius', 'color'],
    sections: [['shape', ['softness']], ['blend', ['effectStrength']]],
    params: {radius: {scale: 'pow'}},
  },
  lightSweep: {
    primary: ['position', 'angle', 'width', 'intensity', 'color'],
    sections: [['motion', ['speed', 'loop']], ['shape', ['softness']], ['blend', ['effectStrength']]],
  },
  crt: {
    primary: ['amount', 'spacing', 'curvature'],
    sections: [['color', ['chromatic', 'color']], ['motion', ['roll', 'phase']], ['blend', ['effectStrength']]],
  },
  turbulence: {
    primary: ['amount', 'size', 'speed', 'detail'],
    sections: [['variation', ['evolution', 'seed']], ['blend', ['effectStrength']]],
    params: {amount: {scale: 'pow'}, size: {scale: 'pow'}, detail: {control: 'segments'}},
  },
  particles: {
    primary: ['look', 'color', 'emission', 'rate', 'count', 'size'],
    sections: [
      ['motion', ['speed', 'direction', 'spread', 'gravity', 'gravityAngle', 'drag', 'wind', 'turbulence', 'flow', 'swirl']],
      ['life', ['life', 'sizeMode', 'endSize', 'fade', 'opacityMode', 'opacityOverLife', 'twinkle']],
      ['look', ['rotation', 'spin', 'stretch', 'shading', 'glow', 'trail', 'outline', 'outlineColor', 'outlineWidth', 'colorMode', 'variation', 'blend', 'effectStrength']],
      ['emitter', ['shape', 'radius', 'space', 'ground', 'bounce', 'layer', 'position']],
      ['rhythm', PARTICLE_TIMING],
      ['variation', VARIATION],
    ],
    params: {
      look: {control: 'picker'}, rate: {scale: 'pow', exponent: 2.5}, count: {scale: 'log', knee: 1}, size: {scale: 'log', knee: 1}, speed: {scale: 'pow'},
      life: {scale: 'pow'}, radius: {scale: 'log', knee: 2, when: {shape: [1, 3]}}, turbulence: {scale: 'pow'}, flow: {scale: 'pow'},
      gravity: {unit: 'px/f²'}, delay: {scale: 'pow'}, trail: {control: 'segments'}, endSize: {scale: 'pow'},
    },
    pairs: {position: {params: SCENE_POSITION}},
  },
  aura: {
    primary: ['style', 'color', 'intensity', 'height', 'width'],
    sections: [
      ['shape', ['density', 'turbulence', 'layer', 'placement']],
      ['layers', ['flames', 'glow', 'embers', 'trail', 'dust']],
      ['blend', ['blend', 'effectStrength']],
      ['rhythm', GENERATOR_TIMING],
      ['variation', VARIATION],
    ],
    params: {style: {control: 'picker'}},
  },
  beam: {
    primary: ['style', 'color', 'width', 'aim', 'intensity'],
    sections: [
      ['motion', ['charge', 'travel', 'wobble']],
      ['details', ['arcs', 'sparks', 'chargeParticles', 'orb', 'splash']],
      ['emitter', ['layer', 'position']],
      ['blend', ['blend', 'effectStrength']],
      ['rhythm', GENERATOR_TIMING],
      ['variation', VARIATION],
    ],
    params: {style: {control: 'picker'}, width: {scale: 'pow'}, charge: {scale: 'pow'}},
    pairs: {position: {params: SCENE_POSITION}},
  },
  smoke: {
    primary: ['style', 'color', 'amount', 'size', 'rise'],
    sections: [
      ['motion', ['wind', 'direction', 'turbulence', 'growth']],
      ['life', ['life', 'opacity', 'shading']],
      ['emitter', ['emission', 'count', 'spread', 'space', 'layer', 'position']],
      ['blend', ['blend', 'effectStrength']],
      ['rhythm', GENERATOR_TIMING],
      ['variation', VARIATION],
    ],
    params: {style: {control: 'picker'}, amount: {scale: 'pow'}, size: {scale: 'log', knee: 2}, life: {scale: 'pow'}, spread: {scale: 'log', knee: 2}, count: {scale: 'log', knee: 1}},
    pairs: {position: {params: SCENE_POSITION}},
  },
  explosion: {
    primary: ['style', 'color', 'size', 'intensity'],
    sections: [
      ['parts', ['density', 'debris', 'smoke', 'sparks', 'dust', 'flash', 'ring', 'fireball']],
      ['emitter', ['layer', 'position']],
      ['blend', ['blend', 'effectStrength']],
      ['rhythm', GENERATOR_TIMING],
      ['variation', VARIATION],
    ],
    params: {style: {control: 'picker'}},
    pairs: {position: {params: SCENE_POSITION}},
  },
});

/** Names every type's section can take, in the order sections are drawn; `more` holds what this module does not name. */
export const SECTION_IDS = Object.freeze(['core', 'shape', 'style', 'offset', 'balance', 'grid', 'detail', 'direction', 'edge', 'channels', 'phase',
  'color', 'motion', 'life', 'look', 'layers', 'parts', 'details', 'emitter', 'blend', 'rhythm', 'variation', 'more']);

const optionCount = d => (Array.isArray(d.options) ? d.options.length : 0);
/** An option's label: the registry may hold strings or {label, retired} objects. */
export const optionLabel = (d, index) => {
  const option = d.options?.[index];
  return typeof option === 'string' ? option : option?.label ?? String(index);
};
/** Whether an option is retired: still read and drawn for old projects, no longer offered (`retired` on the
 * descriptor as a list of indexes, or on the option itself). */
export const optionRetired = (d, index) => Boolean(d.retired?.includes?.(index) || d.options?.[index]?.retired);

/** Whether `when` holds for these parameter values. */
export function shown(when, params) {
  if (!when) return true;
  if (typeof when === 'function') return Boolean(when(params));
  return Object.entries(when).every(([key, values]) => params[key] === undefined || values.includes(params[key]));
}

/** The control a value gets: from this module, else chosen from its descriptor. */
export function controlFor(d, presentation = {}) {
  if (presentation.control) return presentation.control;
  if (d.type === 'color') return 'color';
  if (d.toggle) return 'switch';
  if (d.options) return optionCount(d) <= 3 && d.options.every((_, i) => optionLabel(d, i).length <= 12) ? 'segments' : 'menu';
  if (d.unit === '°' && d.min === -180 && d.max === 180) return 'angle';
  if (d.discrete) return 'number';
  // A range far wider than anyone drags (an evolution of ±10000, a phase of a million) is typed and scrubbed, not slid.
  if (Number.isFinite(d.min) && Number.isFinite(d.max) && (d.max - d.min) / (d.step || 1) <= 200000) return 'value';
  return 'number';
}

/** The message key of a parameter's label, its description (or null) and a section's title. */
export function labelKey(type, param) {
  const own = `vfxPanel.label.${type}.${param}`;
  if (has(own)) return own;
  return effectMessages[type]?.params?.[param]?.labelKey ?? (has(`vfxPanel.label.common.${param}`) ? `vfxPanel.label.common.${param}` : null);
}
export function helpKey(type, param) {
  for (const key of [`vfxPanel.help.${type}.${param}`, `vfxPanel.help.common.${param}`]) if (has(key)) return key;
  if (param === 'effectStrength') return VFX_REGISTRY[type]?.generator ? 'vfxPanel.help.common.opacity' : 'vfxPanel.help.common.effectStrength';
  return null;
}
export const sectionKey = id => `vfxPanel.section.${id}`;

/**
 * One effect as the panel shows it: {primary: [item], sections: [{id, items}]}. An item is
 * {kind: 'param', param, d, control, …presentation} for a saved value, {kind: 'derived', name, …} for a view of
 * saved values (a shadow's distance), {kind: 'pair', name, params, link} for two values side by side, or
 * {kind: 'aim'} for a beam's target. Values that do nothing for these settings are left out (`when`, a scene-only
 * value off the scene, hidden values), and so is a group member's strength from the primary values.
 */
export function presentEffect(type, params, {scene = false, group = false, registry = VFX_REGISTRY} = {}) {
  const definition = registry[type];
  if (!definition) return {primary: [], sections: []};
  const own = PRESENTATION[type] ?? {primary: [], sections: []}, ownParams = own.params ?? {}, pairs = own.pairs ?? {}, derived = own.derived ?? {};
  const descriptors = definition.params, used = new Set(['aimUid', 'aimHandle']);
  const usable = param => {
    const d = descriptors[param];
    return d && !d.hidden && (!d.sceneOnly || scene) && shown(d.when, params) && shown(ownParams[param]?.when, params);
  };
  const item = name => {
    if (name === 'aim') {
      if (type !== 'beam' || !descriptors.aimX) return null;
      used.add('aimX'); used.add('aimY');
      return {kind: 'aim', name};
    }
    if (derived[name]) {
      if (!derived[name].params.every(param => descriptors[param])) return null;
      return {kind: 'derived', name, ...derived[name], control: derived[name].control ?? 'value'};
    }
    if (pairs[name]) {
      const pair = pairs[name], members = pair.params.filter(param => descriptors[param]);
      members.forEach(param => used.add(param));
      if (pair.link && descriptors[pair.link]) used.add(pair.link);
      if (!shown(pair.when, params)) return null;
      const visible = members.filter(usable);
      if (!visible.length) return null;
      return {kind: 'pair', name, params: visible, link: pair.link && descriptors[pair.link] ? pair.link : null,
        items: visible.map(param => ({kind: 'param', param, d: descriptors[param], ...ownParams[param], control: controlFor(descriptors[param], ownParams[param])}))};
    }
    const d = descriptors[name];
    // A value has one home: the first place that names it.
    if (!d || used.has(name)) return null;
    used.add(name);
    if (!usable(name)) return null;
    return {kind: 'param', param: name, d, ...ownParams[name], control: controlFor(d, ownParams[name])};
  };
  // A lone filter's strength is its last value; a group's strength is the clip's, so a member's own waits in its Blend
  // section, as does a generated effect's opacity and the strength of a filter whose own amount already says it.
  const primaryNames = [...own.primary, ...(group || definition.generator || own.strength === false ? [] : ['effectStrength'])];
  const primary = primaryNames.map(item).filter(Boolean);
  const sections = (own.sections ?? []).map(([id, names]) => ({id, items: names.filter(name => !primaryNames.includes(name)).map(item).filter(Boolean)}));
  // Anything this module does not name, in the registry's order: never lost.
  const rest = Object.keys(descriptors).filter(param => !used.has(param) && !primaryNames.includes(param) && !(own.sections ?? []).some(([, names]) => names.includes(param)));
  sections.push({id: 'more', items: rest.map(item).filter(Boolean)});
  // A small effect (its secondary values, those arriving included, number about six or fewer) keeps them all in one
  // section, in the order its sections list them: three disclosure rows to reach four values read as clutter. Titled
  // sections are for the large effects (the generated ones).
  if (singleSection(type)) return {primary, sections: [{id: 'more', items: sections.flatMap(section => section.items)}].filter(section => section.items.length)};
  // One section per id, in the panel's order, without empty ones.
  const merged = new Map();
  for (const section of sections) merged.set(section.id, [...(merged.get(section.id) ?? []), ...section.items]);
  return {primary, sections: [...merged].filter(([, items]) => items.length).map(([id, items]) => ({id, items}))
    .sort((a, b) => SECTION_IDS.indexOf(a.id) - SECTION_IDS.indexOf(b.id))};
}

/** How many secondary values an effect's sections name, counting those still arriving in the registry. */
const SINGLE_SECTION_LIMIT = 7;
export function secondaryCount(type) {
  const own = PRESENTATION[type];
  if (!own) return 0;
  const size = name => own.pairs?.[name]?.params.length ?? own.derived?.[name]?.params.length ?? 1;
  return (own.sections ?? []).flatMap(([, names]) => names).filter(name => !own.primary.includes(name)).reduce((n, name) => n + size(name), 0);
}
/** Whether an effect shows its secondary values in one section rather than titled ones. */
export const singleSection = type => (PRESENTATION[type]?.titled ?? secondaryCount(type) > SINGLE_SECTION_LIMIT) === false;

/** Whether an effect type has a seed that Shuffle draws again. */
export const seeded = type => Boolean(VFX_REGISTRY[type]?.params.seed);

// ---------------------------------------------------------------------------
// The catalogue: effects grouped by what they do, the ones a stick-figure animator reaches for first.

/** Effect sections in catalogue order; generated effects show rendered stills. Types the registry gains later join
 * `more`. */
export const CATALOGUE = Object.freeze([
  {id: 'generate', types: ['particles', 'explosion', 'beam', 'aura', 'smoke'], stills: true},
  {id: 'outline', types: ['glow', 'outline', 'shadow']},
  {id: 'color', types: ['tint', 'grade', 'bloom', 'lightSweep', 'vignette']},
  {id: 'distort', types: ['blur', 'rgbSplit', 'wave', 'shockwave', 'turbulence', 'dissolve']},
  {id: 'texture', types: ['noise', 'pixelate', 'crt']},
]);
export const catalogueKey = id => `vfxPanel.catalog.${id}`;
/** The catalogue's effect sections with what `available(type)` allows, unknown types last. */
export function catalogueSections(available, registry = VFX_REGISTRY) {
  const named = new Set(CATALOGUE.flatMap(section => section.types));
  const sections = CATALOGUE.map(section => ({...section, types: section.types.filter(type => registry[type] && available(type))}));
  const extra = Object.keys(registry).filter(type => !named.has(type) && available(type));
  if (extra.length) sections.push({id: 'more', types: extra});
  return sections.filter(section => section.types.length);
}

/** Presets that are a moment rather than a lasting look (a flash, a hit, a vanishing): the catalogue lists them apart. */
export const MOMENT_PRESETS = Object.freeze(['Hit flash', 'Impact', 'Teleport']);
/**
 * Until built-in presets carry their own timing (a later engine task: `duration`, `fadeIn`, `fadeOut` and keys on
 * the preset, applied by addVfxGroup), a moment is placed at the playhead for this many frames with these fades.
 * A preset that carries timing uses its own, and a clip the engine already timed is left as it is.
 */
export const MOMENT_TIMING = Object.freeze({'Hit flash': {duration: 4, fadeIn: 0, fadeOut: 3}, 'Impact': {duration: 6, fadeIn: 0, fadeOut: 4}, 'Teleport': {duration: 16, fadeIn: 4, fadeOut: 8}});
/** A preset's timing: its own when it has one, else a moment's, else null (it lasts the whole animation). */
export function presetTiming(name, preset) {
  const own = preset && Number.isInteger(preset.duration) && preset.duration > 0 ? {duration: preset.duration, fadeIn: preset.fadeIn ?? 0, fadeOut: preset.fadeOut ?? 0} : null;
  return own ?? MOMENT_TIMING[name] ?? null;
}
export const isMoment = (name, preset) => MOMENT_PRESETS.includes(name) || Boolean(presetTiming(name, preset) && !MOMENT_TIMING[name]);
