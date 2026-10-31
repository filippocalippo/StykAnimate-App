import {tupleMessages, messageTuple, messageHTML} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';
/**
 * The inspector's contexts as section descriptors (architecture.md §3.13,
 * experience.md §5.1). inspectorDescriptor(options) describes what the
 * Properties panel shows for the current selection and mode as
 * {kind, target, quick, scope, sections}: the scene, the camera, a frame or
 * keyframe, a layer, the drawing tools, several figures, one figure (a
 * figure, text or image; a movieclip instance; a 3D rig; a builder fill) or a
 * joint. inspectorView(options) renders the sections with src/inspector-kit.mjs
 * (the content of #inspector); the header (the target's name and menu, the
 * scope line and the quick actions) is src/inspector-header.mjs's, fed the
 * same descriptor through onInspectorRender().
 *
 * Revision 4: core sections are always open (at most two title actions each),
 * less used settings are titled sections that fold behind their title and
 * open when their content matters, and the selection's most used commands are
 * its quick actions (src/ui/quick-actions.mjs). The inspector never shows key
 * state. Sub-modules that still build HTML (the rig controls in Build, the
 * camera's motion, drawing, parallax, drawing sets, builder surfaces) enter as
 * markup rows until their milestones.
 */
import {joinedDrawingSetsView} from './movieclip-drawings-view.mjs';
import {spatialSections} from './spatial-controls.mjs';
import {drawingInspector, DRAWING_TOOLS} from './drawing-view.mjs';
import {rigSections} from './rig-controls.mjs';
import {figureJoinAction} from './figure-join-action.mjs';
import {polygonSurfaceView} from './builder-surface-ui.mjs';
import {rigIKAllowed} from './rig-constraints.mjs';
import {cameraMotionView, parallaxView} from './camera-motion-ui.mjs';
import {paintCSS} from './paint.mjs';
import {figurePalette, displayedSegmentPaint, displayedColor} from './figure-colors.mjs';
import {isStatic} from './pivot/read-view.mjs';
import {cameraValues} from './pivot/model.mjs';
import {builderDrawables} from './editor-builder-style.mjs';
import {segmentBranchIndices} from './pivot/structure.mjs';
import {isBuilderContext} from './builder-aids.mjs';
import {partNameMessage, partGlyph} from './builder-outliner.mjs';
import {resolveInstanceFigure} from './animation-style.mjs';
import {ikSection} from './ik-view.mjs';
import {propertyToggle} from './property-toggle.mjs';
import {isMovieclip} from './movieclips.mjs';
import {movieclipSections, movieclipTarget} from './movieclip-ui.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';
import {iconNames} from './icons.mjs';
import {SectionMemory, renderInspector} from './inspector-kit.mjs';
import {esc, grid, group, heading, numericField, propertyPrecision} from './inspector-legacy.mjs';

const hex = rgb => `#${(rgb || [43, 43, 43]).map(n => (Math.round(n)).toString(16).padStart(2, '0')).join('')}`;
const num = n => Number(Number(n ?? 0).toFixed(2));
const degrees = radians => (radians * 180) / Math.PI;
const opacity = raw => (1 - (raw || 0) / 255) * 100;
const polygonOpacity = polygon => (polygon.alpha_raw !== undefined ? 1 - polygon.alpha_raw / 255 : polygon.color_alpha ?? 1) * 100;
const pageText = (start, size, total) => `${start + 1}–${Math.min(start + size, total)} / ${total}`;
const plural = (count, noun) => ({messageKey: 'counts.' + noun + 's', messageParams: {count}});
const known = new Set(iconNames);
/** The spec's glyph when icons.mjs has it (visual-system.md §10), else today's nearest drawing. */
const glyph = (name, fallback) => (known.has(name) ? name : fallback);
const STEP_DOWN = glyph('step-down', 'arrow-down'), STEP_UP = glyph('step-up', 'arrow-up');

/**
 * The titled sections' remembered state (SectionMemory): one per window,
 * shared by every render. configureInspectorSections() seeds it from the
 * inspectorSections setting and reports changes to the owner that saves it;
 * until an owner does, it remembers for this session.
 */
export const inspectorSections = new SectionMemory();
export function configureInspectorSections(saved, {onChange} = {}) {
  const memory = new SectionMemory(saved, {onChange});
  inspectorSections.saved = memory.saved;
  inspectorSections.onChange = memory.onChange;
  return inspectorSections;
}

let renderListener = null;
/**
 * `listener(descriptor, options)` runs after every inspectorView() render,
 * before the app writes the sections: the header (inspector-header.mjs)
 * writes the target, scope and quick actions from the same descriptor. One
 * listener; returns a function that removes it.
 */
export function onInspectorRender(listener) {
  renderListener = typeof listener === 'function' ? listener : null;
  return () => { if (renderListener === listener) renderListener = null; };
}

/** A figure's Layer select (Mixed across layers, locked layers disabled): "Layer Bubble ▾", or "Layer 1 ▾" when the name says it is a layer. */
function layerSelect(editor, extra = {}) {
  const ids = new Set([...editor.selectedUids].map(uid => editor.layerForUid(uid))), current = ids.size === 1 ? [...ids][0] : '';
  const layers = editor.layers.filter(layer => layer.kind === 'layer').reverse();
  const name = layers.find(layer => layer.id === current)?.name ?? '';
  return {
    kind: 'select', id: 'figure-layer', label: interfaceText("inspectorView.layer"), labelKey: "inspectorView.layer", description: interfaceText("inspectorView.figureLayer"), descriptionKey: "inspectorView.figureLayer", placeholder: interfaceText("inspectorView.mixed"), placeholderKey: "inspectorView.mixed", value: current || undefined,
    bare: /^layer\b/i.test(name), options: layers.map(layer => ({value: layer.id, label: layer.name, disabled: layer.locked})), ...extra,
  };
}

/** A builder order's four steps for one drawable. */
const orderActions = (kind, index, labelKey) => ({kind: 'actions', label: interfaceText(labelKey), labelKey, items: [
  messageTuple(['back', 'send-to-back', interfaceText("inspectorView.sendToBack")], {2: {key: "inspectorView.sendToBack", params: {}}}), messageTuple(['down', STEP_DOWN, interfaceText("inspectorView.sendBackward")], {2: {key: "inspectorView.sendBackward", params: {}}}), messageTuple(['up', STEP_UP, interfaceText("inspectorView.bringForward")], {2: {key: "inspectorView.bringForward", params: {}}}), messageTuple(['front', 'bring-to-front', interfaceText("inspectorView.bringToFront")], {2: {key: "inspectorView.bringToFront", params: {}}}),
].map(tuple => {const [direction, icon, label] = tuple, caption = tupleMessages(tuple)[2]; return {action: 'builder-order', icon, label, labelKey: caption.key, data: {kind, index, direction}};})});

/**
 * The scope line while Edit together is on: the frames an edit reaches
 * ("Editing frames 22–28 · Stop"). Ticks in a layer-sheet document, frame
 * indices in a classic one; a gap reads as a count.
 */
function scopeLine(editor, indices, applyRange) {
  if (!applyRange || indices.length < 2) return null;
  const frames = [...new Set(indices)].sort((a, b) => a - b), first = frames[0], last = frames.at(-1);
  const label = last - first + 1 === frames.length ? interfaceText('inspectorView.editingFrameRange', {first: first + 1, last: last + 1}) : interfaceText('inspectorView.editingFrames', {count: frames.length});
  return {label, labelKey: last - first + 1 === frames.length ? 'inspectorView.editingFrameRange' : 'inspectorView.editingFrames', labelParams: {first: first + 1, last: last + 1, count: frames.length}, stop: {action: 'toggle-range-edit', label: interfaceText("inspectorView.stop"), labelKey: "inspectorView.stop", tip: interfaceText("inspectorView.editOnlyThisFrame"), tipKey: "inspectorView.editOnlyThisFrame"}};
}

/** Edit together, as the checkbox that mirrors the timeline header's (#range-edit): shown while two or more frames are selected. */
const rangeSection = (indices, applyRange) => ({id: 'range', hidden: indices.length <= 1, rows: [{kind: 'grid', rows: [
  {kind: 'field-switch', id: 'apply-range-movement', label: interfaceText("inspectorView.editFramesTogether", {length: indices.length}), labelKey: "inspectorView.editFramesTogether", labelParams: {length: indices.length}, checked: applyRange, span: 2,
    tip: interfaceText("inspectorView.applyCanvasMovesAndFigureCommandsToEvery"), tipKey: "inspectorView.applyCanvasMovesAndFigureCommandsToEvery"},
]}]});

/**
 * The target's kind and label as the shell names them (#inspector-context,
 * #inspector[data-selection-kind]): Figure, Figures, Joint, Scene, Camera,
 * Layer, Timing or Drawing.
 */
function targetKind({editor, context = 'auto', drawing, tab = 'design'}) {
  if (drawing?.active) return {label: interfaceText("inspectorView.drawing"), labelKey: "inspectorView.drawing", selection: 'drawing'};
  const resolved = context === 'auto' ? (tab === 'animation' ? 'frame' : editor.object ? 'figure' : 'scene') : context;
  const count = editor.selectedUids?.size || 0, joint = editor.figure?.segments?.[editor.selectedJoint];
  if (!['camera', 'scene', 'layer', 'frame'].includes(resolved) && editor.object)
    return count > 1 ? {label: interfaceText("inspectorView.figures"), labelKey: "inspectorView.figures", selection: 'figures'} : joint ? {label: interfaceText("inspectorView.joint"), labelKey: "inspectorView.joint", selection: 'joint'} : {label: interfaceText("inspectorView.figure"), labelKey: "inspectorView.figure", selection: 'figure'};
  const label = {camera: interfaceText("inspectorView.camera"), scene: interfaceText("inspectorView.scene"), layer: interfaceText("inspectorView.layer"), frame: interfaceText("inspectorView.timing")}[resolved] ?? (count > 1 ? interfaceText('inspectorView.selectedFigures', {count}) : interfaceText("inspectorView.scene"));
  return {label, selection: resolved};
}

/**
 * The current context: {kind, target: {name, glyph, rename, label, selection},
 * quick: {context} | null, scope, sections}. Options are inspectorView()'s;
 * propertyState(key) may supply a live value ({value}) for a property while it
 * is being edited.
 */
export function inspectorDescriptor(options) {
  const descriptor = contextDescriptor(options);
  return {quick: null, scope: null, ...descriptor, target: {...targetKind(options), ...descriptor.target}};
}

function contextDescriptor({
  editor, tab = 'design', tool = 'select', rigMode = 'move', selectionCount = 1, bounds, rangeIndices = [], applyRange = false,
  polygonPage = 0, palettePage = 0, context = 'auto', propertyState, builderBranch = false, builder = false, drawing, hotkeyLabel,
}) {
  const number = (label, key, value, unit = '', extra = {}) =>
    ({kind: 'number', key, label, unit, value: propertyState?.(key)?.value ?? value, precision: propertyPrecision(key), ...extra});
  if (drawing?.active) return drawingDescriptor(editor, drawing, number, hotkeyLabel);
  const object = editor.object;
  const resolved = context === 'auto' ? (tab === 'animation' ? 'frame' : object ? 'figure' : 'scene') : context;
  if (resolved === 'camera') return cameraDescriptor(editor, number);
  if (resolved === 'layer') return layerDescriptor(editor);
  if (resolved === 'frame') return frameDescriptor(editor, number);
  if (resolved === 'scene' || !object) return sceneDescriptor(editor, number, propertyState);
  const scope = scopeLine(editor, rangeIndices, applyRange), range = rangeSection(rangeIndices, applyRange);
  if (selectionCount === 1 && isMovieclip(editor.figure)) {
    return {kind: 'movieclip', target: movieclipTarget(editor), quick: {context: 'movieclip'}, scope,
      sections: [range, ...movieclipSections(editor, {number, layer: layerSelect(editor)})]};
  }
  if (selectionCount > 1) return selectionDescriptor(editor, number, {bounds, selectionCount, range, scope});
  const figure = resolveInstanceFigure(editor.figure, object), joint = editor.selectedJoint;
  const drawingSets = drawingSetsSection(builder ? '' : joinedDrawingSetsView(editor));
  if (!builder && figure.segments.some(segment => segment._stykRig?.spatial?.origin)) {
    return {kind: 'spatial-rig', target: {name: figure.name || interfaceText("inspectorView.figure"), ...(!figure.name?{nameKey:"inspectorView.figure"}:{}), rename: figureRename}, quick: {context: 'figure'}, scope, sections: [
      range, drawingSets, ...spatialSections(editor, {hotkeyLabel}),
      {id: 'placement', title: interfaceText("inspectorView.placement"), titleKey: "inspectorView.placement", place: 'titled', open: true, hidden: joint >= 0, rows: [{kind: 'grid', rows: [
        number('X', 'root_x', object.root_x, 'px'), number('Y', 'root_y', object.root_y, 'px'), number(interfaceText("inspectorView.scale"), 'scale', object.scale * 100, '%', {min: 0.01, labelKey: "inspectorView.scale", labelParams: {}}),
      ]}]},
    ]};
  }
  if (builder && editor.selectedPolygonIndex >= 0) return fillDescriptor(editor, figure, number);
  const segment = figure.segments[joint];
  const order = new Map(builderDrawables(figure).map((item, index) => [`${item.kind}:${item.index}`, index + 1]));
  const shared = {range, scope, drawingSets, spatial: builder ? [] : spatialSections(editor, {hotkeyLabel}), order, tool, builder, builderBranch};
  // Pivot origins use -1; segment endpoint indices start at zero.
  return joint >= 0 && segment
    ? jointDescriptor(editor, figure, segment, number, shared)
    : figureDescriptor(editor, figure, number, {...shared, polygonPage, palettePage});
}

const figureRename = {id: 'figure-name', description: interfaceText("inspectorView.figureName"), descriptionKey: "inspectorView.figureName", tip: interfaceText("inspectorView.doubleClickToRenameTheFigureDefinition"), tipKey: "inspectorView.doubleClickToRenameTheFigureDefinition"};

/** Drawing sets of the drawing banks joined to the selected figure: a titled section, open while it has any. */
const drawingSetsSection = html => ({id: 'drawing-sets', title: interfaceText("inspectorView.drawingSets"), titleKey: "inspectorView.drawingSets", place: 'titled', open: Boolean(html), hidden: !html,
  rows: [{kind: 'markup', html}]});

/**
 * The Properties panel's sections for the current context (the only content
 * of #inspector, through updateInspectorDOM()). The header receives the same
 * descriptor through onInspectorRender().
 */
export function inspectorView(options) {
  const descriptor = inspectorDescriptor(options);
  const html = renderInspector(descriptor, {memory: inspectorSections});
  renderListener?.(descriptor, options);
  return html;
}

/** Draw keeps drawing-view's own markup, edge to edge, until its tools move to descriptors (M7b). */
function drawingDescriptor(editor, drawing, number, hotkeyLabel) {
  const o = editor.object, f = editor.figure;
  const field = (label, key, value, unit, limits = '',labelKey) => numericField(label, key, number(label, key, value).value, unit, limits,{}, {labelKey});
  const pose = drawing.tool === 'transform' && o ? `<section class="inspector-section"><div class="inspector-title"><span data-i18n="inspectorView.transformDrawing">${messageHTML("inspectorView.transformDrawing", {})}</span></div>${grid(
    field('X', 'root_x', o.root_x, 'px') + field('Y', 'root_y', o.root_y, 'px') + field(interfaceText("inspectorView.scale"), 'scale', o.scale * 100, '%', 'min="0.01"','inspectorView.scale') +
    field(interfaceText("inspectorView.angle"), 'rotation', ((o.angles[0] ?? 0) - (f.segments[0]?.angle_rad ?? 0)) * 180 / Math.PI, '°','','inspectorView.angle') +
    field(interfaceText("inspectorView.opacity"), 'figure_opacity', (1 - (o.field28 ?? 0) / 255) * 100, '%', 'min="0" max="100"','inspectorView.opacity'))}</section>` : '';
  const html = drawingInspector(drawing, {numericField, group, grid, heading, hotkeyLabel, esc, propertyToggle}, pose);
  // The panel's title names the tool ("Brush", "Fill"), with its glyph; drawing-view's own heading row steps aside.
  const toolTuple=DRAWING_TOOLS.find(entry => entry[0] === drawing.tool),nameKey=toolTuple?tupleMessages(toolTuple)[1].key:"inspectorView.drawing",name=interfaceText(nameKey),glyph=toolTuple?.[2]??'brush';
  return {kind: 'drawing', target: {name, nameKey, glyph}, sections: [{id: 'drawing', bare: true, rows: [{kind: 'markup', html}]}]};
}

function sceneDescriptor(editor, number, propertyState) {
  const report = editor.report, frame = editor.frame, colorState = propertyState?.('scene_color'), backgroundState = propertyState?.('scene_background');
  const background = report.backgrounds?.find(item => item.background_id === (backgroundState?.value ?? frame.background_id));
  const raw = colorState?.value ?? background?.color ?? 0xffffffff;
  const color = typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : `#${(raw & 0xffffff).toString(16).padStart(6, '0')}`;
  const name = background?.name || interfaceText("inspectorView.white"), figures = editor.frame.objects.length, frames = editor.totalTicks ?? report.keyframes.length;
  const scopes = editor._movieclipScopes ?? [];
  return {kind: 'scene', target: {name: scopes.length ? scopes.map(scope => scope.name).join(' › ') : interfaceText("inspectorView.scene"), ...(!scopes.length?{nameKey:'inspectorView.scene'}:{}), glyph: scopes.length ? 'frame' : 'scene'}, sections: [
    {id: 'summary', rows: [{kind: 'meta', text: interfaceText("inspectorView.s", {value: plural(figures, 'figure'), value2: plural(frames, 'frame'), value3: num(frames / report.fps)}), textKey: "inspectorView.s", textParams: {value: plural(figures, 'figure'), value2: plural(frames, 'frame'), value3: num(frames / report.fps)}}]},
    {id: 'canvas', title: interfaceText("inspectorView.canvas"), titleKey: "inspectorView.canvas", rows: [{kind: 'grid', rows: [
      number(interfaceText("inspectorView.width"), 'canvas_width', report.canvas_width, 'px', {min: 1, max: 16384, labelKey: "inspectorView.width", labelParams: {}}), number(interfaceText("inspectorView.height"), 'canvas_height', report.canvas_height, 'px', {min: 1, max: 16384, labelKey: "inspectorView.height", labelParams: {}}),
    ]}]},
    {id: 'background', title: interfaceText("inspectorView.background"), titleKey: "inspectorView.background", actions: [{action: 'import-background', icon: 'image', label: interfaceText("inspectorView.importBackground"), labelKey: "inspectorView.importBackground", tip: interfaceText("inspectorView.backgroundImage"), tipKey: "inspectorView.backgroundImage"}], rows: [
      {kind: 'grid', rows: [
        {kind: 'color', id: 'background-color', label: interfaceText("inspectorView.backgroundColor"), labelKey: "inspectorView.backgroundColor", value: color, caption: name, tip: name},
        {kind: 'actions', items: [{action: 'background-style', icon: 'sliders', label: interfaceText("inspectorView.library"), labelKey: "inspectorView.library", text: true, variant: 'outline', tip: interfaceText("inspectorView.backgroundSettings"), tipKey: "inspectorView.backgroundSettings"}]},
      ]},
    ]},
    {id: 'playback', title: interfaceText("inspectorView.playback"), titleKey: "inspectorView.playback", rows: [{kind: 'grid', rows: [number(interfaceText("inspectorView.rate"), 'fps', report.fps, 'fps', {min: 1, max: 120, labelKey: "inspectorView.rate", labelParams: {}})]}]},
  ]};
}

/**
 * The camera: its preview (Guides as its title action), the Transform │
 * Motion switch, Transform (Copy and Paste as its title actions) and the
 * rarer framing commands in Framing. Level, Centre and Reset are its quick
 * actions. The Motion pane stays camera-motion-ui's until M7e.
 */
function cameraDescriptor(editor, number) {
  const c = cameraValues((editor.evaluatedFrame || editor.frame).camera), motion = editor._cameraInspectorTab === 'motion';
  const selected = Boolean(editor.selectedObjects?.length ?? editor.object);
  return {kind: 'camera', target: {name: interfaceText('inspectorView.camera'), nameKey:'inspectorView.camera', glyph: 'camera'}, quick: {context: 'camera'}, sections: [
    {id: 'preview', title: interfaceText("inspectorView.preview"), titleKey: "inspectorView.preview", actions: [{action: 'camera-guides', icon: 'grid', label: interfaceText("inspectorView.guides"), labelKey: "inspectorView.guides", tip: interfaceText("inspectorView.showCompositionGuides"), tipKey: "inspectorView.showCompositionGuides", pressed: true}], rows: [
      {kind: 'preview', label: interfaceText("inspectorView.liveCameraOutput"), labelKey: "inspectorView.liveCameraOutput", media: {tag: 'canvas', key: 'camera-monitor', label: interfaceText("inspectorView.liveCameraOutput"), labelKey: "inspectorView.liveCameraOutput", data: {'camera-monitor': true}},
        caption: [`${editor.report.canvas_width} × ${editor.report.canvas_height}`, {text: interfaceText("inspectorView.zoom2", {value: num(100 / c.scale)}), textKey: "inspectorView.zoom2", textParams: {value: num(100 / c.scale)}, data: {'camera-magnification': true}}]},
    ]},
    {id: 'tabs', rows: [{kind: 'segmented', mode: 'tab', description: interfaceText("inspectorView.cameraControls"), descriptionKey: "inspectorView.cameraControls", fill: true, value: motion ? 'motion' : 'transform', options: [
      {value: 'transform', label: interfaceText("inspectorView.transform"), labelKey: "inspectorView.transform", data: {'camera-tab': 'transform'}}, {value: 'motion', label: interfaceText("inspectorView.motion"), labelKey: "inspectorView.motion", data: {'camera-tab': 'motion'}},
    ]}]},
    {id: 'transform', title: interfaceText("inspectorView.transform"), titleKey: "inspectorView.transform", hidden: motion, actions: [
      {action: 'camera-copy', icon: 'duplicate', label: interfaceText("inspectorView.copyCameraPose"), labelKey: "inspectorView.copyCameraPose"},
      {action: 'camera-paste', icon: 'clipboard', label: interfaceText("inspectorView.pasteCameraPose"), labelKey: "inspectorView.pasteCameraPose", disabled: !editor._cameraClipboard},
    ], rows: [{kind: 'grid', rows: [
      number('X', 'camera_x', c.x || 0, 'px'), number('Y', 'camera_y', c.y || 0, 'px'),
      number(interfaceText("inspectorView.zoom"), 'camera_scale', (c.scale || 1) * 100, '%', {min: 0.01, description: interfaceText("inspectorView.scale2"), descriptionKey: "inspectorView.scale2", labelKey: "inspectorView.zoom", labelParams: {}}), number(interfaceText("inspectorView.rotation"), 'camera_angle', degrees(c.angle_rad || 0), '°', {labelKey: "inspectorView.rotation", labelParams: {}}),
    ]}]},
    {id: 'framing', title: interfaceText("inspectorView.framing"), titleKey: "inspectorView.framing", place: 'titled', hidden: motion, rows: [
      {kind: 'actions', label: interfaceText("inspectorView.fit"), labelKey: "inspectorView.fit", items: [{action: 'camera-align-view', icon: 'fit', label: interfaceText("inspectorView.fitView"), labelKey: "inspectorView.fitView", text: true, variant: 'outline', tip: interfaceText("inspectorView.fitCameraToCurrentCanvasView"), tipKey: "inspectorView.fitCameraToCurrentCanvasView"}]},
      {kind: 'actions', label: interfaceText("inspectorView.centreOnSelection"), labelKey: "inspectorView.centreOnSelection", items: [
        {action: 'camera-center-x', icon: 'align-horizontal-center', label: interfaceText("inspectorView.centerCameraHorizontally"), labelKey: "inspectorView.centerCameraHorizontally", disabled: !selected},
        {action: 'camera-center-y', icon: 'align-vertical-center', label: interfaceText("inspectorView.centerCameraVertically"), labelKey: "inspectorView.centerCameraVertically", disabled: !selected},
        {action: 'camera-locate-previous', icon: 'chevron-left', label: interfaceText("inspectorView.matchPreviousCameraPose"), labelKey: "inspectorView.matchPreviousCameraPose", disabled: editor.frameIndex <= 0},
        {action: 'camera-locate-next', icon: 'chevron-right', label: interfaceText("inspectorView.matchNextCameraPose"), labelKey: "inspectorView.matchNextCameraPose", disabled: editor.frameIndex >= editor.report.keyframes.length - 1},
        {action: 'camera-apply-figures', icon: 'check', label: interfaceText("inspectorView.applyCameraTransformToFigures"), labelKey: "inspectorView.applyCameraTransformToFigures"},
      ]},
    ]},
    {id: 'motion', bare: true, hidden: !motion, rows: [{kind: 'markup', html: cameraMotionView(editor)}]},
  ]};
}

function frameDescriptor(editor, number) {
  if (editor.report._styk?.layerSheet) {
    const track = editor.report._styk.layerSheet.tracks[editor.activeLayerId], {key, next} = sheetKeyAt(track, editor.tick);
    return {kind: 'frame', target: {name: interfaceText('filmstrip.card', {frame:editor.tick + 1}), nameKey:'filmstrip.card', nameParams:{frame:editor.tick + 1}}, sections: [
      {id: 'exposure', title: editor.getLayer(editor.activeLayerId)?.name ?? interfaceText("inspectorView.layer"),
        actions: [{action: 'add-frame', icon: glyph('frame-plus', 'plus'), label: interfaceText("inspectorView.insertKeyframeF6"), labelKey: "inspectorView.insertKeyframeF6", tip: interfaceText("inspectorView.addFrame"), tipKey: "inspectorView.addFrame"}], rows: [{kind: 'grid', rows: [
          number(interfaceText("inspectorView.exposure"), 'duration', (next?.tick ?? track?.end ?? editor.tick + 1) - (key?.tick ?? editor.tick), 'frames', {min: 1, max: 65535, labelKey: "inspectorView.exposure", labelParams: {}}),
        ]}]},
    ]};
  }
  return {kind: 'keyframe', target: {name: interfaceText('inspectorView.keyframe', {frame: (editor.frameIndex ?? 0) + 1}), nameKey:'inspectorView.keyframe', nameParams:{frame:(editor.frameIndex ?? 0) + 1}}, sections: [
    {id: 'timing', title: interfaceText("inspectorView.timing"), titleKey: "inspectorView.timing", rows: [{kind: 'grid', rows: [number(interfaceText("inspectorView.duration"), 'duration', editor.frame.duration_raw ?? 1, 'ticks', {min: 0, max: 65535, labelKey: "inspectorView.duration", labelParams: {}})]}]},
  ]};
}

/** A layer: its name and, from camera-motion-ui, its Parallax (the row's eye and lock show and lock it). */
function layerDescriptor(editor) {
  const layer = editor.getLayer?.(editor.activeLayerId) ?? {id: 'layer-1', name: 'Layer', visible: true, locked: false, figureUids: []};
  const data = {'layer-id': layer.id};
  return {kind: 'layer', target: {name: layer.name, glyph: 'layers'}, sections: [
    {id: 'layer', title: interfaceText("inspectorView.layer"), titleKey: "inspectorView.layer", rows: [{kind: 'grid', rows: [
      {kind: 'text', id: 'inspector-layer-name', label: interfaceText("common.name"), labelKey: "common.name", description: interfaceText("inspectorView.layerName"), descriptionKey: "inspectorView.layerName", value: layer.name, maxlength: 160, data, span: 2},
    ]}]},
    {id: 'parallax', bare: true, rows: [{kind: 'markup', html: parallaxView(editor, layer.id)}]},
  ]};
}

/** Several figures: Selection (Rotate 15° and Centre as its actions), Align's six, Appearance, and Arrange's layer and one-step order. */
function selectionDescriptor(editor, number, {bounds: b, selectionCount, range, scope}) {
  const objects = editor.selectedObjects ?? [editor.object], object = editor.object;
  const opacities = new Set(objects.map(item => item.field28 || 0));
  const figureOf = item => resolveInstanceFigure(editor.report.figure_types.find(type => type.figure_type_id === item.figure_type_id), item);
  const colours = new Set(objects.flatMap(item => figurePalette(editor.report, figureOf(item), item).map(entry => entry.color)));
  const joined = objects.some(item => item.join) || editor.frame.objects.some(part => part.join && objects.some(item => item.object_slot === part.join.target_object_slot));
  const align = [messageTuple(['left', 'align-left', interfaceText("inspectorView.alignLeft")], {2: {key: "inspectorView.alignLeft", params: {}}}), messageTuple(['center-x', 'align-horizontal-center', interfaceText("inspectorView.alignCenter")], {2: {key: "inspectorView.alignCenter", params: {}}}), messageTuple(['right', 'align-right', interfaceText("inspectorView.alignRight")], {2: {key: "inspectorView.alignRight", params: {}}}),
    messageTuple(['top', 'align-top', interfaceText("inspectorView.alignTop")], {2: {key: "inspectorView.alignTop", params: {}}}), messageTuple(['center-y', 'align-vertical-center', interfaceText("inspectorView.alignMiddle")], {2: {key: "inspectorView.alignMiddle", params: {}}}), messageTuple(['bottom', 'align-bottom', interfaceText("inspectorView.alignBottom")], {2: {key: "inspectorView.alignBottom", params: {}}})];
  return {kind: 'figures', target: {name: interfaceText('inspectorView.selectedFigures', {count: selectionCount}), nameKey:'inspectorView.selectedFigures', nameParams:{count:selectionCount}}, quick: {context: 'figures'}, scope, sections: [
    range,
    {id: 'selection', title: interfaceText("inspectorView.selection"), titleKey: "inspectorView.selection", actions: [
      {action: 'rotate', label: interfaceText("inspectorView.rotate15"), labelKey: "inspectorView.rotate15", text: true, tip: interfaceText("inspectorView.rotateTheSelection15"), tipKey: "inspectorView.rotateTheSelection15"}, {action: 'center', label: interfaceText("inspectorView.center"), labelKey: "inspectorView.center", text: true, tip: interfaceText("inspectorView.centerSelection"), tipKey: "inspectorView.centerSelection"},
    ], rows: [{kind: 'grid', rows: [
      number('X', 'group_x', b.minX, 'px'), number('Y', 'group_y', b.minY, 'px'),
      number('W', 'group_width', b.maxX - b.minX, 'px', {min: 0.01, description: interfaceText("inspectorView.widthPx"), descriptionKey: "inspectorView.widthPx"}), number('H', 'group_height', b.maxY - b.minY, 'px', {min: 0.01, description: interfaceText("inspectorView.heightPx"), descriptionKey: "inspectorView.heightPx"}),
    ]}]},
    {id: 'align', title: interfaceText("inspectorView.align"), titleKey: "inspectorView.align", rows: [{kind: 'actions', label: interfaceText("inspectorView.align"), labelKey: "inspectorView.align", items: align.map((_tuple) => {const [name, icon, label] = _tuple; const _messages = tupleMessages(_tuple); return {action: `align-${name}`, icon, label, ...(_messages[2] ? {labelKey: _messages[2].key, labelParams: _messages[2].params} : {})};})}]},
    {id: 'appearance', title: interfaceText("inspectorView.appearance"), titleKey: "inspectorView.appearance", actions: [{action: 'reset-color', icon: 'reset', label: interfaceText("inspectorView.resetColors"), labelKey: "inspectorView.resetColors"}], rows: [{kind: 'grid', rows: [
      {kind: 'color', id: 'figure-color', label: interfaceText("inspectorView.colour"), labelKey: "inspectorView.colour", description: interfaceText("inspectorView.figureColor"), descriptionKey: "inspectorView.figureColor", value: colours.size === 1 ? [...colours][0] : '#2b2b2b', mixed: colours.size > 1},
      number(interfaceText("inspectorView.opacity"), 'figure_opacity', opacity(object.field28), '%', {min: 0, max: 100, id: 'figure-opacity', field: false, mixed: opacities.size > 1, labelKey: "inspectorView.opacity", labelParams: {}}),
    ]}]},
    {id: 'arrange', title: interfaceText("inspectorView.arrange"), titleKey: "inspectorView.arrange", rows: [{kind: 'grid', ratio: '3:2', rows: [
      layerSelect(editor),
      {kind: 'actions', label: interfaceText("inspectorView.oneStep"), labelKey: "inspectorView.oneStep", items: [
        {action: 'layer-down', icon: STEP_DOWN, label: interfaceText("inspectorView.sendBackward"), labelKey: "inspectorView.sendBackward"}, {action: 'layer-up', icon: STEP_UP, label: interfaceText("inspectorView.bringForward"), labelKey: "inspectorView.bringForward"},
      ]},
    ]}]},
    {id: 'connection', title: interfaceText("inspectorView.connection"), titleKey: "inspectorView.connection", place: 'titled', hidden: !joined, rows: [{kind: 'actions', items: [
      {action: 'combine-figures', icon: 'combine', label: interfaceText("inspectorView.combineConnected"), labelKey: "inspectorView.combineConnected", text: true, variant: 'outline'},
    ]}]},
  ]};
}

/** A fill picked in the builder: its colour, delete, opacity, surface and order. */
function fillDescriptor(editor, figure, number) {
  const index = editor.selectedPolygonIndex, polygon = figure.polyfills[index];
  return {kind: 'fill', target: {name: interfaceText('inspectorView.fillNumber', {index:index + 1}), nameKey:'inspectorView.fillNumber', nameParams:{index:index + 1}, glyph: 'polygon'}, sections: [{id: 'fill', title: interfaceText("inspectorView.fill"), titleKey: "inspectorView.fill", rows: [
    {kind: 'list-row', label: interfaceText("inspectorView.polygon", {value: index + 1}), labelKey: "inspectorView.polygon", labelParams: {value: index + 1}, lead: 'polygon', actions: [
      {kind: 'swatch', picker: 'native', label: interfaceText("inspectorView.fillColor"), labelKey: "inspectorView.fillColor", value: hex(displayedColor(editor.report, figure, editor.object, polygon.color_rgb)), data: {'polygon-color': index}},
      {icon: 'trash', label: interfaceText("inspectorView.deleteFill"), labelKey: "inspectorView.deleteFill", data: {'delete-polygon': index}},
    ]},
    {kind: 'grid', rows: [number(interfaceText("inspectorView.opacity"), `polygon_${index}_opacity`, polygonOpacity(polygon), '%', {min: 0, max: 100, labelKey: "inspectorView.opacity", labelParams: {}})]},
    {kind: 'markup', html: polygonSurfaceView(editor, index)},
    orderActions('polygon', index, 'inspectorView.fillOrder'),
  ]}]};
}

/** One fill of the figure: its row (colour, delete), its opacity and order, and the four order steps; keyed by data-polygon-index. */
function fillGroup(editor, figure, object, index, order) {
  const polygon = figure.polyfills[index], nameMessage={messageKey:"inspectorView.polygon",messageParams:{value:index + 1}}, name=interfaceText(nameMessage.messageKey,nameMessage.messageParams);
  return {kind: 'group', label: name, labelKey:nameMessage.messageKey,labelParams:nameMessage.messageParams, data: {'polygon-index': index}, rows: [
    {kind: 'list-row', label: name, labelKey:nameMessage.messageKey,labelParams:nameMessage.messageParams, lead: 'polygon', actions: [
      {kind: 'swatch', picker: 'native', value: hex(displayedColor(editor.report, figure, object, polygon.color_rgb)), label: interfaceText("inspectorView.color", {name: nameMessage}), labelKey: "inspectorView.color", labelParams: {name: nameMessage}, data: {'polygon-color': index}},
      {icon: 'trash', label: interfaceText("inspectorView.deletePolygon", {value: index + 1}), labelKey: "inspectorView.deletePolygon", labelParams: {value: index + 1}, data: {'delete-polygon': index}},
    ]},
    {kind: 'grid', rows: [
      {kind: 'number', key: `polygon_${index}_opacity`, label: interfaceText("inspectorView.opacity"), labelKey: "inspectorView.opacity", unit: '%', value: polygonOpacity(polygon), min: 0, max: 100, precision: 3},
      {kind: 'number', key: `polygon_${index}_z_order`, label: interfaceText("inspectorView.order"), labelKey: "inspectorView.order", precision: 0, value: order.get(`polygon:${index}`), min: 1, max: order.size},
    ]},
    orderActions('polygon', index, 'inspectorView.fillOrder'),
  ]};
}

/**
 * One figure, text or image: Transform, Appearance (Reset colours) and
 * Arrange (Layer, the Order stepper; Join… as its action) are open; the
 * connection, the used colours and fills and the drawing sets are titled.
 */
function figureDescriptor(editor, figure, number, {range, scope, drawingSets, spatial, order, builder, polygonPage, palettePage}) {
  const report = editor.report, frame = editor.frame, object = editor.object;
  // A joint index past the figure's segments shows the figure, without its colours.
  const whole = editor.selectedJoint < 0, palette = whole ? editor.figurePalette() : [], own = whole ? figurePalette(report, figure, object) : [];
  const kind = figure.segments.every(segment => segment.primitive_code === 5) ? 'text' : figure.segments.every(segment => segment.primitive_code === 2) ? 'image' : 'figure';
  const children = frame.objects.some(part => part.join?.target_object_slot === object.object_slot);
  const parent = object.join ? frame.objects[object.join.target_object_slot] : null;
  const parentName = parent && (parent.name || report.figure_types.find(type => type.figure_type_id === parent.figure_type_id)?.name || interfaceText("inspectorView.figure"));
  const polygons = figure.polyfills || [], start = Math.min(Math.max(0, polygonPage) * 12, Math.max(0, Math.floor((polygons.length - 1) / 12) * 12));
  const paletteStart = Math.min(Math.max(0, palettePage) * 32, Math.max(0, Math.ceil(palette.length / 32) - 1) * 32);
  const joinLabel = parent ? interfaceText("inspectorView.unjoinFigure") : interfaceText("inspectorView.joinToFigure");
  // In Build the figure's tiles add parts and fit it; its looks lead, and its placement in the scene (Animate's)
  // folds last behind Transform's title. The rig tool's Drag mode is its option in the stage header.
  // Every selection's title carries its kind's glyph (a figure's person, a text's T, an image's frame).
  const transform = {id: 'transform', title: interfaceText("inspectorView.transform"), titleKey: "inspectorView.transform", place: builder ? 'titled' : 'core', rows: [{kind: 'grid', rows: [
    number('X', 'root_x', object.root_x, 'px'), number('Y', 'root_y', object.root_y, 'px'),
    number(interfaceText("inspectorView.angle"), 'rotation', degrees((object.angles[0] ?? 0) - (figure.segments[0]?.angle_rad ?? 0)), '°', {labelKey: "inspectorView.angle", labelParams: {}}),
    number(interfaceText("inspectorView.scale"), 'scale', object.scale * 100, '%', {min: 0.01, labelKey: "inspectorView.scale", labelParams: {}}),
  ]}]};
  return {kind, target: {name: figure.name || interfaceText("inspectorView.figure"), ...(!figure.name?{nameKey:"inspectorView.figure"}:{}), glyph: kind === 'text' ? 'text' : kind === 'image' ? 'image' : 'person', rename: figureRename},
    quick: {context: builder ? 'build' : kind}, scope, sections: [
      range, drawingSets, ...spatial,
      {id: 'text', title: interfaceText("inspectorView.text"), titleKey: "inspectorView.text", hidden: kind !== 'text' && !figure.text_assets?.some(asset => asset.glyphs?.length), rows: [{kind: 'actions', items: [
        {action: 'edit-text', icon: 'text', label: interfaceText("inspectorView.editText"), labelKey: "inspectorView.editText", text: true, variant: 'outline', tip: interfaceText("inspectorView.editText2"), tipKey: "inspectorView.editText2"},
      ]}]},
      !builder && transform,
      {id: 'appearance', title: interfaceText("inspectorView.appearance"), titleKey: "inspectorView.appearance", actions: [{action: 'reset-color', icon: 'reset', label: interfaceText("inspectorView.resetColors"), labelKey: "inspectorView.resetColors"}], rows: [{kind: 'grid', rows: [
        {kind: 'color', id: 'figure-color', label: interfaceText("inspectorView.colour"), labelKey: "inspectorView.colour", description: interfaceText("inspectorView.recolorAllSegments"), descriptionKey: "inspectorView.recolorAllSegments", value: own[0]?.color ?? '#000000', caption: own.length > 1 ? interfaceText("inspectorView.mixed") : undefined},
        number(interfaceText("inspectorView.opacity"), 'figure_opacity', opacity(object.field28), '%', {min: 0, max: 100, id: 'figure-opacity', field: false, labelKey: "inspectorView.opacity", labelParams: {}}),
      ]}]},
      {id: 'arrange', title: interfaceText("inspectorView.arrange"), titleKey: "inspectorView.arrange", place: kind === 'text' ? 'titled' : 'core', actions: [
        {action: 'join-figure', label: parent ? interfaceText("inspectorView.unjoin") : interfaceText("inspectorView.join"), labelKey: (parent ? "inspectorView.unjoin" : "inspectorView.join"), labelParams: (parent ? {} : {}), text: true, tip: joinLabel, data: {'hotkey-title': joinLabel}, disabled: !figureJoinAction(editor)},
      ], rows: [{kind: 'grid', ratio: '3:2', rows: [
        layerSelect(editor),
        {kind: 'stepper-field', key: 'figure_z_order', label: interfaceText("inspectorView.order"), labelKey: "inspectorView.order", description: interfaceText("inspectorView.zIndex"), descriptionKey: "inspectorView.zIndex", groupLabel: interfaceText("inspectorView.orderAndOneStepOrder"), value: object._stykZIndex ?? 0,
          precision: 0, min: -1000000, max: 1000000,
          down: {action: 'layer-down', label: interfaceText("inspectorView.sendBackward"), labelKey: "inspectorView.sendBackward", icon: STEP_DOWN}, up: {action: 'layer-up', label: interfaceText("inspectorView.bringForward"), labelKey: "inspectorView.bringForward", icon: STEP_UP}},
      ]}]},
      {id: 'connection', title: interfaceText("inspectorView.connection"), titleKey: "inspectorView.connection", place: 'titled', open: Boolean(parent), hidden: !parent && !children, rows: [
        {kind: 'value', label: interfaceText("inspectorView.joinedTo"), labelKey: "inspectorView.joinedTo", text: parent ? `${parentName} · ${object.join.target_handle_id}` : interfaceText("inspectorView.none")},
        {kind: 'actions', items: [{action: 'combine-figures', icon: 'combine', label: interfaceText("inspectorView.combineConnected"), labelKey: "inspectorView.combineConnected", text: true, variant: 'outline', tip: interfaceText("inspectorView.mergeTheConnectedFiguresIntoOne"), tipKey: "inspectorView.mergeTheConnectedFiguresIntoOne"}]},
      ]},
      {id: 'colours', title: interfaceText("inspectorView.colours"), titleKey: "inspectorView.colours", place: 'titled', hidden: !whole, rows: [
        {kind: 'swatches', label: interfaceText("inspectorView.figureColorPalette"), labelKey: "inspectorView.figureColorPalette", hidden: !palette.length, items: palette.slice(paletteStart, paletteStart + 32).map(entry => ({
          picker: 'paint', value: entry.color, tip: entry.color.toUpperCase(), data: {'palette-color': entry.color},
          label: interfaceText(entry.meshColors?.length ? 'inspectorView.replaceFigureColor' : entry.polygons.length ? 'inspectorView.replaceColorSegmentsAndFills' : 'inspectorView.replaceColorSegments', {color:entry.color.toUpperCase(), segments:{messageKey:'counts.segments', messageParams:{count:entry.segments.length}}, fills:{messageKey:'counts.fills', messageParams:{count:entry.polygons.length}}}),
          labelKey: entry.meshColors?.length ? 'inspectorView.replaceFigureColor' : entry.polygons.length ? 'inspectorView.replaceColorSegmentsAndFills' : 'inspectorView.replaceColorSegments', labelParams: {color:entry.color.toUpperCase(), segments:{messageKey:'counts.segments', messageParams:{count:entry.segments.length}}, fills:{messageKey:'counts.fills', messageParams:{count:entry.polygons.length}}},
        }))},
        palette.length > 32 && {kind: 'pager', label: interfaceText("inspectorView.colourPages"), labelKey: "inspectorView.colourPages", text: pageText(paletteStart, 32, palette.length),
          previous: {action: 'palette-previous', icon: 'chevron-left', label: interfaceText("inspectorView.previousColors"), labelKey: "inspectorView.previousColors", disabled: paletteStart === 0},
          next: {action: 'palette-next', icon: 'chevron-right', label: interfaceText("inspectorView.nextColors"), labelKey: "inspectorView.nextColors", disabled: paletteStart + 32 >= palette.length}},
        {kind: 'value', label: interfaceText("inspectorView.fills"), labelKey: "inspectorView.fills", text: polygons.length ? interfaceText('counts.fills', {count: polygons.length}) : interfaceText("inspectorView.noFills"), textKey: polygons.length ? 'counts.fills' : 'inspectorView.noFills', textParams: {count: polygons.length}},
        ...polygons.slice(start, start + 12).map((_, i) => fillGroup(editor, figure, object, start + i, order)),
        polygons.length > 12 && {kind: 'pager', label: interfaceText("inspectorView.fillPages"), labelKey: "inspectorView.fillPages", text: pageText(start, 12, polygons.length),
          previous: {action: 'polygons-previous', icon: 'chevron-left', label: interfaceText("inspectorView.previousPolygons"), labelKey: "inspectorView.previousPolygons", disabled: start === 0},
          next: {action: 'polygons-next', icon: 'chevron-right', label: interfaceText("inspectorView.nextPolygons"), labelKey: "inspectorView.nextPolygons", disabled: start + 12 >= polygons.length}},
      ]},
      builder && transform,
    ]};
}

/** A part renames in the header (double-click, F2), as a figure does. */
const partRename = {id: 'builder-joint-name', description: interfaceText("inspectorView.partName"), descriptionKey: "inspectorView.partName", maxlength: 120, tip: interfaceText("inspectorView.doubleClickToRenameThePart"), tipKey: "inspectorView.doubleClickToRenameThePart"};

/**
 * A joint (or a branch, or several segments): Joint (angle, length, bend,
 * Static), IK, Style and its figure's Layer are open; the second colour and a
 * connector's parts are titled. A connector's Slider part shows only the
 * slide and Static.
 *
 * In Build a joint is a part, and what people change most leads: Style
 * (colour, width, opacity, shape), then Geometry and Arrange (draw order and
 * layer); IK and Rig fold behind their titles and open while they are in use.
 * The part renames in the header, and the scope line says when edits reach
 * the whole branch (the rail's and stage header's Whole branch, or Shift).
 */
function jointDescriptor(editor, figure, segment, number, {range, scope, drawingSets, spatial, order, tool, builder, builderBranch}) {
  const report = editor.report, object = editor.object, joint = editor.selectedJoint, selected = editor.selectedSegmentIds;
  const connector = segment._stykRig?.connector, single = selected.size <= 1;
  const connectorScope = editor._connectorInspector;
  const part = connector && single ? (connectorScope?.uid === editor.selectedUid && connectorScope?.id === segment.segment_id ? connectorScope.part : 'slider') : null;
  const slider = part === 'slider';
  const paint = displayedSegmentPaint(report, figure, object, segment);
  const twoTone = [1, 3, 4].includes(segment.primitive_code) &&
    (single || figure.segments.every(item => !selected.has(item.segment_id) || [1, 3, 4].includes(item.primitive_code)));
  const secondary = twoTone && Boolean(segment.secondary);
  const shape = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'][segment.primitive_code ?? 0];
  const fixed = ['image', 'text'].includes(shape), lock = segment._stykRig?.angleLock;
  const solid = paint.type === 'solid';
  const position = object.len_flag ? object.lengths[joint] : segment.length;
  // In Build a joint is a part, named as Structure names it ("Line 4"); in Animate it is a joint.
  const ownMessage = builder ? partNameMessage(segment) : segment.name || {messageKey:'builderSurfaceUi.jointNumber',messageParams:{id:segment.segment_id}};
  const titleMessage = selected.size > 1 ? {messageKey:builder?'counts.parts':'counts.segments',messageParams:{count:selected.size}}
    : editor.branchSelected ? {messageKey:'inspectorView.branchFrom',messageParams:{name:ownMessage}} : ownMessage;
  const title = typeof titleMessage==='string'?titleMessage:interfaceText(titleMessage.messageKey,titleMessage.messageParams);
  const titleBinding = typeof titleMessage==='string'?{}:{nameKey:titleMessage.messageKey,nameParams:titleMessage.messageParams};
  const staticSwitch = {kind: 'field-switch', id: 'static-joint', label: interfaceText("inspectorView.static"), labelKey: "inspectorView.static", checked: isStatic(segment), tip: interfaceText("inspectorView.doesNotTurnWithItsParent"), tipKey: "inspectorView.doesNotTurnWithItsParent"};
  const colour = {kind: 'color', picker: 'paint', id: 'segment-color', label: interfaceText("inspectorView.colour"), labelKey: "inspectorView.colour", description: interfaceText("inspectorView.segmentColor"), descriptionKey: "inspectorView.segmentColor", value: solid ? hex(paint.stops[0].color) : undefined,
    paint: paintCSS(paint), caption: solid ? undefined : interfaceText('inspectorView.valueValue1Gradient', {value: {messageKey: 'colorPicker.' + paint.type}, value1: ''})};
  const width = number(interfaceText("inspectorView.width"), 'thickness', segment.thickness, 'px', {min: 0, labelKey: "inspectorView.width", labelParams: {}});
  const alpha = number(secondary ? interfaceText("inspectorView.primaryOpacity") : interfaceText("inspectorView.opacity"), 'segment_opacity', opacity(segment.transparency), '%',
    {min: 0, max: 100, id: 'segment-opacity', field: false, description: interfaceText("inspectorView.primaryColorOpacity"), descriptionKey: "inspectorView.primaryColorOpacity", labelKey: (secondary ? "inspectorView.primaryOpacity" : "inspectorView.opacity"), labelParams: (secondary ? {} : {})});
  const shapeSelect = {kind: 'select', id: 'segment-shape', label: interfaceText("inspectorView.shape"), labelKey: "inspectorView.shape", description: interfaceText("inspectorView.segmentShape"), descriptionKey: "inspectorView.segmentShape", value: shape, disabled: fixed, span: 2, options: [
    messageTuple(['line', interfaceText("inspectorView.roundLine")], {1: {key: "inspectorView.roundLine", params: {}}}), messageTuple(['squareLine', interfaceText("inspectorView.squareLine")], {1: {key: "inspectorView.squareLine", params: {}}}), messageTuple(['circle', interfaceText("inspectorView.whiteCircle")], {1: {key: "inspectorView.whiteCircle", params: {}}}), messageTuple(['circleFill', interfaceText("inspectorView.filledCircle")], {1: {key: "inspectorView.filledCircle", params: {}}}), messageTuple(['circleClear', interfaceText("inspectorView.clearCircle")], {1: {key: "inspectorView.clearCircle", params: {}}}),
    ...(fixed ? [messageTuple([shape, interfaceText(shape === 'image' ? 'builderOutliner.image' : 'inspectorView.text')], {1: {key: shape === 'image' ? 'builderOutliner.image' : 'inspectorView.text'}})] : []),
  ].map((_tuple) => {const [value, label] = _tuple; const _messages = tupleMessages(_tuple); return {value, label, ...(_messages[1] ? {labelKey: _messages[1].key, labelParams: _messages[1].params} : {})};})};
  const sections = {
    connector: {id: 'connector', title: interfaceText("inspectorView.connector", {segment_id: segment.segment_id}), titleKey: "inspectorView.connector", titleParams: {segment_id: segment.segment_id}, place: 'titled', open: true, hidden: !part, rows: [
      {kind: 'segmented', mode: 'pressed', description: interfaceText("inspectorView.connectorProperties"), descriptionKey: "inspectorView.connectorProperties", value: part, fill: true, options: [
        {value: 'segment', label: interfaceText("inspectorView.segment"), labelKey: "inspectorView.segment", data: {'connector-part': 'segment'}}, {value: 'slider', label: interfaceText("inspectorView.slider"), labelKey: "inspectorView.slider", data: {'connector-part': 'slider'}},
      ]},
    ]},
    slider: {id: 'slider', title: interfaceText("inspectorView.slider"), titleKey: "inspectorView.slider", hidden: !slider, rows: [{kind: 'grid', rows: [
      {kind: 'number', id: 'rig-position', label: interfaceText("inspectorView.position"), labelKey: "inspectorView.position", description: interfaceText("inspectorView.slidePosition"), descriptionKey: "inspectorView.slidePosition", unit: '%', value: Math.round(position * 10000) / 100, min: 0, max: 100, precision: 2},
      staticSwitch,
    ]}]},
    joint: {id: 'joint', title: builder ? interfaceText("inspectorView.geometry") : interfaceText("inspectorView.joint"), titleKey: (builder ? "inspectorView.geometry" : "inspectorView.joint"), titleParams: (builder ? {} : {}), hidden: slider, rows: [{kind: 'grid', rows: [
      !connector && number(interfaceText("inspectorView.angle"), 'joint_angle', degrees(lock ? editor.geometry.objects.get(editor.selectedSlot)?.segments[joint]?.angle : object.angles[joint] ?? segment.angle_rad), '°',
        {disabled: Boolean(lock), labelKey: "inspectorView.angle", labelParams: {}}),
      !connector && number(interfaceText("inspectorView.length"), 'joint_length', position, 'px', {min: 0, labelKey: "inspectorView.length", labelParams: {}}),
      number(interfaceText("inspectorView.bend"), 'joint_bend', degrees(object.bend_flag ? object.bends[joint] : segment.bend_rad || 0), '°', {labelKey: "inspectorView.bend", labelParams: {}}),
      !connector && staticSwitch,
    ]}]},
    ik: rigIKAllowed(figure, joint) && !slider ? ikSection(editor.getIKSettings()) : {id: 'ik', hidden: true},
    secondColour: {id: 'second-colour', title: interfaceText("inspectorView.secondColour"), titleKey: "inspectorView.secondColour", place: 'titled', open: secondary, hidden: !twoTone || slider,
      switch: {id: 'segment-gradient-enabled', label: interfaceText("inspectorView.secondaryColor"), labelKey: "inspectorView.secondaryColor", checked: secondary, controls: 'segment-secondary-controls'},
      rows: [{kind: 'grid', id: 'segment-secondary-controls', hidden: !secondary, rows: secondary ? [
        {kind: 'color', id: 'segment-gradient-color', label: interfaceText("inspectorView.colour"), labelKey: "inspectorView.colour", description: interfaceText("inspectorView.secondaryColor"), descriptionKey: "inspectorView.secondaryColor", value: hex(displayedColor(report, figure, object, segment.secondary.rgb))},
        number(interfaceText("inspectorView.secondaryOpacity"), 'segment_gradient_opacity', (1 - (segment.secondary.a ?? 0) / 255) * 100, '%', {min: 0, max: 100, description: interfaceText("inspectorView.secondaryColorOpacity"), descriptionKey: "inspectorView.secondaryColorOpacity", labelKey: "inspectorView.secondaryOpacity", labelParams: {}}),
      ] : []}]},
  };
  if (builder) {
    // One part (not a picked branch) with Whole branch on: the scope line names what an edit reaches and stops it.
    const branchParts = builderBranch && single && !editor.branchSelected ? segmentBranchIndices(figure.segments, segment.segment_id).length : 0;
    const branchScope = branchParts > 1 && !scope
      ? {label: interfaceText("inspectorView.editingTheWholeBranch", {value: plural(branchParts, 'part')}), labelKey: "inspectorView.editingTheWholeBranch", labelParams: {value: plural(branchParts, 'part')}, stop: {action: 'toggle-builder-branch', label: interfaceText("inspectorView.stop"), labelKey: "inspectorView.stop", tip: interfaceText("inspectorView.editOnlyThisPartB"), tipKey: "inspectorView.editOnlyThisPartB"}} : null;
    return {kind: 'joint', target: {name: title, ...titleBinding, glyph: part ? 'link' : partGlyph(segment), rename: single && !editor.branchSelected && !part ? partRename : undefined},
      quick: {context: 'part'}, scope: scope ?? branchScope, sections: [
        range, drawingSets, sections.connector, sections.slider,
        {id: 'style', title: interfaceText("inspectorView.style"), titleKey: "inspectorView.style", hidden: slider, rows: [{kind: 'grid', rows: [{...colour, span: 2}, width, alpha, shapeSelect]}]},
        sections.secondColour,
        sections.joint,
        {id: 'arrange', title: interfaceText("inspectorView.arrange"), titleKey: "inspectorView.arrange", rows: [{kind: 'grid', ratio: '3:2', rows: [
          layerSelect(editor),
          {kind: 'stepper-field', key: 'segment_z_order', label: interfaceText("inspectorView.order"), labelKey: "inspectorView.order", description: interfaceText("inspectorView.drawOrder"), descriptionKey: "inspectorView.drawOrder", groupLabel: interfaceText("inspectorView.drawOrderAndOneStepOrder"), hidden: slider,
            value: order.get(`segment:${joint}`), precision: 0, min: 1, max: order.size,
            down: {action: 'segment-order-down', label: interfaceText("inspectorView.sendPartBackward"), labelKey: "inspectorView.sendPartBackward", icon: STEP_DOWN}, up: {action: 'segment-order-up', label: interfaceText("inspectorView.bringPartForward"), labelKey: "inspectorView.bringPartForward", icon: STEP_UP}},
        ]}]},
        sections.ik.hidden ? sections.ik : {...sections.ik, place: 'titled', open: Boolean(editor.getIKSettings().enabled)},
        ...rigSections(editor, {hidden: slider}),
      ]};
  }
  return {kind: 'joint', target: {name: title, ...titleBinding, glyph: part ? 'link' : 'nodes'}, quick: {context: 'joint'}, scope, sections: [
    range, drawingSets, ...spatial, sections.connector, sections.slider, sections.joint, sections.ik,
    {id: 'style', title: interfaceText("inspectorView.style"), titleKey: "inspectorView.style", hidden: slider, rows: [
      {kind: 'grid', rows: [
        width, colour, alpha,
        number(interfaceText("inspectorView.order"), 'segment_z_order', order.get(`segment:${joint}`), '', {min: 1, max: order.size, description: interfaceText("inspectorView.drawOrder"), descriptionKey: "inspectorView.drawOrder", labelKey: "inspectorView.order", labelParams: {}}),
        shapeSelect,
        {kind: 'field-switch', id: 'builder-branch', label: interfaceText("inspectorView.applyToBranch"), labelKey: "inspectorView.applyToBranch", checked: builderBranch, span: 2, hidden: !(isBuilderContext(tool) && single)},
      ]},
    ]},
    sections.secondColour,
    {id: 'figure', title: interfaceText("inspectorView.figure"), titleKey: "inspectorView.figure", rows: [{kind: 'grid', rows: [layerSelect(editor, {span: 2})]}]},
  ]};
}
