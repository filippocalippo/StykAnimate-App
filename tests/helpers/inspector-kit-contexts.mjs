/**
 * Inspector descriptors for today's contexts, built from the same editor
 * reads as src/inspector-view.mjs, for tests/inspector-kit.test.mjs's
 * parity cases. They cover each context's key controls (the ids, properties
 * and hooks that handlers and tests look up), laid out as the redesign's
 * sections (experience.md §5, architecture.md §3.13), so the tests show a
 * descriptor reproduces today's contract exactly. Not a complete port: M4
 * moves inspector-view.mjs itself to descriptors. Conditional content is
 * `hidden`, never filtered out, so positions stay stable across renders.
 *
 * Glyph names are the spec's (visual-system.md §10: step-up, step-down,
 * library, copy, join-figure, rotate-step, frame-plus); icons.mjs gains them
 * in M4 and draws its fallback until then.
 */
import {figurePalette, displayedSegmentPaint, displayedColor} from '../../src/figure-colors.mjs';
import {paintCSS} from '../../src/paint.mjs';
import {cameraValues} from '../../src/pivot/model.mjs';
import {builderDrawables} from '../../src/editor-builder-style.mjs';
import {resolveInstanceFigure} from '../../src/animation-style.mjs';
import {BRUSH_BLEND_LABELS} from '../../src/drawing-view.mjs';
import {sheetKeyAt} from '../../src/layer-sheet.mjs';
import {isStatic} from '../../src/pivot/read-view.mjs';

const degrees = radians => radians * 180 / Math.PI;
const hex = rgb => `#${(rgb || [43, 43, 43]).map(n => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
const opacity = raw => (1 - (raw || 0) / 255) * 100;
const polygonOpacity = polygon => (polygon.alpha_raw !== undefined ? 1 - polygon.alpha_raw / 255 : polygon.color_alpha ?? 1) * 100;
const pageRange = (start, size, total) => `${start + 1}–${Math.min(start + size, total)} / ${total}`;

/** The figure's Layer select: today's #figure-layer with its Mixed placeholder and locked layers disabled. */
export function layerSelect(editor, extra = {}) {
  const ids = new Set([...editor.selectedUids].map(uid => editor.layerForUid(uid)));
  const current = ids.size === 1 ? [...ids][0] : undefined;
  return {
    kind: 'select', id: 'figure-layer', label: 'Layer', description: 'Figure layer', placeholder: 'Mixed', value: current,
    options: editor.layers.filter(layer => layer.kind === 'layer').reverse().map(layer => ({value: layer.id, label: layer.name, disabled: layer.locked})),
    ...extra,
  };
}

/** A fill of the figure: its row (name, colour, delete) and its own fields (opacity, order, the four order steps), one region keyed by data-polygon-index. */
function fillGroup(editor, figure, object, index, order) {
  const polygon = figure.polyfills[index], name = `Polygon ${index + 1}`;
  return {kind: 'group', label: name, data: {'polygon-index': index}, rows: [
    {kind: 'list-row', label: name, lead: 'polygon', actions: [
      {kind: 'swatch', picker: 'native', value: hex(displayedColor(editor.report, figure, object, polygon.color_rgb)), label: `${name} color`, data: {'polygon-color': index}},
      {icon: 'trash', label: `Delete polygon ${index + 1}`, data: {'delete-polygon': index}},
    ]},
    {kind: 'grid', rows: [
      {kind: 'number', key: `polygon_${index}_opacity`, label: 'Opacity', unit: '%', value: polygonOpacity(polygon), min: 0, max: 100},
      {kind: 'number', key: `polygon_${index}_z_order`, label: 'Order', precision: 0, value: order.get(`polygon:${index}`), min: 1, max: order.size},
    ]},
    {kind: 'actions', label: `${name} order`, items: [['back', 'send-to-back', 'Send to back'], ['down', 'step-down', 'Send backward'], ['up', 'step-up', 'Bring forward'], ['front', 'bring-to-front', 'Bring to front']]
      .map(([direction, icon, label]) => ({action: 'builder-order', icon, label: `${label} · polygon`, data: {kind: 'polygon', index, direction}}))},
  ]};
}

/**
 * A figure, text or image: Transform, Appearance, Arrange core sections;
 * Connection, Edit rig, Fills and Colours titled (their pages as pagers).
 */
export function figureInspector(editor, {tool = 'select', rigMode = 'move', polygonPage = 0, palettePage = 0} = {}) {
  const object = editor.object, figure = resolveInstanceFigure(editor.figure, object), frame = editor.frame;
  const own = figurePalette(editor.report, figure, object), palette = editor.figurePalette();
  const text = figure.segments.every(segment => segment.primitive_code === 5);
  const parent = object.join ? frame.objects[object.join.target_object_slot] : null;
  const parentName = parent && (parent.name || editor.report.figure_types.find(type => type.figure_type_id === parent.figure_type_id)?.name || 'Figure');
  const children = frame.objects.some(part => part.join?.target_object_slot === object.object_slot);
  const order = new Map(builderDrawables(figure).map((item, index) => [`${item.kind}:${item.index}`, index + 1]));
  const polygons = figure.polyfills ?? [], start = Math.min(Math.max(0, polygonPage) * 12, Math.max(0, Math.floor((polygons.length - 1) / 12) * 12));
  const paletteStart = Math.min(Math.max(0, palettePage) * 32, Math.max(0, Math.ceil(palette.length / 32) - 1) * 32);
  return {
    kind: text ? 'text' : figure.segments.every(segment => segment.primitive_code === 2) ? 'image' : 'figure',
    quick: {context: 'figure', label: 'Figure actions'},
    sections: [
      {id: 'name', rows: [{kind: 'text', id: 'figure-name', label: 'Name', description: 'Figure name', tip: 'Rename figure definition', value: figure.name || 'Figure'}]},
      {id: 'text', title: 'Text', hidden: !text, rows: [{kind: 'actions', items: [{action: 'edit-text', icon: 'text', label: 'Edit text', text: true, variant: 'outline'}]}]},
      {id: 'transform', title: 'Transform', rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'root_x', label: 'X', unit: 'px', value: object.root_x},
        {kind: 'number', key: 'root_y', label: 'Y', unit: 'px', value: object.root_y},
        {kind: 'number', key: 'scale', label: 'Scale', unit: '%', value: object.scale * 100, min: 0.01},
        {kind: 'number', key: 'rotation', label: 'Angle', unit: '°', value: degrees((object.angles[0] ?? 0) - (figure.segments[0]?.angle_rad ?? 0))},
      ]}]},
      {id: 'appearance', title: 'Appearance', actions: [{action: 'reset-color', icon: 'undo', label: 'Reset colors'}], rows: [{kind: 'grid', rows: [
        {kind: 'color', id: 'figure-color', label: 'Colour', description: 'Recolor all segments', value: own[0]?.color ?? '#000000', caption: own.length > 1 ? 'Mixed' : undefined},
        {kind: 'number', key: 'figure_opacity', id: 'figure-opacity', field: false, label: 'Opacity', unit: '%', value: opacity(object.field28), min: 0, max: 100},
      ]}]},
      // Text keeps Arrange a titled line: its core sections are Text, Transform and Appearance (experience.md §5.1).
      {id: 'arrange', title: 'Arrange', place: text ? 'titled' : 'core', actions: [{action: 'join-figure', label: parent ? 'Unjoin figure' : 'Join figure', icon: parent ? 'detach' : 'join-figure', legacyTitle: true}], rows: [
        {kind: 'grid', ratio: '3:2', stackNarrow: true, rows: [
          layerSelect(editor),
          {kind: 'stepper-field', key: 'figure_z_order', label: 'Order', description: 'Z-index', precision: 0, value: object._stykZIndex ?? 0, min: -1000000, max: 1000000,
            down: {action: 'layer-down', label: 'Send backward', icon: 'step-down'}, up: {action: 'layer-up', label: 'Bring forward', icon: 'step-up'}},
        ]},
      ]},
      {id: 'connection', title: 'Connection', place: 'titled', open: ctx => Boolean(ctx?.joined), rows: [
        {kind: 'value', label: 'Joined to', text: parent ? `${parentName} · ${object.join.target_handle_id}` : 'None'},
        {kind: 'actions', items: [{action: 'combine-figures', icon: 'combine', label: 'Combine connected', text: true, variant: 'outline', disabled: !parent && !children}]},
      ]},
      {id: 'rig', title: 'Edit rig', place: 'titled', open: tool === 'rig', hidden: tool !== 'rig', rows: [
        {kind: 'select', id: 'rig-mode', label: 'Mode', description: 'Rig edit mode', value: rigMode, options: [{value: 'move', label: 'Move joint'}, {value: 'rotate', label: 'Rotate branch'}]},
        {kind: 'actions', items: [{action: 'add-sprite-segment', icon: 'image', label: 'Add sprite part…', text: true, variant: 'outline'}]},
      ]},
      {id: 'fills', title: 'Fills', place: 'titled', hidden: !polygons.length, rows: [
        ...polygons.slice(start, start + 12).map((_, i) => fillGroup(editor, figure, object, start + i, order)),
        polygons.length > 12 && {kind: 'pager', label: 'Fill pages', text: pageRange(start, 12, polygons.length),
          previous: {action: 'polygons-previous', icon: 'chevron-left', label: 'Previous polygons', disabled: start === 0},
          next: {action: 'polygons-next', icon: 'chevron-right', label: 'Next polygons', disabled: start + 12 >= polygons.length}},
      ]},
      {id: 'colours', title: 'Colours', place: 'titled', rows: [
        {kind: 'swatches', label: 'Figure color palette', items: palette.slice(paletteStart, paletteStart + 32).map(entry => ({
          picker: 'paint', value: entry.color, label: `Replace ${entry.color.toUpperCase()}, ${entry.segments.length} segments${entry.polygons.length ? `, ${entry.polygons.length} fills` : ''}`,
          data: {'palette-color': entry.color},
        }))},
        palette.length > 32 && {kind: 'pager', label: 'Colour pages', text: pageRange(paletteStart, 32, palette.length),
          previous: {action: 'palette-previous', icon: 'chevron-left', label: 'Previous colors', disabled: paletteStart === 0},
          next: {action: 'palette-next', icon: 'chevron-right', label: 'Next colors', disabled: paletteStart + 32 >= palette.length}},
      ]},
    ],
    footer: [{action: 'add-to-library', icon: 'library', label: 'Add to library'}],
  };
}

/** Several figures: Selection (Layer, X, Y, W, H; Rotate 15° and Centre), Align's six, Appearance (Mixed when they differ). */
export function selectionInspector(editor, bounds) {
  const objects = editor.selectedObjects, object = editor.object;
  const opacities = new Set(objects.map(item => item.field28 || 0));
  const colours = new Set(objects.flatMap(item => figurePalette(editor.report, resolveInstanceFigure(editor.report.figure_types.find(type => type.figure_type_id === item.figure_type_id), item), item).map(entry => entry.color)));
  const align = [['left', 'align-left'], ['center-x', 'align-horizontal-center'], ['right', 'align-right'], ['top', 'align-top'], ['center-y', 'align-vertical-center'], ['bottom', 'align-bottom']];
  return {
    kind: 'figures',
    quick: {context: 'figure', label: 'Selection actions'},
    sections: [
      {id: 'selection', title: 'Selection', actions: [{action: 'rotate', icon: 'rotate-step', label: 'Rotate 15°'}, {action: 'center', icon: 'center', label: 'Center selection'}], rows: [
        {kind: 'grid', rows: [
          layerSelect(editor, {span: 2}),
          {kind: 'number', key: 'group_x', label: 'X', unit: 'px', value: bounds.minX},
          {kind: 'number', key: 'group_y', label: 'Y', unit: 'px', value: bounds.minY},
          {kind: 'number', key: 'group_width', label: 'W', unit: 'px', value: bounds.maxX - bounds.minX, min: 0.01},
          {kind: 'number', key: 'group_height', label: 'H', unit: 'px', value: bounds.maxY - bounds.minY, min: 0.01},
        ]},
      ]},
      {id: 'align', title: 'Align', rows: [{kind: 'actions', label: 'Align', items: align.map(([name, icon]) => ({action: `align-${name}`, icon, label: `Align ${name.replace('-', ' ')}`}))}]},
      {id: 'appearance', title: 'Appearance', actions: [{action: 'reset-color', icon: 'undo', label: 'Reset colors'}], rows: [{kind: 'grid', rows: [
        {kind: 'color', id: 'figure-color', label: 'Colour', description: 'Figure color', value: colours.size === 1 ? [...colours][0] : '#2b2b2b', mixed: colours.size > 1},
        {kind: 'number', key: 'figure_opacity', id: 'figure-opacity', field: false, label: 'Opacity', unit: '%', value: opacity(object.field28), min: 0, max: 100, mixed: opacities.size > 1},
      ]}]},
    ],
  };
}

/**
 * A joint: Joint (angle, length, bend, Static), IK, Style (width, order,
 * shape, colour, opacity); Second colour and Connector titled.
 */
export function jointInspector(editor, {ik = editor.getIKSettings(), ikAllowed = true} = {}) {
  const object = editor.object, figure = resolveInstanceFigure(editor.figure, object), joint = editor.selectedJoint, segment = figure.segments[joint];
  const lock = segment._stykRig?.angleLock, connector = segment._stykRig?.connector;
  const scope = editor._connectorInspector, part = connector && scope?.uid === editor.selectedUid && scope?.id === segment.segment_id ? scope.part : 'slider';
  const slider = Boolean(connector) && editor.selectedSegmentIds.size <= 1 && part === 'slider';
  const angle = lock ? editor.geometry.objects.get(editor.selectedSlot)?.segments[joint]?.angle : object.angles[joint] ?? segment.angle_rad;
  const order = new Map(builderDrawables(figure).map((item, index) => [`${item.kind}:${item.index}`, index + 1]));
  const paint = displayedSegmentPaint(editor.report, figure, object, segment);
  const shape = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'][segment.primitive_code ?? 0];
  const fixed = ['image', 'text'].includes(shape);
  const selected = editor.selectedSegmentIds;
  const twoTone = [1, 3, 4].includes(segment.primitive_code) && (selected.size <= 1 || figure.segments.every(item => !selected.has(item.segment_id) || [1, 3, 4].includes(item.primitive_code)));
  const secondary = twoTone && Boolean(segment.secondary);
  const position = object.len_flag ? object.lengths[joint] : segment.length;
  return {
    kind: 'joint',
    quick: {context: 'joint', label: 'Joint actions'},
    sections: [
      {id: 'joint', title: 'Joint', rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'joint_angle', label: 'Angle', unit: '°', value: degrees(angle), disabled: Boolean(lock), hidden: Boolean(connector)},
        {kind: 'number', key: 'joint_length', label: 'Length', unit: 'px', value: position, min: 0, hidden: Boolean(connector)},
        {kind: 'number', key: 'joint_bend', label: 'Bend', unit: '°', value: degrees(object.bend_flag ? object.bends[joint] : segment.bend_rad || 0), hidden: slider},
        {kind: 'field-switch', id: 'static-joint', label: 'Static', checked: isStatic(segment), hidden: Boolean(connector) && !slider},
      ]}]},
      ikSection(ik, {hidden: !ikAllowed || slider}),
      {id: 'style', title: 'Style', hidden: slider, rows: [
        {kind: 'grid', rows: [
          {kind: 'number', key: 'thickness', label: 'Width', unit: 'px', value: segment.thickness, min: 0},
          {kind: 'number', key: 'segment_z_order', label: 'Order', precision: 0, value: order.get(`segment:${joint}`), min: 1, max: order.size},
          {kind: 'select', id: 'segment-shape', label: 'Shape', description: 'Segment shape', value: shape, disabled: fixed, span: 2, options: [
            ['line', 'Round line'], ['squareLine', 'Square line'], ['circle', 'White circle'], ['circleFill', 'Filled circle'], ['circleClear', 'Clear circle'],
            ...(fixed ? [[shape, shape]] : []),
          ].map(([value, label]) => ({value, label}))},
          {kind: 'color', picker: 'paint', id: 'segment-color', label: 'Colour', description: 'Segment color', value: paint.type === 'solid' ? hex(paint.stops[0].color) : undefined,
            paint: paintCSS(paint), caption: paint.type === 'solid' ? undefined : `${paint.type[0].toUpperCase()}${paint.type.slice(1)} gradient`},
          {kind: 'number', key: 'segment_opacity', id: 'segment-opacity', field: false, label: secondary ? 'Primary opacity' : 'Opacity', description: 'Primary color opacity', unit: '%',
            value: opacity(segment.transparency), min: 0, max: 100},
        ]},
      ]},
      {id: 'second-colour', title: 'Second colour', place: 'titled', open: () => secondary, hidden: !twoTone || slider,
        switch: {id: 'segment-gradient-enabled', label: 'Secondary color', checked: secondary, controls: 'segment-secondary-controls'},
        rows: [{kind: 'grid', id: 'segment-secondary-controls', hidden: !secondary, rows: secondary ? [
          {kind: 'color', id: 'segment-gradient-color', label: 'Colour', description: 'Secondary color', value: hex(displayedColor(editor.report, figure, object, segment.secondary.rgb))},
          {kind: 'number', key: 'segment_gradient_opacity', label: 'Secondary opacity', description: 'Secondary color opacity', unit: '%', value: (1 - (segment.secondary.a ?? 0) / 255) * 100, min: 0, max: 100},
        ] : []}]},
      {id: 'connector', title: `Connector ${segment.segment_id}`, place: 'titled', open: () => Boolean(connector), hidden: !connector || selected.size > 1, rows: [
        {kind: 'segmented', mode: 'pressed', description: 'Connector properties', value: part, fill: true,
          options: [['segment', 'Segment'], ['slider', 'Slider']].map(([value, label]) => ({value, label, data: {'connector-part': value}}))},
        {kind: 'grid', hidden: !slider, rows: slider ? [{kind: 'number', id: 'rig-position', label: 'Position', description: 'Slide position', unit: '%', value: Math.round(position * 10000) / 100, min: 0, max: 100}] : []},
      ]},
    ],
  };
}

/** IK: Use IK switch; Pinned, Stretch, Chain, Rotation and the bend direction in #node-ik-options while IK is on (today's #node-ik-* controls). */
export function ikSection(ik, {hidden = false} = {}) {
  return {
    id: 'ik', title: 'IK', hidden, rows: [
      {kind: 'grid', rows: [{kind: 'field-switch', id: 'node-is-ik', label: 'Use IK', tip: 'Inverse kinematics', checked: ik.enabled, controls: 'node-ik-options'}]},
      {kind: 'group', id: 'node-ik-options', label: 'IK options', hidden: !ik.enabled, rows: ik.enabled ? [
        {kind: 'grid', rows: [
          {kind: 'field-switch', id: 'node-ik-pinned', label: 'Pinned', checked: ik.pinned},
          {kind: 'field-switch', id: 'node-ik-stretch', label: 'Stretch', tip: 'Allow stretch', checked: ik.allowStretch},
        ]},
        {kind: 'stepper', id: 'node-ik-chain', label: 'Chain', description: 'IK chain length', value: ik.chainLength, min: 1, max: ik.maxLength, step: 1,
          down: {label: 'Shorter chain'}, up: {label: 'Longer chain'}},
        {kind: 'grid', rows: [{kind: 'number', id: 'node-ik-rotation', label: 'Rotation', description: 'IK target rotation', unit: '°', step: 1, precision: 2,
          value: Math.round(ik.target.rotation * 180 / Math.PI * 100) / 100}]},
        {kind: 'segmented', label: 'Bend', description: 'IK bend direction', name: 'node-ik-bend', value: ik.bendDirection, options: [[-1, 'Left'], [0, 'Both'], [1, 'Right']]
          .map(([value, label]) => ({value, label, description: `Bend ${label.toLowerCase()}`}))},
      ] : []},
    ],
  };
}

/** The camera: today's Transform │ Motion tabs, its Preview (the monitor, Guides as its title action) and Transform. */
export function cameraInspector(editor, {guides = true} = {}) {
  const camera = cameraValues((editor.evaluatedFrame || editor.frame).camera), motion = editor._cameraInspectorTab === 'motion';
  return {
    kind: 'camera',
    quick: {context: 'camera', label: 'Camera actions'},
    sections: [
      {id: 'view', rows: [{kind: 'segmented', mode: 'tab', description: 'Camera controls', fill: true, value: motion ? 'motion' : 'transform',
        options: [['transform', 'Transform'], ['motion', 'Motion']].map(([value, label]) => ({value, label, data: {'camera-tab': value}}))}]},
      {id: 'preview', title: 'Preview', place: 'titled', open: true,
        actions: [{action: 'camera-guides', icon: 'grid', label: 'Guides', tip: 'Show composition guides', pressed: guides}],
        rows: [{kind: 'preview', media: {tag: 'canvas', key: 'camera-monitor', label: 'Live camera output', data: {'camera-monitor': true}},
          caption: [`${editor.report.canvas_width} × ${editor.report.canvas_height}`, {text: `${Number((100 / camera.scale).toFixed(2))}% zoom`, data: {'camera-magnification': true}}]}]},
      {id: 'transform', title: 'Transform', actions: [
        {action: 'camera-copy', icon: 'copy', label: 'Copy camera pose'},
        {action: 'camera-paste', icon: 'clipboard', label: 'Paste camera pose', disabled: !editor._cameraClipboard},
      ], rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'camera_x', label: 'X', unit: 'px', value: camera.x || 0},
        {kind: 'number', key: 'camera_y', label: 'Y', unit: 'px', value: camera.y || 0},
        {kind: 'number', key: 'camera_scale', label: 'Scale', unit: '%', value: (camera.scale || 1) * 100, min: 0.01},
        {kind: 'number', key: 'camera_angle', label: 'Rotation', unit: '°', value: degrees(camera.angle_rad || 0)},
      ]}]},
    ],
  };
}

/** The Scene: its meta line, canvas size, background colour and its settings, the frame rate. */
export function sceneInspector(editor) {
  const report = editor.report, background = report.backgrounds?.find(b => b.background_id === editor.frame.background_id);
  const raw = background?.color ?? 0xffffffff, color = `#${(raw & 0xffffff).toString(16).padStart(6, '0')}`;
  const figures = editor.frame.objects.length, frames = editor.totalTicks;
  return {
    kind: 'scene',
    sections: [
      {id: 'summary', rows: [{kind: 'meta', text: `${figures} ${figures === 1 ? 'figure' : 'figures'} · ${frames} ${frames === 1 ? 'frame' : 'frames'} · ${(frames / report.fps).toFixed(1)} s`}]},
      {id: 'canvas', title: 'Canvas', rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'canvas_width', label: 'W', unit: 'px', precision: 0, value: report.canvas_width, min: 1, max: 16384},
        {kind: 'number', key: 'canvas_height', label: 'H', unit: 'px', precision: 0, value: report.canvas_height, min: 1, max: 16384},
      ]}]},
      {id: 'background', title: 'Background', actions: [
        {action: 'background-style', icon: 'sliders', label: 'Background settings'},
        {action: 'import-background', icon: 'image', label: 'Import background'},
      ], rows: [{kind: 'grid', rows: [{kind: 'color', id: 'background-color', label: 'Colour', description: 'Background color', value: color}]},
        {kind: 'value', label: 'Image', text: background?.name || 'White'}]},
      {id: 'playback', title: 'Playback', rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'fps', label: 'Rate', unit: 'fps', precision: 0, value: report.fps, min: 1, max: 120},
      ]}]},
    ],
  };
}

/** A keyframe (Timing: Duration in ticks) or, with the layer sheet, an exposure (Exposure in frames, Add frame). */
export function frameInspector(editor) {
  const sheet = editor.report._styk?.layerSheet;
  if (sheet) {
    const track = sheet.tracks[editor.activeLayerId], {key, next} = sheetKeyAt(track, editor.tick);
    return {kind: 'frame', sections: [
      {id: 'exposure', title: editor.getLayer(editor.activeLayerId)?.name ?? 'Layer', actions: [{action: 'add-frame', icon: 'frame-plus', label: 'Insert keyframe (F6)'}], rows: [{kind: 'grid', rows: [
        {kind: 'number', key: 'duration', label: 'Exposure', unit: 'frames', precision: 0, value: (next?.tick ?? track?.end ?? editor.tick + 1) - (key?.tick ?? editor.tick), min: 1, max: 65535},
      ]}]},
    ]};
  }
  return {kind: 'keyframe', sections: [
    {id: 'timing', title: 'Timing', rows: [{kind: 'grid', rows: [
      {kind: 'number', key: 'duration', label: 'Duration', unit: 'ticks', precision: 0, value: editor.frame.duration_raw ?? 1, min: 0, max: 65535},
    ]}]},
  ]};
}

/** A layer (a drawing layer in the tests): name, Visible and Locked, and Parallax as a titled section with its switch. */
export function layerInspector(editor) {
  const layer = editor.getLayer(editor.activeLayerId), parallax = layer.parallax ?? {enabled: false, linked: true, x: 1, y: 1};
  const presets = [[0.15, 'Distant'], [0.45, 'Background'], [1, 'Normal'], [1.4, 'Foreground']];
  const custom = !parallax.linked || !presets.some(([value]) => value === parallax.x);
  const data = {'layer-id': layer.id};
  return {
    kind: 'layer',
    sections: [
      {id: 'layer', title: 'Layer', rows: [
        {kind: 'text', id: 'inspector-layer-name', label: 'Name', description: 'Layer name', value: layer.name, maxlength: 160, data},
        {kind: 'checkbox', id: 'inspector-layer-visible', label: 'Visible', checked: layer.visible, data},
        {kind: 'checkbox', id: 'inspector-layer-locked', label: 'Locked', checked: layer.locked, data},
      ]},
      {id: 'parallax', title: 'Parallax', place: 'titled', open: () => parallax.enabled, data: {'parallax-layer': layer.id},
        switch: {label: 'Enable parallax', checked: parallax.enabled, disabled: layer.locked, data: {'parallax-field': 'enabled'}},
        rows: [
          {kind: 'select', label: 'Preset', description: 'Parallax preset', data: {'parallax-field': 'preset'}, disabled: layer.locked,
            options: [...(custom ? [{value: 'custom', label: 'Custom', selected: true}] : []), ...presets.map(([value, label]) => ({value, label, selected: !custom && parallax.x === value}))]},
          {kind: 'slider', label: 'Movement', description: 'Parallax movement', min: 0, max: 400, value: parallax.x * 100, unit: '%', disabled: layer.locked, data: {'parallax-field': 'movement'}},
          {kind: 'grid', rows: ['x', 'y'].map(axis => ({kind: 'number', key: `parallax_${axis}`, field: false, label: axis.toUpperCase(), description: `Parallax ${axis.toUpperCase()}`,
            scrubLabel: `Scrub ${axis.toUpperCase()}`, unit: '%', value: parallax[axis] * 100, min: 0, max: 400, disabled: layer.locked, data: {'parallax-field': axis}}))},
        ]},
    ],
  };
}

/** Draw's brush: the stroke preview, recent colours, and the Painting section (Blend, Lock alpha). */
export function brushInspector(drawing) {
  const settings = drawing.settings, recent = drawing.library?.recent ?? [];
  return {
    kind: 'draw-brush',
    sections: [
      {id: 'brush', title: 'Brush', rows: [
        {kind: 'preview', media: {tag: 'canvas', key: 'brush-preview', section: 'brush-preview', className: 'drawing-preview', label: 'Brush stroke preview', data: {'brush-preview': true}}},
        {kind: 'swatches', label: 'Recent colors', hidden: !recent.length, items: recent.map(color => ({
          value: color, label: `Use ${color.toUpperCase()}`, tip: color.toUpperCase(), pressed: color === settings.color.toLowerCase(), data: {'draw-color': color},
        }))},
      ]},
      {id: 'painting', title: 'Painting', rows: [{kind: 'grid', rows: [
        {kind: 'select', label: 'Blend', data: {'draw-setting': 'blend', 'draw-text': true}, value: settings.blend,
          options: BRUSH_BLEND_LABELS.map(([value, label]) => ({value, label}))},
        {kind: 'field-switch', id: 'draw-alphaLock', label: 'Lock alpha', checked: Boolean(settings.alphaLock), data: {'draw-setting': 'alphaLock'}},
      ]}]},
    ],
  };
}
