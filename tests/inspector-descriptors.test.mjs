/**
 * The inspector's contexts (src/inspector-view.mjs), revision 4. Nothing is
 * lost: in 64 states, every control today's inspector offers
 * (tests/fixtures/inspector-legacy.mjs, verbatim at 64646330 and 52f13960)
 * is still there with its identity (its id, property, action, name or data
 * hooks): in the context's sections, in its header (the quick actions, the
 * rename in place) or, for the few it moves, at the home listed in MOVED. The
 * key controls keep their hooks, and every context follows revision 4's
 * layout: core sections open with at most two title actions, less used
 * settings in titled sections, the selection's commands as quick actions, no
 * key state, within the inspector's budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from '../vendor/text/opentype.mjs';
import {engineEditor, ownedEditorWithDrawings} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject, defaultFigure} from '../src/demo.mjs';
import {rigExampleDocument} from '../src/rig-examples.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {compileTextFigure} from '../src/text-authoring.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {presencePlayback} from './support/movieclip-playback.mjs';
import {inspectorDescriptor, inspectorView} from '../src/inspector-view.mjs';
import {ikSection} from '../src/ik-view.mjs';
import {ikControlsView} from './support/control-views.mjs';
import {INSPECTOR_BUDGET, MAX_TITLE_ACTIONS, ROW_KINDS, inspectorBudgetProblems, renderInspector} from '../src/inspector-kit.mjs';
import {QUICK_ACTIONS, QUICK_CONTEXTS, quickDefaults} from '../src/ui/quick-actions.mjs';
import {legacyIkControlsView, legacyInspectorView} from './fixtures/inspector-legacy.mjs';
import {interfaceLocalization} from '../src/localization.mjs';
import {
  assertNoKeyState, assertNoTitles, assertNumberParity, assertOptions, assertParity, assertSwitchParity, find, nameOf, options, tag, tags,
} from './helpers/inspector-markup.mjs';

// ---------------------------------------------------------------------------
// Nothing lost

test('gradient captions localize their type without changing the figure paint', () => {
  const editor = engineEditor();
  editor.select(editor.selectedUid, 0);
  interfaceLocalization.setPseudo('long');
  try {
    for (const type of ['linear', 'radial', 'angular', 'diamond']) {
      editor.figure.segments[0].paint = {type, angle:0, stops:[
        {offset:0, color:[0,0,0], opacity:1}, {offset:1, color:[255,255,255], opacity:1},
      ]};
      const bytes = JSON.stringify(editor.report);
      const descriptor = inspectorDescriptor({editor});
      const flatten = rows => rows.flatMap(row => [row, ...flatten(row?.rows ?? [])]);
      const rows = flatten(descriptor.sections.filter(Boolean));
      const colour = rows.find(row => row?.id === 'segment-color');
      assert.ok(colour?.caption.includes(interfaceLocalization.t('colorPicker.' + type)), type);
      assert.equal(JSON.stringify(editor.report), bytes);
    }
  } finally { interfaceLocalization.setPseudo(null); }
});

/** Attributes that name a control rather than describe its state or look. */
const PRESENTATION = /^data-(?:property-(?:value|precision|display-precision|step|row|scrub)|tooltip|hotkey-.*|section|mixed|precision|unit|value-.*|kit-step|size|variant|glue|bare|select|color|switch-field|steps|text|count-one|fill|ratio|stack-narrow|open|collapsible|auto|layer-id)$/;
const CONTROL = new Set(['input', 'select', 'button', 'textarea', 'canvas']);
/** A control's identity: its id, else its property, else its action (with a builder order's target), else its radio name and value, else its data hooks. */
function identity(entry) {
  const {attrs} = entry;
  if (attrs.id) return {id: attrs.id};
  if (attrs['data-property']) return {'data-property': attrs['data-property']};
  if (attrs['data-action']) {
    const where = {'data-action': attrs['data-action']};
    for (const name of ['data-kind', 'data-index', 'data-direction']) if (name in attrs) where[name] = attrs[name];
    return where;
  }
  if (attrs.type === 'radio' && attrs.name) return {name: attrs.name, value: attrs.value};
  const hooks = Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith('data-') && !PRESENTATION.test(name)));
  return Object.keys(hooks).length ? hooks : null;
}
const controls = html => tags(html).filter(entry => CONTROL.has(entry.tag) || 'data-inspector-owned' in entry.attrs).map(identity).filter(Boolean);

/**
 * Controls the redesign gives another home (experience.md §5.1, §8; function-ledger.md), by identity:
 * the target's name renames in the header, the selection's commands are its quick actions, a layer
 * is shown and locked from its row, and a connection's Combine shows while there is one to combine.
 */
const MOVED = [
  [where => where.id === 'figure-name' || 'data-movieclip-name' in where, (descriptor, where) =>
    (descriptor.target.rename?.id === where.id && where.id) || 'movieclip-name' in (descriptor.target.rename?.data ?? {}), 'the header renames it in place'],
  [where => ['inspector-layer-visible', 'inspector-layer-locked'].includes(where.id), () => true, 'the layer row\'s eye and lock (timeline, Layers popover)'],
  [where => where['data-action'] === 'combine-figures', (descriptor, where, now, state) => !state.connected, 'shown while the selection has a connection to combine'],
  // Revision 5: the rig tool's Drag mode is its option in the stage header (app.mjs toolOptionDescriptors), and
  // Attach image… is Build's figure tile (Image), the part's ⋯ menu and the right-click menu.
  [where => where.id === 'rig-mode', () => true, "the stage header's tool options"],
  [where => where['data-action'] === 'add-sprite-segment', () => true, "Build's Image tile and its menus"],
  // While it is being built, the figure's place among the scene's figures is Animate's (its Front and Back tiles).
  [where => ['layer-front', 'layer-back'].includes(where['data-action']), descriptor => descriptor.quick?.context === 'build', 'Animate’s figure tiles'],
  // Build's part renames in the header, and its Whole branch is the rail's and the stage header's toggle (B, or hold
  // Shift); while it is on, the scope line says so and stops it.
  [where => where.id === 'builder-joint-name', descriptor => descriptor.target.rename?.id === 'builder-joint-name', 'the header renames the part in place'],
  [where => where.id === 'builder-branch', descriptor => descriptor.quick?.context === 'part', 'the rail’s and stage header’s Whole branch'],
];
function quickIds(descriptor) {
  const context = descriptor.quick?.context;
  return context ? new Set(quickDefaults(QUICK_ACTIONS, context).map(row => row.id)) : new Set();
}
/** Every control of today's markup is in the new sections, the header or its documented new home. */
function assertNothingLost(options, label, state = {}) {
  const today = legacyInspectorView(options), now = inspectorView(options), descriptor = inspectorDescriptor(options), quick = quickIds(descriptor);
  const lost = [];
  for (const where of controls(today)) {
    if (find(now, where)) continue;
    if (where['data-action'] && quick.has(where['data-action']) && !where['data-kind']) continue;
    const moved = MOVED.find(([applies]) => applies(where));
    if (moved && moved[1](descriptor, where, now, state)) continue;
    // A context with two panes (the camera's Transform │ Motion) shows the other pane's controls one tab away, as today.
    if (state.otherPane && find(state.otherPane, where)) continue;
    lost.push(JSON.stringify(where));
  }
  assert.deepEqual(lost, [], `${label}: today's controls missing from the redesigned inspector`);
  assertDescriptor(descriptor, label);
  assertNoKeyState(now);
  return {today, now, descriptor};
}

/** Revision 4's layout rules for one context's descriptor. */
function assertDescriptor(descriptor, label) {
  assert.match(descriptor.kind, /^[a-z][a-z0-9-]*$/, `${label}: kind`);
  assert.equal(typeof descriptor.target?.name, 'string', `${label}: the header names the target`);
  assert.ok(descriptor.target.label, `${label}: #inspector-context names the kind`);
  if (descriptor.quick) assert.ok(QUICK_CONTEXTS[descriptor.quick.context], `${label}: quick actions for ${descriptor.quick.context}`);
  const ids = new Set(), kinds = new Set(ROW_KINDS);
  const visit = rows => {
    for (const row of rows ?? []) {
      if (!row) continue;
      assert.ok(kinds.has(row.kind), `${label}: row kind ${row.kind}`);
      if (row.rows) visit(row.rows);
    }
  };
  for (const section of descriptor.sections) {
    if (!section) continue;
    assert.ok(!ids.has(section.id), `${label}: duplicate section ${section.id}`);
    ids.add(section.id);
    assert.ok((section.actions ?? []).length + (section.switch ? 1 : 0) <= MAX_TITLE_ACTIONS, `${label}: ${section.id} has at most two title actions`);
    if (section.place === 'titled') assert.ok(section.title, `${label}: titled section ${section.id} says what it holds`);
    assert.doesNotMatch(section.title ?? '', /^More\b/i, `${label}: never a generic More`);
    visit(section.rows);
  }
}

const HEADER = 7;   // the header's menu button and a full quick actions row (five defaults and a pin)
const assertBudget = (descriptor, label, options = {}) => assert.deepEqual(inspectorBudgetProblems(descriptor, {headerControls: HEADER, ...options}), [], `${label} fits the budget`);
const sections = (descriptor, place) => descriptor.sections.filter(section => section && !section.hidden && (section.place ?? 'core') === place).map(section => section.id);


const fonts = await Promise.all(['Regular'].map(async style => {
  const bytes = readFileSync(new URL(`../vendor/text/NotoSans-${style}.ttf`, import.meta.url));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';


test('scene, camera, keyframe and layer contexts keep every control', () => {
  const editor = engineEditor();
  for (const context of ['scene', 'camera', 'frame', 'layer']) assertNothingLost({editor, context}, context);
  assertNothingLost({editor, tab: 'animation'}, 'the animation tab');
  assertNothingLost({editor, context: 'camera', propertyState: key => (key === 'camera_x' ? {value: 12.123456789} : {})}, 'a live camera value');
  assertNothingLost({editor, context: 'scene', propertyState: key => ({scene_color: {value: '#123456'}}[key])}, 'a live scene colour');
  const transformPane = inspectorView({editor, context: 'camera'});
  editor._cameraInspectorTab = 'motion';
  // Today renders the Transform pane hidden behind the Motion tab: its controls are one tab away, as today.
  assertNothingLost({editor, context: 'camera'}, 'the camera motion tab', {otherPane: transformPane});
  editor._cameraInspectorTab = 'transform';
  editor.select(null);
  assertNothingLost({editor}, 'nothing selected');

  const sheet = engineEditor({layerTimeline: true, propertyChannels: true});
  assertNothingLost({editor: sheet, context: 'frame'}, 'an exposure');
  const {editor: inked} = ownedEditorWithDrawings({layerTimeline: true, propertyChannels: true});
  assertNothingLost({editor: inked, context: 'layer'}, 'a drawing layer with parallax');
});

test('figure contexts keep every control: figure, joints, ranges, builder, rig tool', () => {
  const editor = engineEditor();
  editor.select(1);
  assertNothingLost({editor}, 'figure');
  assertNothingLost({editor, rangeIndices: [0, 1, 2], applyRange: true}, 'figure with a frame range');
  assertNothingLost({editor, tool: 'rig', rigMode: 'rotate'}, 'the rig tool');
  assertNothingLost({editor, builder: true}, 'figure in the builder');
  assertNothingLost({editor, propertyState: key => (key === 'root_x' ? {value: 3.14159} : undefined)}, 'a live figure value');
  const joints = editor.figure.segments.length;
  for (let joint = 0; joint < joints; joint++) {
    editor.select(1, joint);
    assertNothingLost({editor}, `joint ${joint}`);
  }
  editor.select(1, 2);
  assertNothingLost({editor, builder: true, tool: 'rig', builderBranch: true}, 'joint in the builder');
  assertNothingLost({editor, rangeIndices: [0, 1], applyRange: false}, 'joint with a frame range');
  editor.selectBranch(1, 2);
  assertNothingLost({editor, context: 'figure', tool: 'rig'}, 'a branch');
  editor.select(1, joints + 3);
  assertNothingLost({editor}, 'a joint index past the figure');
});

test('Build’s rig keeps every control while its behaviours are on, each block showing its settings only while on', () => {
  // Every part of the example rigs: connectors, Smart Stretch, stretch responses, 3D solids.
  for (const id of ['folding-fan', 'accordion-screen-3d', 'perspective-conveyor-3d', 'counter-rotating-gears']) {
    const editor = engineEditor({demo: false}, rigExampleDocument(id));
    const uid = editor.frame.objects.find(Boolean).unique_id;
    for (let joint = 0; joint < editor.figure.segments.length; joint++) {
      editor.select(uid, joint);
      assertNothingLost({editor, builder: true}, `${id} part ${joint}`);
    }
  }
  // A plain part with Smart Stretch, a parent angle lock and its second rotation, then a weighted joint.
  const editor = engineEditor();
  editor.select(1, 2);
  const off = inspectorView({editor, builder: true});
  assert.doesNotMatch(off, /id="rig-rest"|id="rig-lock-angle"|id="rig-lock-secondary"/, 'settings of behaviours that are off stay out of the way');
  editor.enableSmartStretch(true);
  editor.setAngleLock('parent');
  editor.setSecondaryAngleReference(editor.figure.segments[0].segment_id);
  const on = assertNothingLost({editor, builder: true}, 'a part with Smart Stretch and a parent angle lock').now;
  for (const id of ['rig-rest', 'rig-min', 'rig-max', 'rig-width', 'rig-lock-angle', 'rig-lock-multiplier', 'rig-lock-space', 'rig-lock-secondary-multiplier'])
    assert.ok(tag(on, {id}), `${id} shows while its behaviour is on`);
  assert.equal(inspectorDescriptor({editor, builder: true}).sections.find(section => section?.id === 'rig-controls').open, true, 'Rig opens while the part has a rig');
  const weighted = editor.addWeightedJoint(0, [{joint: editor.figure.segments[0].segment_id, weight: 0.5}]);
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === weighted.segment_id));
  assertNothingLost({editor, builder: true}, 'a weighted joint');
  assert.equal(inspectorDescriptor({editor, builder: true}).sections.find(section => section?.id === 'rig-controls').title, 'Weighted joint');
});

test('text, image, connector, two-tone and IK joints keep every control', () => {
  const text = engineEditor({demo: false, layerTimeline: true});
  text.importFigure(compileTextFigure({text: 'Hello', fontSize: 42, color: [70, 40, 170]}, fonts[0]));
  assertNothingLost({editor: text}, 'text');
  const image = engineEditor({demo: false, layerTimeline: true});
  image.importFigure(createImageFigure({dataUrl: PNG, width: 1, height: 1, name: 'Placed <sprite> & "co"'}));
  assertNothingLost({editor: image}, 'image');
  image.select(image.selectedUid, 0);
  assertNothingLost({editor: image}, 'an image segment');

  const rig = engineEditor({demo: false, layerTimeline: true}, rigExampleDocument('sliding-carriage'));
  rig.select(1, 2);
  assertNothingLost({editor: rig}, 'a connector (slider)');
  assertNothingLost({editor: rig, builder: true}, 'a connector in the builder');
  rig._connectorInspector = {uid: 1, id: 3, part: 'segment'};
  assertNothingLost({editor: rig}, 'a connector (segment)');
  rig.select(1, 0);
  assertNothingLost({editor: rig}, 'an anchor segment');

  const tone = engineEditor({demo: false, layerTimeline: true});
  tone.addFigure();
  tone.select(tone.selectedUid, 0);
  tone.updateSegmentStyle({color: '#f8356a', opacity: 0.7, gradient: {color: '#2cd876', opacity: 0.6}});
  for (const shape of ['circle', 'circleFill', 'circleClear', 'line', 'squareLine']) {
    tone.convertSegment(shape);
    assertNothingLost({editor: tone}, `a ${shape} segment`);
  }
  tone.convertSegment('circleFill');
  tone.figure.segments[0].secondary = null;
  assertNothingLost({editor: tone}, 'a circle without a second colour');

  const ik = engineEditor({layerTimeline: true});
  ik.select(1, 4);
  ik.setNodeIK({enabled: true});
  assertNothingLost({editor: ik}, 'an IK joint');
  for (const settings of [
    {enabled: false, pinned: false, allowStretch: false, bendDirection: 0, chainLength: 2, maxLength: 3, target: {rotation: 0}},
    {enabled: true, pinned: true, allowStretch: true, bendDirection: -1, chainLength: 3, maxLength: 3, target: {rotation: 0.5}},
  ]) {
    const now = ikControlsView(settings);
    for (const where of controls(legacyIkControlsView(settings))) assert.ok(find(now, where), `IK ${settings.enabled ? 'on' : 'off'} keeps ${JSON.stringify(where)}`);
    assert.equal(ikSection(settings).id, 'ik');
  }
});

test('fills, long palettes, 3D rigs and the drawing tools keep every control', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.polyfills = Array.from({length: 40}, (_, i) => ({polyfill_id: i + 1, segment_ids: [0, 1, 2], color_rgb: [i * 6, 90, 250 - i * 5], color_alpha: 1 - i / 100, z_order: 1.5}));
  report.keyframes = [createFrame([createObject(figure, 1, 200, 200)], 10)];
  const editor = engineEditor({demo: false}, report);
  editor.select(1);
  for (const [polygonPage, palettePage] of [[0, 0], [1, 1], [3, 9]]) assertNothingLost({editor, polygonPage, palettePage}, `fills page ${polygonPage}, colours page ${palettePage}`);
  editor.selectPolygon(1, 5);
  assertNothingLost({editor, builder: true}, 'a fill in the builder');
  const channels = engineEditor({demo: false, propertyChannels: true}, structuredClone(report));
  channels.select(1);
  assertNothingLost({editor: channels}, 'fills with property channels');

  const q = construction();
  q.add(0, 0, 0, 'Figure rotation');
  const bone = (parent, origin, tip, name) => {
    const turn = q.add(0, 0, 0, 'Turn'), pitch = q.add(0, 0, 0, 'Tilt'), v = tip.map((n, i) => n - origin[i]);
    return q.add(parent, Math.hypot(...v), Math.atan2(v[1], v[0]), name, {control: true, width: 18, rig: {spatial: {parent, origin, tip, turn, pitch}}});
  };
  const arm = bone(0, [0, 0, 0], [0, 100, 0], 'Upper arm');
  bone(arm, [0, 100, 0], [0, 180, 0], 'Forearm');
  const spatial = {figure_type_id: 1, segments: q.segments, polyfills: [], image_assets: [], text_assets: []};
  const rig = engineEditor({demo: false}, {...emptyDocument(), figure_types: [spatial], keyframes: [createFrame([createObject(spatial, 1, 400, 200)])]});
  rig.select(1, -1);
  assertNothingLost({editor: rig}, 'a 3D rig');
  rig.select(1, spatial.segments.findIndex(segment => segment.name === 'Forearm'));
  assertNothingLost({editor: rig}, 'a 3D rig joint');
  rig.setNodeIK({enabled: true, pinned: false});
  assertNothingLost({editor: rig}, 'a 3D rig limb with IK');
  assertNothingLost({editor: rig, builder: true}, 'a 3D rig in the builder');

  const {editor: drawing} = ownedEditorWithDrawings({layerTimeline: true, propertyChannels: true});
  const settings = {color: '#223344', color2: '#ffffff', blend: 'multiply', alphaLock: true, preset: 'ink', hardness: 0.5, roundness: 1, angle: 0, spacingRatio: 0.08,
    taperIn: 0, taperOut: 0, stabilizerMode: 'average', tip: 'round', angleMode: 'fixed', grain: 'noise', texture: 0, grainScale: 1, pressureSize: true,
    pressureOpacity: false, pressureFlow: false, sizeCurve: 1, opacityCurve: 1, sizeJitter: 0, opacityJitter: 0, angleJitter: 0, scatter: 0, mirrorY: false,
    resolution: 1, filter: 'smooth'};
  const session = {active: true, editor: drawing, tool: 'brush', settings, library: {recent: ['#ff0000', '#223344'], presets: []}, state: {view: {}}};
  assertNothingLost({editor: drawing, drawing: session, hotkeyLabel: id => id}, 'the brush');
  drawing.select(1);
  assertNothingLost({editor: drawing, drawing: {...session, tool: 'transform'}, hotkeyLabel: id => id}, 'transforming a drawing');
});

// ---------------------------------------------------------------------------
// The layout of each context, and the hooks its controls keep

test('a figure: its name and quick actions head Transform, Appearance and Arrange; the connection and colours are titled', () => {
  const editor = engineEditor();
  editor.select(1);
  const options = {editor}, today = legacyInspectorView(options), now = inspectorView(options), descriptor = inspectorDescriptor(options);
  assert.deepEqual(descriptor.target, {label: 'Figure', labelKey: 'inspectorView.figure', selection: 'figure', name: 'Walker', glyph: 'person',
    rename: {id: 'figure-name', description: 'Figure name', descriptionKey: 'inspectorView.figureName', tip: 'Double-click to rename the figure definition', tipKey: 'inspectorView.doubleClickToRenameTheFigureDefinition'}});
  assert.deepEqual(descriptor.quick, {context: 'figure'});
  assert.deepEqual([...quickIds(descriptor)], ['mirror', 'layer-front', 'layer-back', 'duplicate', 'delete']);
  assert.deepEqual(sections(descriptor, 'core'), ['transform', 'appearance', 'arrange']);
  assert.deepEqual(sections(descriptor, 'titled'), ['colours']);
  assert.equal(descriptor.scope, null, 'no scope line while edits reach only the current frame');
  for (const key of ['root_x', 'root_y', 'scale', 'rotation', 'figure_opacity', 'figure_z_order']) assertNumberParity(today, now, key);
  assert.equal(tag(now, {'data-property': 'scale'}).attrs['data-field'], 'scale', 'the legacy data-field stays');
  assert.equal(tag(now, {'data-property': 'figure_opacity'}).attrs['data-field'], undefined, 'no data-field where today has none');
  assertParity(today, now, {id: 'figure-color'}, ['type', 'value', 'aria-label']);
  assertParity(today, now, {id: 'figure-layer'}, ['aria-label']);
  assertOptions(today, now, {id: 'figure-layer'});
  for (const action of ['reset-color', 'layer-down', 'layer-up']) assertParity(today, now, {'data-action': action}, ['aria-label', 'data-action']);
  // Arrange: Layer and the Order stepper ("Order ↓ 2 ↑", one step each way), with Join… as its title action (a word; its tooltip names it).
  assert.match(now, /<div class="ui-field" data-steps role="group" aria-label="Order and one-step order"><span class="ui-field-core" data-property-row="figure_z_order">/);
  const join = tag(now, {'data-action': 'join-figure'});
  assert.equal(join.attrs.class, 'ui-button ui-section-action');
  assert.equal(join.attrs['data-hotkey-title'], 'Join to figure');
  assert.match(now, /<span class="ui-label" data-i18n="inspectorView.join" data-i18n-params="\{\}">Join…<\/span>/);
  // The Order steps are plain arrows, never the barred send-to-back and bring-to-front glyphs.
  assert.notEqual(descriptor.sections.find(section => section.id === 'arrange').rows[0].rows[1].down.icon, 'send-to-back');
  // Layer 1 names its kind: the select drops its label ("Layer 1 ▾", never "Layer Layer 1").
  assert.ok(tag(now, {'data-select': true, 'data-bare': true}));
  assert.ok(now.includes('data-property-precision="3" data-property-display-precision="1"'), 'today\'s attribute run, which string tests read');
  assertNoTitles(now);
  assertNoKeyState(now);
  assert.doesNotMatch(now, /<p[\s>]/, 'no helper prose');
  assertBudget(descriptor, 'figure');

  // Joined: Arrange's action unjoins, and the Connection section opens by itself.
  const joined = engineEditor({layerTimeline: true, propertyChannels: true});
  const [parent, child] = joined.selectionFrame.objects;
  joined.select(child.unique_id);
  joined.joinTo(parent.unique_id, 3);
  const connected = inspectorView({editor: joined});
  assert.equal(tag(connected, {'data-action': 'join-figure'}).attrs['data-hotkey-title'], 'Unjoin figure');
  assert.ok('data-open' in tag(connected, {'data-section': 'connection'}).attrs);
  assert.match(connected, /<span class="ui-row-label" data-i18n="inspectorView.joinedTo" data-i18n-params="\{\}">Joined to<\/span><span class="ui-row-value">[^<]+ · 3<\/span>/);
  tag(connected, {'data-action': 'combine-figures'});

  // Edit together: the scope line names the frames and offers the way back; the switch mirrors the timeline header's.
  const range = inspectorDescriptor({editor, rangeIndices: [2, 3, 4], applyRange: true});
  assert.deepEqual(range.scope, {label: 'Editing frames 3–5', labelKey: 'inspectorView.editingFrameRange', labelParams: {first: 3, last: 5, count: 3}, stop: {action: 'toggle-range-edit', label: 'Stop', labelKey: 'inspectorView.stop', tip: 'Edit only this frame', tipKey: 'inspectorView.editOnlyThisFrame'}});
  assert.equal(inspectorDescriptor({editor, rangeIndices: [2, 5], applyRange: true}).scope.label, 'Editing 2 frames');
  assert.equal(inspectorDescriptor({editor, rangeIndices: [2, 3, 4], applyRange: false}).scope, null);
  assert.ok('checked' in tag(inspectorView({editor, rangeIndices: [2, 3, 4], applyRange: true}), {id: 'apply-range-movement'}).attrs);
});

test('several figures: Selection (Rotate 15°, Center), Align, Appearance and Arrange; values that differ read Mixed', () => {
  const editor = engineEditor({layerTimeline: true, propertyChannels: true});
  editor.selectMany([1, 2]);
  const bounds = {minX: 10, minY: 20, maxX: 110.5, maxY: 220}, view = {editor, selectionCount: 2, bounds};
  const today = legacyInspectorView(view), now = inspectorView(view), descriptor = inspectorDescriptor(view);
  assert.equal(descriptor.target.name, '2 figures');
  assert.deepEqual(descriptor.quick, {context: 'figures'});
  assert.deepEqual(sections(descriptor, 'core'), ['selection', 'align', 'appearance', 'arrange']);
  for (const key of ['group_x', 'group_y', 'figure_opacity']) assertNumberParity(today, now, key);
  for (const key of ['group_width', 'group_height'])
    assertNumberParity(today, now, key, ['type', 'data-field', 'data-property', 'data-property-value', 'data-property-precision', 'data-property-step', 'value', 'min']);
  assert.deepEqual(descriptor.sections.find(section => section.id === 'selection').actions.map(action => [action.action, action.label]), [['rotate', 'Rotate 15°'], ['center', 'Center']]);
  for (const action of ['align-left', 'align-center-x', 'align-right', 'align-top', 'align-center-y', 'align-bottom', 'reset-color', 'layer-down', 'layer-up']) tag(now, {'data-action': action});
  assertParity(today, now, {id: 'figure-color'}, ['type', 'aria-label']);
  assertParity(today, now, {id: 'figure-layer'}, ['aria-label']);
  assertOptions(today, now, {id: 'figure-layer'});
  assertNoTitles(now);
  assertBudget(descriptor, 'several figures');

  // Figures on two layers: the Layer select reads Mixed, as today's.
  const layer = editor.createLayer('Layer 2', {activate: false});
  editor.assignFiguresToLayer([2], layer.id);
  editor.selectMany([1, 2]);
  assertOptions(legacyInspectorView(view), inspectorView(view), {id: 'figure-layer'});
  assert.equal(options(inspectorView(view), {id: 'figure-layer'})[0].text, 'Mixed');
  // Opacities that differ: the field is empty with a Mixed placeholder and keeps the model value it edits from.
  editor.selectedObjects[0].field28 = 128;
  const mixed = inspectorView(view), input = tag(mixed, {'data-property': 'figure_opacity'});
  assert.equal(input.attrs.value, '');
  assert.equal(input.attrs.placeholder, 'Mixed');
  assert.equal(input.attrs['data-mixed'], input.attrs['data-property-value']);
});

test('a joint: Joint, IK, Style and its figure\'s Layer are open; the second colour and a connector are titled', () => {
  const editor = engineEditor();
  editor.select(1, 2);
  const options = {editor}, today = legacyInspectorView(options), now = inspectorView(options), descriptor = inspectorDescriptor(options);
  assert.equal(descriptor.target.name, 'Joint 3');
  assert.deepEqual(descriptor.quick, {context: 'joint'});
  assert.deepEqual([...quickIds(descriptor)], ['selection-front', 'selection-back', 'mirror']);
  assert.deepEqual(sections(descriptor, 'core'), ['joint', 'ik', 'style', 'figure']);
  for (const key of ['joint_angle', 'joint_length', 'joint_bend', 'thickness', 'segment_opacity']) assertNumberParity(today, now, key);
  assertNumberParity(today, now, 'segment_z_order', ['type', 'data-field', 'data-property', 'data-property-value', 'data-property-precision', 'data-property-step', 'value', 'min', 'max']);
  for (const key of ['thickness', 'joint_angle', 'joint_length']) assert.equal(tag(now, {'data-property': key}).attrs['data-field'], key);
  assertSwitchParity(today, now, {id: 'static-joint'});
  assertParity(today, now, {id: 'segment-shape'}, ['aria-label', 'disabled']);
  assertOptions(today, now, {id: 'segment-shape'});
  assertParity(today, now, {id: 'segment-color'}, ['type', 'data-paint-picker', 'aria-label']);
  assertParity(today, now, {id: 'figure-layer'}, ['aria-label']);
  assertSwitchParity(today, now, {id: 'node-is-ik'}, ['type', 'role', 'aria-controls', 'checked'], {name: false});
  assert.equal(nameOf(now, {id: 'node-is-ik'}), 'Use IK');
  // Use IK controls a rendered region even while IK is off.
  assert.ok('hidden' in tag(now, {id: 'node-ik-options'}).attrs);
  assert.match(now, /<label class="ui-field" data-switch-field data-tooltip="Does not turn with its parent" data-i18n-tooltip="inspectorView.doesNotTurnWithItsParent" data-i18n-tooltip-params="\{\}"><span class="ui-field-label" data-i18n="inspectorView.static" data-i18n-params="\{\}">Static<\/span><input class="ui-switch" type="checkbox" role="switch" id="static-joint"/);
  assertNoTitles(now);
  assertNoKeyState(now);
  assertBudget(descriptor, 'joint');
  // A named part is titled by its name; a branch and several segments as today.
  editor.figure.segments[2].name = 'Knee';
  assert.equal(inspectorDescriptor(options).target.name, 'Knee');
  editor.selectBranch(1, 2);
  assert.equal(inspectorDescriptor({editor, context: 'figure', tool: 'rig'}).target.name, 'Branch from Knee');
  // In Build a joint is a part: named as Structure names it, with its own tiles (Split, Duplicate, Flip, Delete).
  editor.select(1, 2);
  assert.deepEqual(inspectorDescriptor({editor, builder: true}).quick, {context: 'part'});
  assert.match(inspectorDescriptor({editor, builder: true}).target.name, /Knee$/);
  editor.figure.segments[2].name = '';
  assert.match(inspectorDescriptor({editor, builder: true}).target.name, /(Line|Circle|Square line|Image|Text) \d+$/);
});

test('IK keeps its ids, the chain stepper and the native bend radios', () => {
  const ik = {enabled: true, pinned: true, allowStretch: false, bendDirection: 1, chainLength: 2, maxLength: 3, target: {rotation: 0.5}};
  const today = legacyIkControlsView(ik), now = ikControlsView(ik);
  for (const id of ['node-ik-pinned', 'node-ik-stretch']) assertSwitchParity(today, now, {id});
  assertParity(today, now, {id: 'node-ik-chain'}, ['type', 'min', 'max', 'step', 'value', 'aria-label']);
  assertParity(today, now, {id: 'node-ik-rotation'}, ['type', 'step', 'value', 'aria-label']);
  for (const value of ['-1', '0', '1']) assertParity(today, now, {name: 'node-ik-bend', value}, ['type', 'checked', 'aria-label']);
  assert.ok(!('hidden' in tag(now, {id: 'node-ik-options'}).attrs));
  assert.match(now, /<div class="ui-segmented" role="radiogroup" aria-label="IK bend direction"/);
  // Plain step buttons: the kit applies them within the input's limits, out of the tab order.
  const steps = tags(now).filter(entry => 'data-kit-step' in entry.attrs);
  assert.equal(steps.length, 2);
  assert.ok(steps.every(entry => entry.attrs.tabindex === '-1'));
});

test('connector joints: the Connector section opens with Segment │ Slider; the slider shows its position and Static', () => {
  const editor = engineEditor({demo: false}, rigExampleDocument('sliding-carriage'));
  editor.select(1, 2);
  let options = {editor}, today = legacyInspectorView(options), now = inspectorView(options);
  assertParity(today, now, {id: 'rig-position'}, ['type', 'min', 'max', 'step', 'aria-label']);
  assert.equal(Number(tag(now, {id: 'rig-position'}).attrs.value), Number(tag(today, {id: 'rig-position'}).attrs.value));
  for (const part of ['segment', 'slider']) assertParity(today, now, {'data-connector-part': part}, ['aria-pressed']);
  assertSwitchParity(today, now, {id: 'static-joint'});
  assert.doesNotMatch(now, /id="segment-color"|data-property="thickness"|data-property="joint_angle"/);
  assert.ok('data-open' in tag(now, {'data-section': 'connector'}).attrs, 'the Connector section opens on a connector joint');

  editor._connectorInspector = {uid: 1, id: 3, part: 'segment'};
  options = {editor}; today = legacyInspectorView(options); now = inspectorView(options);
  for (const part of ['segment', 'slider']) assertParity(today, now, {'data-connector-part': part}, ['aria-pressed']);
  assertParity(today, now, {id: 'segment-color'}, ['type', 'aria-label']);
  assertNumberParity(today, now, 'thickness');
  assert.doesNotMatch(now, /id="rig-position"|id="static-joint"|data-property="joint_angle"/);
});

test('second colour: a titled section whose switch sits after its title and which opens while it is on', () => {
  const editor = engineEditor({demo: false, layerTimeline: true});
  editor.addFigure();
  editor.select(editor.selectedUid, 0);
  editor.updateSegmentStyle({color: '#f8356a', opacity: 0.7, gradient: {color: '#2cd876', opacity: 0.6}});
  editor.convertSegment('circle');
  let today = legacyInspectorView({editor}), now = inspectorView({editor});
  assertSwitchParity(today, now, {id: 'segment-gradient-enabled'}, ['type', 'role', 'checked', 'aria-controls'], {name: false});
  assert.equal(tag(now, {id: 'segment-gradient-enabled'}).attrs['aria-label'], 'Secondary color');
  assert.ok(!('hidden' in tag(now, {id: 'segment-secondary-controls'}).attrs));
  assertParity(today, now, {id: 'segment-gradient-color'}, ['type', 'value', 'aria-label']);
  assertNumberParity(today, now, 'segment_gradient_opacity');
  assertNumberParity(today, now, 'segment_opacity');
  assert.ok('data-open' in tag(now, {'data-section': 'second-colour'}).attrs, 'it opens while the second colour is on');

  editor.updateSegmentStyle({gradient: null});
  today = legacyInspectorView({editor}); now = inspectorView({editor});
  assert.ok('hidden' in tag(now, {id: 'segment-secondary-controls'}).attrs, 'the region stays, hidden');
  assert.doesNotMatch(now, /id="segment-gradient-color"/);
  editor.convertSegment('line');
  now = inspectorView({editor});
  assert.doesNotMatch(now, /segment-gradient-enabled/);
  assert.ok(now.includes('<section class="ui-section" data-section="second-colour" hidden></section>'));
});

test('the camera: Level, Center and Reset under its name; Preview with Guides, Transform with Copy and Paste, Framing titled', () => {
  const editor = engineEditor();
  const options = {editor, context: 'camera'}, today = legacyInspectorView(options), now = inspectorView(options), descriptor = inspectorDescriptor(options);
  assert.deepEqual([descriptor.target.name, descriptor.target.glyph, descriptor.target.label], ['Camera', 'camera', 'Camera']);
  assert.deepEqual([...quickIds(descriptor)], ['camera-level', 'camera-center', 'camera-reset']);
  assert.deepEqual(sections(descriptor, 'core'), ['preview', 'tabs', 'transform']);
  assert.deepEqual(sections(descriptor, 'titled'), ['framing']);
  for (const key of ['camera_x', 'camera_y', 'camera_angle']) assertNumberParity(today, now, key);
  assertNumberParity(today, now, 'camera_scale');
  assertParity(today, now, {'data-camera-monitor': true}, ['aria-label']);
  tag(now, {'data-camera-magnification': true});
  assert.match(now, /<span>960 × 540<\/span>/, 'the size reads with its times sign');
  for (const tab of ['transform', 'motion']) assertParity(today, now, {'data-camera-tab': tab}, ['role', 'aria-selected']);
  for (const action of ['camera-copy', 'camera-paste']) assertParity(today, now, {'data-action': action}, ['aria-label', 'disabled']);
  assertParity(today, now, {'data-action': 'camera-guides'}, ['aria-pressed']);
  const monitor = tag(now, {'data-camera-monitor': true});
  assert.equal(monitor.attrs['data-inspector-owned'], 'camera-monitor');
  assert.doesNotMatch(now, /ui-card/);
  // Each camera command once, available when it can act (formerly camera-view.mjs's): Paste after a copy, the
  // centring with a figure selected, a neighbour pose where there is one.
  const actions = tags(now).filter(entry => entry.attrs['data-action']?.startsWith('camera-')).map(entry => entry.attrs['data-action']);
  assert.equal(new Set(actions).size, actions.length, 'each camera command once');
  const disabled = (html, action) => 'disabled' in tag(html, {'data-action': action}).attrs;
  editor.select(null);
  let empty = inspectorView(options);
  for (const action of ['camera-paste', 'camera-center-x', 'camera-center-y', 'camera-locate-previous']) assert.ok(disabled(empty, action), `${action} waits`);
  assert.ok(!disabled(empty, 'camera-locate-next'));
  editor._cameraClipboard = {}; editor.select(1); editor.selectFrame(editor.report.keyframes.length - 1);
  empty = inspectorView(options);
  for (const action of ['camera-paste', 'camera-center-x', 'camera-center-y', 'camera-locate-previous']) assert.ok(!disabled(empty, action), `${action} acts`);
  assert.ok(disabled(empty, 'camera-locate-next'), 'no next pose after the last key');
  assertNoTitles(now);
  assertNoKeyState(now);
  assertBudget(descriptor, 'camera');
});

test('the scene: a meta line, Canvas, Background (Library…, Background image) and Playback', () => {
  const editor = engineEditor();
  const options = {editor, context: 'scene'}, today = legacyInspectorView(options), now = inspectorView(options), descriptor = inspectorDescriptor(options);
  assert.deepEqual([descriptor.target.name, descriptor.target.glyph], ['Scene', 'scene']);
  for (const key of ['canvas_width', 'canvas_height'])
    assertNumberParity(today, now, key, ['type', 'data-field', 'data-property', 'data-property-value', 'data-property-precision', 'data-property-step', 'value', 'min', 'max']);
  assertNumberParity(today, now, 'fps');
  assertParity(today, now, {id: 'background-color'}, ['type', 'value', 'aria-label']);
  for (const action of ['background-style', 'import-background']) tag(now, {'data-action': action});
  assert.ok(now.includes('data-property-precision="0" data-property-display-precision="0"'), 'integer properties edit without decimals');
  assert.match(now, /<div class="inspector-meta"[^>]*>3 figures · \d+ frames · [\d.]+ s<\/div>/);
  assert.equal(tag(now, {'class':'inspector-meta'}).attrs['data-i18n'],'inspectorView.s');
  assert.doesNotMatch(now, /<p[\s>]/);
  assertBudget(descriptor, 'scene', {headerControls: 1});
});

test('keyframe and exposure inspectors keep the duration field and Add frame', () => {
  const editor = engineEditor();
  let options = {editor, context: 'frame'}, descriptor = inspectorDescriptor(options);
  assert.equal(descriptor.kind, 'keyframe');
  assertNumberParity(legacyInspectorView(options), inspectorView(options), 'duration');
  const sheet = engineEditor({layerTimeline: true, propertyChannels: true});
  options = {editor: sheet, context: 'frame'}; descriptor = inspectorDescriptor(options);
  assert.equal(descriptor.kind, 'frame');
  assert.equal(descriptor.target.name, `Frame ${sheet.tick + 1}`);
  assertNumberParity(legacyInspectorView(options), inspectorView(options), 'duration');
  tag(inspectorView(options), {'data-action': 'add-frame'});
});

test('fills and used colours live in the titled Colours section, paged as today', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.polyfills = Array.from({length: 40}, (_, i) => ({polyfill_id: i + 1, segment_ids: [0, 1, 2], color_rgb: [i * 6, 90, 250 - i * 5], color_alpha: 1 - i / 100, z_order: 1.5}));
  report.keyframes = [createFrame([createObject(figure, 1, 200, 200)], 10)];
  const editor = engineEditor({demo: false}, report);
  editor.select(1);
  const options = {editor, tool: 'rig', rigMode: 'rotate', polygonPage: 1, palettePage: 1};
  const today = legacyInspectorView(options), now = inspectorView(options);
  for (const index of [12, 23]) {
    for (const html of [today, now]) tag(html, {'data-polygon-index': index});
    assertParity(today, now, {'data-polygon-color': index}, ['type', 'value', 'aria-label']);
    assertParity(today, now, {'data-delete-polygon': index}, ['aria-label']);
    for (const key of [`polygon_${index}_opacity`, `polygon_${index}_z_order`]) assertNumberParity(today, now, key);
  }
  assert.equal(find(now, {'data-polygon-index': 11}), undefined, 'only the current page');
  for (const action of ['polygons-previous', 'polygons-next', 'palette-previous', 'palette-next']) assertParity(today, now, {'data-action': action}, ['aria-label', 'disabled']);
  // The palette is one collection: one tab stop, the arrow keys inside.
  assert.ok('data-count-one' in tag(now, {class: 'ui-swatch-grid'}).attrs);
  assert.deepEqual(tags(now).filter(entry => 'data-palette-color' in entry.attrs).map(entry => entry.attrs.tabindex).filter(value => value === '0'), ['0']);
  const colours = tag(now, {'data-section': 'colours'});
  assert.ok('data-collapsible' in colours.attrs && !('data-open' in colours.attrs), 'closed at rest');
  assertBudget(inspectorDescriptor({editor}), 'a figure with fills');
});

test('a movieclip: Edit clip and Make unique under its name; Playback and Transform open; Extend and Bake and export titled', () => {
  const clip = movieclipFigure(2, 'Walking clip', {...emptyDocument(), keyframes: Array.from({length: 8}, (_, i) => createFrame([createObject(defaultFigure(), 1, 200 + i * 9, 250)]))},
    {duration: 8, pivot: {x: 200, y: 250}});
  const report = {...emptyDocument(), fps: 24, figure_types: [defaultFigure(), clip]};
  report.keyframes = [createFrame([createObject(clip, 7, 300, 300, {_stykMovieclip: presencePlayback()})], 11)];
  const editor = engineEditor({demo: false, layerTimeline: true}, report);
  editor.select(7);
  const descriptor = inspectorDescriptor({editor}), now = inspectorView({editor});
  assert.deepEqual([descriptor.target.name, descriptor.target.glyph, descriptor.target.rename.data], ['Walking clip', 'frame', {'movieclip-name': true}]);
  assert.deepEqual([...quickIds(descriptor)], ['movieclip-edit', 'movieclip-unique', 'duplicate', 'delete']);
  assert.deepEqual(sections(descriptor, 'core'), ['playback', 'transform']);
  assert.deepEqual(sections(descriptor, 'titled'), ['extend', 'bake']);
  assert.equal(tag(now, {'data-movieclip-current-frame': true}).tag, 'output');
  assert.match(now, /<output data-movieclip-current-frame aria-label="Current movieclip frame"[^>]*>1 \/ 8<\/output>/);
  assert.equal(tag(now, {'data-movieclip-current-frame':true}).attrs['data-i18n-aria-label'],'movieclipUi.currentMovieclipFrame');
  assert.match(now, /<span data-movieclip-duration[^>]*>8 frames · 0\.333 s · 24 fps<\/span>/);
  assert.equal(tag(now, {'data-movieclip-duration':true}).attrs['data-i18n'],'movieclipUi.durationSummary');
  assert.equal(nameOf(now, {'data-movieclip-field': 'offset'}), 'Movieclip start frame');
  assert.equal(nameOf(now, {'data-movieclip-field': 'speed'}), 'Movieclip speed');
  assert.equal(tag(now, {'data-action': 'movieclip-extend'}).attrs['aria-label'], 'Add to next keyframes');
  assertBudget(descriptor, 'movieclip');
});

test('the 3D rig: Pose and Body open, Exact angles, Perspective, Shape and Choices titled', () => {
  const q = construction();
  q.add(0, 0, 0, 'Figure rotation');
  const bone = (parent, origin, tip, name) => {
    const turn = q.add(0, 0, 0, 'Turn'), pitch = q.add(0, 0, 0, 'Tilt'), v = tip.map((n, i) => n - origin[i]);
    return q.add(parent, Math.hypot(...v), Math.atan2(v[1], v[0]), name, {control: true, width: 18, rig: {spatial: {parent, origin, tip, turn, pitch}}});
  };
  const arm = bone(0, [0, 0, 0], [0, 100, 0], 'Upper arm');
  bone(arm, [0, 100, 0], [0, 180, 0], 'Forearm');
  const spatial = {figure_type_id: 1, segments: q.segments, polyfills: [], image_assets: [], text_assets: [], name: 'Arm'};
  const rig = engineEditor({demo: false}, {...emptyDocument(), figure_types: [spatial], keyframes: [createFrame([createObject(spatial, 1, 400, 200)])]});
  rig.select(1, -1);
  const descriptor = inspectorDescriptor({editor: rig}), now = inspectorView({editor: rig});
  assert.equal(descriptor.kind, 'spatial-rig');
  assert.deepEqual(descriptor.quick, {context: 'figure'});
  assert.deepEqual(sections(descriptor, 'core'), ['rig-pose', 'rig-body']);
  assert.deepEqual(sections(descriptor, 'titled'), ['spatial-perspective', 'placement']);
  // Pose │ Rotate stays the pressed pair tests name; Reset pose is the Pose section's action.
  for (const [mode, pressed] of [['pose', 'true'], ['rotate', 'false']]) assert.equal(tag(now, {'data-spatial-mode': mode}).attrs['aria-pressed'], pressed);
  assert.equal(tag(now, {'data-spatial-reset': 'all'}).attrs['aria-label'], 'Reset pose');
  assert.equal(nameOf(now, {id: 'spatial-joint'}), 'Articulation');
  assert.doesNotMatch(now, /<p[\s>]/, 'guidance is a quiet line, never a paragraph');
});

test('every context keeps a stable, valid layout that fits the budget at rest', () => {
  const editor = engineEditor();
  const contexts = [{editor, context: 'scene'}, {editor, context: 'camera'}, {editor, context: 'layer'}, {editor, context: 'frame'}];
  editor.select(1);
  contexts.push({editor}, {editor, rangeIndices: [0, 1, 2], applyRange: true});
  for (const options of contexts) {
    const descriptor = inspectorDescriptor(options);
    assertDescriptor(descriptor, descriptor.kind);
    // The kit renders every descriptor (it throws on unknown kinds, duplicate ids and too many title actions).
    assert.equal(typeof renderInspector(descriptor), 'string');
  }
  assert.ok(INSPECTOR_BUDGET.coreSections >= 3);
});
