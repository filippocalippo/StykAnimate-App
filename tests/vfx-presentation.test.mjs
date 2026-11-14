import test from 'node:test';
import assert from 'node:assert/strict';
import english from '../src/locales/en.mjs';
import {VFX_REGISTRY, isGeneratorType} from '../src/vfx-registry.mjs';
import {VFX_PRESETS} from '../src/vfx-presets.mjs';
import {createVfx} from '../src/vfx.mjs';
import {
  CATALOGUE, PRESENTATION, SECTION_IDS, catalogueKey, catalogueSections, controlFor, helpKey, isMoment, labelKey, optionLabel, optionRetired,
  presentEffect, presetTiming, secondaryCount, sectionKey, seeded, singleSection,
} from '../src/vfx-presentation.mjs';

// How the effects panel presents each effect (src/vfx-presentation.mjs): every saved value keeps a home, nothing a
// person cannot use is shown, and every value says what it does.

/** The saved parameters an item edits. */
const paramsOf = item => (item.kind === 'pair' ? item.items.map(member => member.param) : item.kind === 'derived' ? item.params : item.kind === 'aim' ? ['aimX', 'aimY'] : [item.param]);
const itemsOf = view => [...view.primary, ...view.sections.flatMap(section => section.items)];
const defaults = type => createVfx(type, 'e1').params;

test('every value an effect saves has exactly one home, on a figure and on the scene, alone or in a group', () => {
  for (const type of Object.keys(VFX_REGISTRY)) {
    for (const scene of [false, true]) for (const group of [false, true]) {
      const params = defaults(type), view = presentEffect(type, params, {scene, group});
      // A shadow's distance and angle are views of its offsets (never saved), which keep their own home under Offset.
      const shown = itemsOf(view).filter(item => item.kind !== 'derived').flatMap(paramsOf);
      assert.equal(new Set(shown).size, shown.length, `${type}: a value shows twice (${shown})`);
      // Every value that does something here is reachable: what is left out is hidden, scene-only off the scene, or waits on a choice.
      for (const [param, d] of Object.entries(VFX_REGISTRY[type].params)) {
        if (shown.includes(param) || d.hidden || (d.sceneOnly && !scene) || ['aimUid', 'aimHandle'].includes(param)) continue;
        const waits = d.when || PRESENTATION[type]?.params?.[param]?.when || Object.values(PRESENTATION[type]?.pairs ?? {}).some(pair => pair.params.includes(param) && pair.when) || Object.values(PRESENTATION[type]?.pairs ?? {}).some(pair => pair.link === param);
        assert.ok(waits, `${type}.${param} has no home (scene ${scene}, group ${group})`);
      }
    }
  }
});

test('an open effect leads with the few values that define it, the rest in titled sections', () => {
  for (const type of Object.keys(VFX_REGISTRY)) {
    const view = presentEffect(type, defaults(type), {scene: false});
    assert.ok(view.primary.length >= 1 && view.primary.length <= 6, `${type} shows ${view.primary.length} values first`);
    for (const section of view.sections) {
      assert.ok(SECTION_IDS.includes(section.id), `${type}: unknown section ${section.id}`);
      assert.ok(Object.hasOwn(english, sectionKey(section.id)), `${type}: section ${section.id} has no title`);
      assert.ok(section.items.length > 0);
    }
  }
  // Particles: what they look like, how many and how big; motion, life and the rest wait under their titles.
  const particles = presentEffect('particles', defaults('particles'));
  assert.deepEqual(particles.primary.flatMap(paramsOf), ['look', 'color', 'emission', 'rate', 'size']);
  assert.deepEqual(particles.sections.map(section => section.id), ['motion', 'life', 'look', 'emitter', 'rhythm', 'variation']);
  // Glow: its colour, size, brightness and placement, then strength; the rest in one section.
  const glow = presentEffect('glow', defaults('glow'));
  assert.deepEqual(glow.primary.flatMap(paramsOf), ['color', 'radius', 'intensity', 'mode', 'effectStrength']);
  assert.deepEqual(glow.sections.map(section => section.id), ['more']);
  assert.deepEqual(glow.sections[0].items.flatMap(paramsOf), ['coreMix', 'spread', 'falloff', 'blend']);
});

test('a small effect keeps its secondary values in one section; titled sections are for the large ones', () => {
  for (const type of Object.keys(VFX_REGISTRY)) {
    const view = presentEffect(type, defaults(type), {group: true}), large = secondaryCount(type) > 7;
    assert.equal(singleSection(type), !large, type);
    if (!large) assert.ok(view.sections.length <= 1 && (view.sections[0]?.id ?? 'more') === 'more', `${type} opens one section`);
    else assert.ok(view.sections.length > 1, `${type} groups its many values under titles`);
  }
  // Every filter is small, every generated effect large, counting the values still arriving.
  for (const type of Object.keys(VFX_REGISTRY)) assert.equal(singleSection(type), !isGeneratorType(type), type);
  // Shadow's one section reads in a sensible order: placement and spread, then the exact offsets, then its strength in a group.
  assert.deepEqual(presentEffect('shadow', defaults('shadow'), {group: true}).sections[0].items.flatMap(paramsOf), ['mode', 'spread', 'offsetX', 'offsetY', 'effectStrength']);
});

test('a value shows only while it does something', () => {
  const particles = defaults('particles');
  const shown = (type, params, options) => itemsOf(presentEffect(type, params, options)).flatMap(paramsOf);
  assert.ok(shown('particles', particles).includes('rate') && !shown('particles', particles).includes('count'), 'a stream has a rate, not a count');
  assert.ok(shown('particles', {...particles, emission: 1}).includes('count') && !shown('particles', {...particles, emission: 1}).includes('rate'));
  assert.ok(!shown('particles', particles).includes('radius'), 'a point emitter has no size');
  assert.ok(shown('particles', {...particles, shape: 1}).includes('radius'));
  assert.ok(!shown('particles', particles).includes('x'), 'a figure\'s particles have no stage position');
  assert.ok(shown('particles', particles, {scene: true}).includes('x'));
  assert.ok(!shown('glow', defaults('glow')).includes('coreColor'), 'the core colour waits for a core');
  assert.ok(shown('glow', {...defaults('glow'), coreMix: 0.3}).includes('coreColor'));
  assert.ok(!shown('blur', defaults('blur')).includes('angle') && shown('blur', {...defaults('blur'), mode: 1}).includes('angle'));
  // A group's strength is the clip's: a member's own waits in its section; a lone filter shows it last.
  const lone = presentEffect('glow', defaults('glow')), member = presentEffect('glow', defaults('glow'), {group: true});
  assert.equal(lone.primary.at(-1).param, 'effectStrength');
  assert.ok(!member.primary.some(item => item.param === 'effectStrength') && member.sections.find(section => section.id === 'more').items.some(item => item.param === 'effectStrength'));
});

test('a parameter the presentation does not know still appears, with a control from its descriptor', () => {
  const registry = {...VFX_REGISTRY, glow: {...VFX_REGISTRY.glow, params: {...VFX_REGISTRY.glow.params,
    shimmer: {label: 'Shimmer', default: 0, min: 0, max: 1, step: 0.01, unit: '%', type: 'number'},
    sparkle: {label: 'Sparkle', default: 0, min: 0, max: 1, step: 1, type: 'number', discrete: true, options: ['Off', 'On'], toggle: true},
    tone: {label: 'Tone', default: 1, min: 0, max: 5, step: 1, type: 'number', discrete: true, options: ['A', 'B', 'C', {label: 'D', retired: true}, 'E', 'F']}}}};
  const view = presentEffect('glow', {...defaults('glow'), shimmer: 0, sparkle: 0, tone: 1}, {registry});
  const more = view.sections.find(section => section.id === 'more');
  assert.deepEqual(more.items.slice(-3).map(item => [item.param, item.control]), [['shimmer', 'value'], ['sparkle', 'switch'], ['tone', 'menu']]);
  assert.equal(view.sections.at(-1).id, 'more', 'new values wait at the end, under More settings');
  // Options may be strings or {label, retired}: a retired one is read and drawn, not offered.
  const tone = registry.glow.params.tone;
  assert.equal(optionLabel(tone, 3), 'D');
  assert.ok(optionRetired(tone, 3) && !optionRetired(tone, 2));
  assert.ok(optionRetired({options: ['A', 'B'], retired: [1]}, 1));
});

test('controls follow what a value is: colours, switches, choices, angles, sliders and typed numbers', () => {
  const p = VFX_REGISTRY.particles.params;
  assert.equal(controlFor(VFX_REGISTRY.glow.params.color), 'color');
  assert.equal(controlFor(p.ground), 'switch');
  assert.equal(controlFor(p.emission), 'segments');
  assert.equal(controlFor(p.rotation), 'menu');
  assert.equal(controlFor(p.direction), 'angle');
  assert.equal(controlFor(p.size), 'value');
  assert.equal(controlFor(p.seed), 'number', 'a seed is typed, never slid');
  assert.equal(controlFor(VFX_REGISTRY.noise.params.phase), 'number', 'a range of a million is typed and scrubbed');
  const look = presentEffect('particles', defaults('particles')).primary.find(item => item.param === 'look');
  assert.equal(look.control, 'picker');
  const count = presentEffect('particles', {...defaults('particles'), emission: 1}).primary.find(item => item.param === 'count');
  assert.equal(count.scale, 'log', 'a count of 1 to 5000 gives the small counts most of the travel');
});

test('every value has a name and a one-line description', () => {
  for (const [type, definition] of Object.entries(VFX_REGISTRY)) {
    for (const [param, d] of Object.entries(definition.params)) {
      if (d.hidden) continue;
      const label = labelKey(type, param), help = helpKey(type, param);
      assert.ok(label && Object.hasOwn(english, label), `${type}.${param} has no name`);
      assert.ok(help && Object.hasOwn(english, help), `${type}.${param} has no description`);
      assert.ok(english[help].length <= 120 && english[help].endsWith('.'), `${type}.${param}: one sentence`);
    }
    assert.ok(Object.hasOwn(english, `vfxPanel.about.${type}`), `${type} says what it does in the catalogue`);
  }
  // The audit's unclear names are clear now.
  assert.equal(english[labelKey('particles', 'space')], 'Movement');
  assert.equal(english[labelKey('smoke', 'space')], 'Movement');
  assert.equal(english[labelKey('aura', 'flames')], 'Main aura');
  assert.equal(english[labelKey('aura', 'embers')], 'Floating particles');
  assert.equal(english[labelKey('grade', 'tint')], 'Green–magenta');
});

test('the catalogue groups effects by what they do, the most used first, and loses none', () => {
  const sections = catalogueSections(() => true);
  assert.deepEqual(sections.map(section => section.id), ['generate', 'outline', 'color', 'distort', 'texture']);
  assert.deepEqual(sections[1].types, ['glow', 'outline', 'shadow'], 'outline and shadow are with glow, not under Light');
  assert.equal(sections[3].types[0], 'blur', 'the distort group opens with blur, not the most obscure filter');
  assert.deepEqual(new Set(sections.flatMap(section => section.types)), new Set(Object.keys(VFX_REGISTRY)));
  for (const section of CATALOGUE) assert.ok(Object.hasOwn(english, catalogueKey(section.id)));
  assert.ok(sections[0].stills && sections[0].types.every(isGeneratorType));
  // A type the registry gains later is never lost: it joins More effects.
  const later = catalogueSections(() => true, {...VFX_REGISTRY, glint: {name: 'Glint', category: 'Light', params: {}}});
  assert.deepEqual(later.at(-1), {id: 'more', types: ['glint']});
  assert.deepEqual(catalogueSections(type => type !== 'vignette' && !VFX_REGISTRY[type].scene).flatMap(section => section.types).includes('crt'), false);
});

test('a preset is a moment with a length or a lasting look; its own timing wins once it has one', () => {
  assert.ok(isMoment('Hit flash', VFX_PRESETS['Hit flash']));
  assert.ok(!isMoment('Neon', VFX_PRESETS.Neon));
  assert.deepEqual(presetTiming('Hit flash', VFX_PRESETS['Hit flash']), {duration: 4, fadeIn: 0, fadeOut: 3});
  assert.equal(presetTiming('Neon', VFX_PRESETS.Neon), null, 'a look lasts the whole animation');
  // When the engine's presets carry timing (a later task), that timing is used, and such a preset counts as a moment.
  assert.deepEqual(presetTiming('Hit flash', {...VFX_PRESETS['Hit flash'], duration: 2, fadeOut: 1}), {duration: 2, fadeIn: 0, fadeOut: 1});
  assert.ok(isMoment('Shockwave burst', {effects: [], duration: 12}));
  for (const name of Object.keys(VFX_PRESETS)) assert.equal(typeof isMoment(name, VFX_PRESETS[name]), 'boolean');
});

test('every seeded effect can be shuffled', () => {
  for (const type of ['noise', 'dissolve', 'turbulence', 'particles', 'aura', 'beam', 'smoke', 'explosion']) assert.ok(seeded(type), type);
  assert.ok(!seeded('glow'));
});

test('a choice too long for a native menu in the person\'s language opens a menu from a field whose words wrap', async () => {
  const {choiceHTML} = await import('../src/vfx-effect-view.mjs');
  const row = (labels, extra = {}) => ({kind: 'select', id: 'vfx-field-a', label: 'Draw', value: 1, data: {'vfx-choice': 'a'}, options: labels.map((label, value) => ({value, label})), ...extra});
  const short = choiceHTML(row(['Behind', 'In front']));
  assert.match(short, /^<label[^>]*class="ui-field"[^>]*data-select/, 'short words keep the native menu');
  assert.doesNotMatch(short, /data-vfx-menu-for/);
  // A longer language (the localization's long-text mode gives about this) or a long option.
  const long = choiceHTML(row(['［Bëhïnd tárgët ————］', '［Ïn frônt ôf tárgët ————————］']));
  assert.match(long, /<button[^>]*data-picker[^>]*aria-haspopup="menu"[^>]*data-vfx-menu-for="vfx-field-a"/, 'a field button that opens a menu');
  assert.match(long, /<span class="ui-field-choice"><span class="ui-field-hex">［Ïn frônt ôf tárgët ————————］<\/span>/, 'it shows the current option whole');
  assert.doesNotMatch(long, /ui-field-art/, 'without an empty picture');
  assert.match(long, /<div hidden><label[^>]*data-select[^>]*>.*<select[^>]*id="vfx-field-a"[^>]*data-vfx-choice="a"/s, 'the select stays, hidden, so a choice takes its path');
  assert.doesNotMatch(choiceHTML(row(['［Whôlë ánïmátïôn ——————］', 'x'], {bare: true})), /ui-field-label/, 'a bare choice stays bare');
});
