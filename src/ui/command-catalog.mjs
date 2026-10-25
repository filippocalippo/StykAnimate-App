import english from '../locales/en.mjs';
/**
 * Command metadata: one entry per user command, keyed by the ids that already
 * exist (the `actions` map in app.mjs and movieclip-ui.mjs, and HOTKEY_COMMANDS
 * in hotkeys.mjs). Ids are never renamed. Pure data: no DOM, no editor state.
 *
 * The catalog says what a command is called, which glyph and group it has and
 * how to find it. It does not say where a command is shown: menus, the palette,
 * the rail and tooltips pick commands by id or category from the registry
 * (command-registry.mjs), which adds the live parts (shortcut text from the
 * user's bindings, availability, checked state, translations).
 *
 * Entry fields:
 *   id        the action or hotkey id
 *   label     English label, sentence case (the translation fallback)
 *   icon      an icons.mjs glyph (one glyph per concept)
 *   category  one of COMMAND_CATEGORIES
 *   labelKey  a localization key; existing keys are reused so the native Pivot
 *             catalogs keep translating the same controls
 *   keywords  extra words the palette matches
 *   hotkey    the HOTKEY_COMMANDS id whose binding this command shows, when it
 *             differs from the id (a declared alias: Play shows Space)
 *   modes     workspace modes (data-workspace-mode) where it applies; absent = all
 *   requires  availability conditions the app evaluates (command-registry `requirements`;
 *             CATALOG_REQUIREMENTS lists every name the app must supply)
 *   toggle    the command flips a state, shown as a checked menu item
 *   danger    destructive
 *   aliasOf   the same command under another id; the palette lists the target only
 *   palette   false for internal entries and steps inside a flow
 */
export const COMMAND_CATEGORIES = Object.freeze([
  {id: 'file', label: 'File', labelKey: 'menu.file'},
  {id: 'edit', label: 'Edit', labelKey: 'menu.edit'},
  {id: 'view', label: 'View', labelKey: 'menu.view'},
  {id: 'animation', label: 'Animation', labelKey: 'overlays.category.animation'},
  {id: 'figure', label: 'Figure', labelKey: 'overlays.category.figure'},
  {id: 'build', label: 'Build', labelKey: 'overlays.category.build'},
  {id: 'camera', label: 'Camera', labelKey: 'overlays.category.camera'},
  {id: 'tools', label: 'Tools', labelKey: 'overlays.category.tools'},
  {id: 'drawing', label: 'Drawing', labelKey: 'overlays.category.drawing'},
  {id: 'canvas', label: 'Canvas', labelKey: 'overlays.category.canvas'},
  {id: 'export', label: 'Export', labelKey: 'overlays.category.export'},
  {id: 'help', label: 'Help', labelKey: 'menu.help'},
  {id: 'app', label: 'Application', labelKey: 'overlays.category.app'},
].map(category => Object.freeze(category)));

const entries = [];
function group(category, rows) {
  for (const [id, label, icon = null, options = {}] of rows) {
    const entry = {id, label, icon, category, ...options};
    for (const key of ['keywords', 'modes', 'requires']) if (entry[key]) entry[key] = Object.freeze([...entry[key]]);
    entries.push(Object.freeze(entry));
  }
}
const internal = {palette: false};
const build = {modes: ['rig']};
const draw = {modes: ['draw']};

group('file', [
  ['home', english["commands.home"], 'home', {labelKey: "commands.home", keywords: ['projects', 'start', 'welcome', 'recent']}],
  ['new', english["menu.newAnimation"], 'new-file', {labelKey: 'menu.newAnimation', keywords: ['create', 'blank', 'project']}],
  ['new-window', english["commands.newWindow"], 'plus', {labelKey: "commands.newWindow", requires: ['desktop:newWindow']}],
  ['open', english["menu.openProject"], 'folder', {labelKey: 'menu.openProject', keywords: ['load', 'piv', 'stk']}],
  ['open-recent', english["menu.openRecent"], 'clock', {labelKey: 'menu.openRecent', requires: ['desktop:recentFiles']}],
  ['save', english["common.save"], 'save', {labelKey: 'common.save'}],
  ['save-as', english["common.saveAs"], 'save', {labelKey: 'common.saveAs', keywords: ['copy', 'duplicate project']}],
  ['save-all', english["commands.saveAll"], 'save', {labelKey: "commands.saveAll", keywords: ['every', 'tabs']}],
  ['rename', english["commands.rename"], 'file', {labelKey: "commands.rename", keywords: ['name', 'title']}],
  ['close-project', english["commands.closeProject"], 'close', {labelKey: "commands.closeProject", keywords: ['tab']}],
  ['close-saved-projects', english["commands.closeSavedProjects"], 'close', {labelKey: "commands.closeSavedProjects", keywords: ['tabs', 'others']}],
  ['recent-project', english["commands.recentProject"], 'layers', {labelKey: "commands.recentProject", keywords: ['switch', 'tab', 'previous']}],
  ['next-project', english["commands.nextProject"], 'chevron-right', {labelKey: "commands.nextProject", keywords: ['switch', 'tab']}],
  ['previous-project', english["commands.previousProject"], 'chevron-left', {labelKey: "commands.previousProject", keywords: ['switch', 'tab']}],
  ['import', english["menu.importFigures"], 'import', {labelKey: 'menu.importFigures', keywords: ['stk', 'stkz', 'load figure']}],
  ['import-sprite', english["menu.importSprite"], 'image', {labelKey: 'menu.importSprite', keywords: ['picture', 'png', 'sprite']}],
  ['import-background', english["menu.importBackground"], 'image', {labelKey: 'menu.importBackground', keywords: ['backdrop', 'picture']}],
  ['save-and-close', english["commands.saveAndClose"], 'save', {...internal, labelKey: "commands.saveAndClose"}],
  ['save-and-update', english["commands.saveAndUpdate"], 'save', {...internal, labelKey: "commands.saveAndUpdate"}],
]);
group('export', [
  ['export', english["common.export"], 'export', {labelKey: 'common.export', keywords: ['render', 'video', 'gif', 'mp4']}],
  ['export-stkz', english["commands.exportStkz"], 'person', {labelKey: "commands.exportStkz", requires: ['figure'], keywords: ['stkz', 'export figure', 'movieclip']}],
  ['export-piv', english["commands.exportPiv"], 'export', {labelKey: "commands.exportPiv", keywords: ['piv', 'pivot']}],
  ['export-stk', english["commands.exportStk"], 'export', {labelKey: "commands.exportStk", requires: ['figure'], keywords: ['stk']}],
  ['export-stykmov', english["commands.exportStykmov"], 'export', {labelKey: "commands.exportStykmov", requires: ['figure'], keywords: ['stykmov']}],
  ['export-video', english["commands.exportVideo"], 'export', {labelKey: "commands.exportVideo", keywords: ['movie', 'render']}],
  ['export-mp4', english["commands.exportMp4"], 'export', {labelKey: "commands.exportMp4", keywords: ['video', 'h264']}],
  ['export-avi', english["commands.exportAvi"], 'export', {labelKey: "commands.exportAvi", keywords: ['video']}],
  ['export-wmv', english["commands.exportWmv"], 'export', {labelKey: "commands.exportWmv", keywords: ['video', 'windows media']}],
  ['export-vfw', english["commands.exportVfw"], 'export', {labelKey: "commands.exportVfw", keywords: ['video', 'vfw', 'codec']}],
  ['export-gif', english["commands.exportGif"], 'export', {labelKey: "commands.exportGif", keywords: ['animated', 'image']}],
  ['export-apng', english["commands.exportApng"], 'export', {labelKey: "commands.exportApng", keywords: ['animated', 'png']}],
  ['export-png', english["commands.exportPng"], 'image', {labelKey: "commands.exportPng", keywords: ['still', 'picture', 'snapshot']}],
  ['export-svg', english["commands.exportSvg"], 'image', {labelKey: "commands.exportSvg", keywords: ['vector', 'still']}],
  ['export-png-sequence', english["commands.exportPngSequence"], 'image', {labelKey: "commands.exportPngSequence", keywords: ['frames', 'images']}],
  ['export-jpeg-sequence', english["commands.exportJpegSequence"], 'image', {labelKey: "commands.exportJpegSequence", keywords: ['frames', 'images', 'jpg']}],
  ['export-gif-sequence', english["commands.exportGifSequence"], 'image', {labelKey: "commands.exportGifSequence", keywords: ['frames', 'images']}],
  ['export-svg-sequence', english["commands.exportSvgSequence"], 'image', {labelKey: "commands.exportSvgSequence", keywords: ['frames', 'vector']}],
]);
group('edit', [
  ['undo', english["common.undo"], 'undo', {labelKey: 'common.undo'}],
  ['redo', english["common.redo"], 'redo', {labelKey: 'common.redo'}],
  ['cut', english["common.cut"], 'cut', {labelKey: 'common.cut'}],
  ['copy', english["common.copy"], 'duplicate', {labelKey: 'common.copy'}],
  ['paste', english["common.paste"], 'clipboard', {labelKey: 'common.paste'}],
  ['paste-in-place', english["commands.pasteInPlace"], 'clipboard', {labelKey: "commands.pasteInPlace"}],
  ['paste-instance', english["commands.pasteInstance"], 'clipboard', {labelKey: "commands.pasteInstance", keywords: ['linked', 'movieclip']}],
  ['paste-unique', english["commands.pasteUnique"], 'clipboard', {labelKey: "commands.pasteUnique", keywords: ['independent']}],
  ['duplicate', english["common.duplicate"], 'dup', {labelKey: 'common.duplicate', keywords: ['clone']}],
  ['delete', english["common.delete"], 'trash', {labelKey: 'common.delete', danger: true, keywords: ['remove']}],
  ['select-all', english["commands.selectAll"], 'cursor', {labelKey: "commands.selectAll"}],
  ['select-invert', english["commands.selectInvert"], 'cursor', {labelKey: "commands.selectInvert"}],
  ['select-same', english["commands.selectSame"], 'person', {labelKey: "commands.selectSame", requires: ['figure']}],
  ['cancel', english["commands.cancel"], 'close', {...internal, labelKey: "commands.cancel"}],
]);
group('view', [
  ['zoom-in', english["commands.zoomIn"], 'zoom-in', {labelKey: "commands.zoomIn"}],
  ['zoom-out', english["commands.zoomOut"], 'zoom-out', {labelKey: "commands.zoomOut"}],
  ['zoom-reset', english["commands.zoomReset"], 'fit', {labelKey: "commands.zoomReset", keywords: ['zoom', 'reset view']}],
  ['zoom-selection', english["commands.zoomSelection"], 'center', {labelKey: "commands.zoomSelection", requires: ['figure'], keywords: ['zoom']}],
  ['zoom-menu', english["commands.zoomMenu"], 'zoom', {...internal, labelKey: "commands.zoomMenu"}],
  // The zoom menu's presets (app.mjs builds these actions at run time).
  ...[25, 50, 100, 200].map(n => [`zoom-${n}`, `Zoom to ${n}%`, 'zoom', {keywords: ['zoom', 'percent', 'magnify']}]),
  ['toggle-handles', english["commands.toggleHandles"], 'nodes', {labelKey: "commands.toggleHandles", toggle: true, keywords: ['handles', 'show', 'hide']}],
  ['toggle-unselected-handles', english["commands.toggleUnselectedHandles"], 'nodes', {labelKey: "commands.toggleUnselectedHandles", toggle: true, keywords: ['handles', 'unselected']}],
  ['toggle-motion-paths', english["commands.toggleMotionPaths"], 'route', {labelKey: "commands.toggleMotionPaths", toggle: true, keywords: ['trajectory', 'path']}],
  ['toggle-grid', english["commands.toggleGrid"], 'grid', {labelKey: "commands.toggleGrid", toggle: true, keywords: ['guides', 'show', 'hide']}],
  ['toggle-camera', english["commands.toggleCamera"], 'camera', {labelKey: "commands.toggleCamera", toggle: true, keywords: ['virtual camera', 'show', 'hide']}],
  ['toggle-selection-origins', english["commands.toggleSelectionOrigins"], 'cursor', {labelKey: "commands.toggleSelectionOrigins", toggle: true, keywords: ['marquee', 'rectangle']}],
  ['scene-settings', english["commands.sceneSettings"], 'scene', {labelKey: "commands.sceneSettings", keywords: ['canvas size', 'background', 'frame rate']}],
  ['builder-highlight', english["commands.builderHighlight"], 'highlight', {labelKey: "commands.builderHighlight", ...build, toggle: true}],
  ['builder-static-handles', english["commands.builderStaticHandles"], 'pin', {labelKey: "commands.builderStaticHandles", ...build, toggle: true}],
  ['builder-canvas-color', english["commands.builderCanvasColor"], 'settings', {labelKey: "commands.builderCanvasColor", ...build, keywords: ['colour']}],
]);
// The shell's panels and layout (src/shell/shell-commands.mjs).
group('view', [
  ['panel-toggle-properties', english["commands.panelToggleProperties"], 'inspector', {labelKey: "commands.panelToggleProperties", keywords: ['inspector', 'panel', 'show', 'fold']}],
  ['panel-toggle-vfx', english["commands.panelToggleVfx"], 'fx', {labelKey: "commands.panelToggleVfx", keywords: ['effects', 'panel', 'show', 'fold']}],
  ['panel-toggle-library', english["commands.panelToggleLibrary"], 'library', {labelKey: "commands.panelToggleLibrary", keywords: ['assets', 'panel', 'show', 'fold']}],
  ['panel-toggle-structure', english["commands.panelToggleStructure"], 'structure', {labelKey: "commands.panelToggleStructure", ...build, keywords: ['outliner', 'hierarchy', 'parts', 'panel']}],
  ['panel-toggle-timeline', english["commands.panelToggleTimeline"], 'timeline', {labelKey: "commands.panelToggleTimeline", keywords: ['show', 'fold', 'strip', 'panel']}],
  ['timeline-sheet', english["commands.timelineSheet"], 'timeline', {labelKey: "commands.timelineSheet", keywords: ['open', 'rows', 'keys', 'sheet']}],
  ['timeline-tall', english["commands.timelineTall"], null, {labelKey: "commands.timelineTall", keywords: ['expand', 'height', 'bigger']}],
  ['panel-hide-properties', english["commands.panelHideProperties"], null, {labelKey: "commands.panelHideProperties", keywords: ['inspector', 'panel']}],
  ['panel-hide-vfx', english["commands.panelHideVfx"], null, {labelKey: "commands.panelHideVfx", keywords: ['effects', 'panel']}],
  ['panel-hide-library', english["commands.panelHideLibrary"], null, {labelKey: "commands.panelHideLibrary", keywords: ['assets', 'panel']}],
  ['layout-focus', english["commands.layoutFocus"], null, {labelKey: "commands.layoutFocus", keywords: ['hide panels', 'distraction', 'stage only']}],
  ['layout-reset', english["commands.layoutReset"], 'reset', {labelKey: "commands.layoutReset", keywords: ['panels', 'default', 'workspace']}],
  ['layout-arrange', english["commands.layoutArrange"], 'layout', {labelKey: "commands.layoutArrange", keywords: ['dock', 'arrange', 'float', 'keyboard']}],
  ['layout-menu', english["commands.layoutMenu"], 'layout', {labelKey: "commands.layoutMenu", keywords: ['panels', 'preset', 'dock', 'arrange', 'workspace']}],
  ['focus-next-region', english["commands.focusNextRegion"], null, {labelKey: "commands.focusNextRegion", keywords: ['focus', 'keyboard', 'panel']}],
  ['focus-previous-region', english["commands.focusPreviousRegion"], null, {labelKey: "commands.focusPreviousRegion", keywords: ['focus', 'keyboard', 'panel']}],
]);
group('animation', [
  ['play', english["commands.play"], 'play', {labelKey: "commands.play", hotkey: 'play-pan', keywords: ['preview', 'stop']}],
  ['play-pan', english["commands.playPan"], 'play', {labelKey: "commands.playPan", aliasOf: 'play', palette: false}],
  ['first-frame', english["commands.firstFrame"], 'first', {labelKey: "commands.firstFrame"}],
  ['previous-frame', english["commands.previousFrame"], 'previous', {labelKey: "commands.previousFrame"}],
  ['next-frame', english["commands.nextFrame"], 'next', {labelKey: "commands.nextFrame"}],
  ['last-frame', english["commands.lastFrame"], 'last', {labelKey: "commands.lastFrame"}],
  ['previous-keyframe', english["commands.previousKeyframe"], 'previous', {labelKey: "commands.previousKeyframe", keywords: ['keyframe', 'jump']}],
  ['next-keyframe', english["commands.nextKeyframe"], 'next', {labelKey: "commands.nextKeyframe", keywords: ['keyframe', 'jump']}],
  ['add-frame', english["timeline.addFrame"], 'plus', {labelKey: 'timeline.addFrame', keywords: ['keyframe', 'new frame']}],
  ['extend-keyframe', english["commands.extendKeyframe"], 'stretch-horizontal', {labelKey: "commands.extendKeyframe", keywords: ['hold', 'exposure', 'keyframe']}],
  ['delete-frame', english["commands.deleteFrame"], 'trash', {labelKey: "commands.deleteFrame", danger: true, keywords: ['remove', 'keyframe']}],
  ['insert-blank-key', english["commands.insertBlankKey"], 'frame', {labelKey: "commands.insertBlankKey", keywords: ['keyframe', 'drawing']}],
  ['insert-copied-key', english["commands.insertCopiedKey"], 'clipboard', {labelKey: "commands.insertCopiedKey", keywords: ['keyframe', 'paste']}],
  ['remove-frames', english["commands.removeFrames"], 'trash', {labelKey: "commands.removeFrames", palette: false, danger: true}],
  ['clear-keys', english["commands.clearKeys"], 'trash', {labelKey: "commands.clearKeys", palette: false, danger: true}],
  ['toggle-loop', english["commands.toggleLoop"], 'loop', {labelKey: "commands.toggleLoop", toggle: true, keywords: ['repeat']}],
  ['toggle-onion', english["commands.toggleOnion"], 'onion', {labelKey: "commands.toggleOnion", toggle: true, keywords: ['ghost', 'previous frames']}],
  ['toggle-range-edit', english["commands.toggleRangeEdit"], 'frame', {labelKey: "commands.toggleRangeEdit", toggle: true, keywords: ['range', 'apply to frames', 'edit selected frames']}],
  ['toggle-audio', english["commands.toggleAudio"], 'music', {labelKey: "commands.toggleAudio", toggle: true, keywords: ['sound', 'music', 'track']}],
  ['timeline-layer-up', english["commands.timelineLayerUp"], 'up', {...internal, labelKey: "commands.timelineLayerUp"}],
  ['timeline-layer-down', english["commands.timelineLayerDown"], 'down', {...internal, labelKey: "commands.timelineLayerDown"}],
  ['previous-exposure', english["commands.previousExposure"], 'previous', {...internal, labelKey: "commands.previousExposure"}],
  ['next-exposure', english["commands.nextExposure"], 'next', {...internal, labelKey: "commands.nextExposure"}],
  ['movieclip-new', english["commands.movieclipNew"], 'frame', {labelKey: "commands.movieclipNew", keywords: ['clip', 'symbol']}],
  ['movieclip-create', english["commands.movieclipCreate"], 'frame', {labelKey: "commands.movieclipCreate", requires: ['figure'], keywords: ['clip', 'symbol']}],
  ['movieclip-range', english["commands.movieclipRange"], 'frame', {labelKey: "commands.movieclipRange", keywords: ['clip', 'range']}],
  ['movieclip-edit', english["commands.movieclipEdit"], 'frame', {labelKey: "commands.movieclipEdit", requires: ['movieclip']}],
  ['movieclip-done', english["commands.movieclipDone"], 'check', {labelKey: "commands.movieclipDone", requires: ['movieclip-session']}],
  ['movieclip-cancel', english["commands.movieclipCancel"], 'close', {labelKey: "commands.movieclipCancel", requires: ['movieclip-session']}],
  ['movieclip-unique', english["commands.movieclipUnique"], 'duplicate', {labelKey: "commands.movieclipUnique", requires: ['movieclip']}],
  ['movieclip-break', english["commands.movieclipBreak"], 'split', {labelKey: "commands.movieclipBreak", requires: ['movieclip']}],
  ['movieclip-bake', english["commands.movieclipBake"], 'layers', {labelKey: "commands.movieclipBake", requires: ['movieclip']}],
  ['movieclip-export', english["commands.movieclipExport"], 'export', {labelKey: "commands.movieclipExport", requires: ['movieclip']}],
  ['movieclip-extend', english["commands.movieclipExtend"], 'plus', {...internal, labelKey: "commands.movieclipExtend"}],
]);
group('figure', [
  ['add-figure', english["commands.addFigure"], 'person', {labelKey: "commands.addFigure", keywords: ['new figure', 'insert']}],
  ['add-text', english["menu.createText"], 'text', {labelKey: 'menu.createText', keywords: ['type', 'caption', 'insert']}],
  ['edit-text', english["commands.editText"], 'text', {labelKey: "commands.editText", requires: ['text']}],
  ['mirror', english["commands.mirror"], 'flip', {labelKey: "commands.mirror", requires: ['figure'], keywords: ['mirror']}],
  ['mirror-vertical', english["commands.mirrorVertical"], 'flip-vertical', {labelKey: "commands.mirrorVertical", requires: ['figure'], keywords: ['mirror']}],
  ['rotate', english["commands.rotate"], 'rotate-step', {labelKey: "commands.rotate", requires: ['figure']}],
  ['center', english["commands.center"], 'center', {labelKey: "commands.center", requires: ['figure'], keywords: ['centre', 'middle']}],
  ['reset-pose', english["commands.resetPose"], 'reset', {labelKey: "commands.resetPose", requires: ['figure']}],
  ['reset-color', english["commands.resetColor"], 'reset', {labelKey: "commands.resetColor", requires: ['figure'], keywords: ['colours']}],
  ['layer-front', english["commands.layerFront"], 'bring-to-front', {labelKey: "commands.layerFront", requires: ['figure'], keywords: ['arrange', 'order']}],
  ['layer-up', english["commands.layerUp"], 'step-up', {labelKey: "commands.layerUp", requires: ['figure'], keywords: ['arrange', 'order']}],
  ['layer-down', english["commands.layerDown"], 'step-down', {labelKey: "commands.layerDown", requires: ['figure'], keywords: ['arrange', 'order']}],
  ['layer-back', english["commands.layerBack"], 'send-to-back', {labelKey: "commands.layerBack", requires: ['figure'], keywords: ['arrange', 'order']}],
  ['selection-front', english["commands.layerFront"], 'bring-to-front', {labelKey: "commands.layerFront", requires: ['figure'], keywords: ['arrange', 'segment', 'branch']}],
  ['selection-up', english["commands.layerUp"], 'step-up', {labelKey: "commands.layerUp", requires: ['figure'], keywords: ['arrange', 'segment', 'branch']}],
  ['selection-down', english["commands.layerDown"], 'step-down', {labelKey: "commands.layerDown", requires: ['figure'], keywords: ['arrange', 'segment', 'branch']}],
  ['selection-back', english["commands.layerBack"], 'send-to-back', {labelKey: "commands.layerBack", requires: ['figure'], keywords: ['arrange', 'segment', 'branch']}],
  ['align-left', english["commands.alignLeft"], 'align-left', {labelKey: "commands.alignLeft", requires: ['figures']}],
  ['align-center-x', english["commands.alignCenterX"], 'align-horizontal-center', {labelKey: "commands.alignCenterX", requires: ['figures'], keywords: ['centre']}],
  ['align-right', english["commands.alignRight"], 'align-right', {labelKey: "commands.alignRight", requires: ['figures']}],
  ['align-top', english["commands.alignTop"], 'align-top', {labelKey: "commands.alignTop", requires: ['figures']}],
  ['align-center-y', english["commands.alignCenterY"], 'align-vertical-center', {labelKey: "commands.alignCenterY", requires: ['figures']}],
  ['align-bottom', english["commands.alignBottom"], 'align-bottom', {labelKey: "commands.alignBottom", requires: ['figures']}],
  ['join-figure', english["commands.joinFigure"], 'join-figure', {labelKey: "commands.joinFigure", requires: ['figure'], keywords: ['attach', 'unjoin', 'detach', 'connect']}],
  ['attach-figure', english["commands.joinFigure"], 'link', {labelKey: "commands.joinFigure", aliasOf: 'join-figure', palette: false}],
  ['detach-figure', english["commands.detachFigure"], 'detach', {labelKey: "commands.detachFigure", aliasOf: 'join-figure', palette: false}],
  ['combine-figures', english["commands.combineFigures"], 'combine', {labelKey: "commands.combineFigures", requires: ['figure'], keywords: ['merge']}],
  ['disconnect-segment', english["commands.disconnectSegment"], 'cut', {labelKey: "commands.disconnectSegment", modes: ['animate'], requires: ['joint'], keywords: ['split', 'separate', 'detach', 'break', 'new figure', 'branch']}],
  ['add-to-library', english["commands.addToLibrary"], 'layers', {labelKey: "commands.addToLibrary", requires: ['figure'], keywords: ['save', 'asset']}],
  ['edit-in-build-mode', english["commands.editInBuildMode"], 'nodes', {labelKey: "commands.editInBuildMode", requires: ['figure'], keywords: ['build', 'rig', 'builder']}],
  ['selection-more', english["commands.selectionMore"], 'more', {...internal, labelKey: "commands.selectionMore"}],
  ['locate-previous', english["commands.locatePrevious"], 'match-prev', {labelKey: "commands.locatePrevious", keywords: ['locate', 'copy pose']}],
  ['locate-next', english["commands.locateNext"], 'match-next', {labelKey: "commands.locateNext", keywords: ['locate', 'copy pose']}],
  ['segment-values', english["commands.segmentValues"], 'exact', {labelKey: "commands.segmentValues", requires: ['joint'], keywords: ['segment editor', 'angle', 'length']}],
  ['toggle-isolate', english["commands.toggleIsolate"], 'eye', {labelKey: "commands.toggleIsolate", toggle: true, keywords: ['solo', 'focus']}],
  ['previous-figure', english["commands.previousFigure"], 'previous', {...internal, labelKey: "commands.previousFigure"}],
  ['next-figure', english["commands.nextFigure"], 'next', {...internal, labelKey: "commands.nextFigure"}],
  ['palette-previous', english["commands.palettePrevious"], 'chevron-left', {...internal, labelKey: "commands.palettePrevious"}],
  ['palette-next', english["commands.paletteNext"], 'chevron-right', {...internal, labelKey: "commands.paletteNext"}],
  ['polygons-previous', english["commands.polygonsPrevious"], 'chevron-left', {...internal, labelKey: "commands.polygonsPrevious"}],
  ['polygons-next', english["commands.polygonsNext"], 'chevron-right', {...internal, labelKey: "commands.polygonsNext"}],
  ['background-style', english["commands.backgroundStyle"], 'image', {labelKey: "commands.backgroundStyle", keywords: ['backdrop', 'color', 'colour']}],
  ['finish-polygon', english["commands.finishPolygon"], 'check', {...internal, labelKey: "commands.finishPolygon"}],
  ['cancel-polygon', english["commands.cancelPolygon"], 'close', {...internal, labelKey: "commands.cancelPolygon"}],
  ['chain-finish', english["commands.chainFinish"], 'check', {...internal, labelKey: "commands.chainFinish"}],
  ['chain-cancel', english["commands.chainCancel"], 'close', {...internal, labelKey: "commands.chainCancel"}],
]);
group('build', [
  ['split-segment', english["commands.splitSegment"], 'split', {labelKey: "commands.splitSegment", ...build, requires: ['joint'], keywords: ['segment', 'part']}],
  ['unsplit-segment', english["commands.unsplitSegment"], 'builder-unsplit', {labelKey: "commands.unsplitSegment", ...build, requires: ['joint'], keywords: ['merge', 'segment']}],
  ['delete-single-segment', english["commands.deleteSingleSegment"], 'trash', {labelKey: "commands.deleteSingleSegment", ...build, hotkey: 'delete', requires: ['joint'], danger: true, keywords: ['segment']}],
  ['delete-segment', english["commands.deleteSegment"], 'trash', {labelKey: "commands.deleteSegment", ...build, requires: ['joint'], danger: true}],
  ['mirror-segment', english["commands.mirrorSegment"], 'flip', {labelKey: "commands.mirrorSegment", ...build, hotkey: 'mirror', requires: ['joint'], keywords: ['mirror', 'segment']}],
  ['mirror-segment-vertical', english["commands.mirrorSegmentVertical"], 'flip-vertical', {labelKey: "commands.mirrorSegmentVertical", ...build, hotkey: 'mirror-vertical', requires: ['joint'], keywords: ['mirror', 'segment']}],
  ['mirror-branch', english["commands.mirrorBranch"], 'flip', {labelKey: "commands.mirrorBranch", ...build, requires: ['joint'], keywords: ['mirror']}],
  ['mirror-branch-vertical', english["commands.mirrorBranchVertical"], 'flip-vertical', {labelKey: "commands.mirrorBranchVertical", ...build, requires: ['joint'], keywords: ['mirror']}],
  ['origin-segment', english["commands.originSegment"], 'origin', {labelKey: "commands.originSegment", ...build, requires: ['joint'], keywords: ['root', 'pivot']}],
  ['duplicate-segment', english["commands.duplicateSegment"], 'duplicate', {labelKey: "commands.duplicateSegment", ...build, hotkey: 'duplicate', requires: ['joint'], keywords: ['segment', 'copy']}],
  ['duplicate-branch', english["commands.duplicateBranch"], 'duplicate', {labelKey: "commands.duplicateBranch", ...build, requires: ['joint']}],
  ['segment-order-front', english["commands.segmentOrderFront"], 'bring-to-front', {labelKey: "commands.segmentOrderFront", ...build, requires: ['joint'], keywords: ['arrange', 'order']}],
  ['segment-order-up', english["commands.segmentOrderUp"], 'up', {labelKey: "commands.segmentOrderUp", ...build, requires: ['joint'], keywords: ['arrange', 'order']}],
  ['segment-order-down', english["commands.segmentOrderDown"], 'down', {labelKey: "commands.segmentOrderDown", ...build, requires: ['joint'], keywords: ['arrange', 'order']}],
  ['segment-order-back', english["commands.segmentOrderBack"], 'send-to-back', {labelKey: "commands.segmentOrderBack", ...build, requires: ['joint'], keywords: ['arrange', 'order']}],
  ['builder-order', english["commands.builderOrder"], 'layers', {...internal, labelKey: "commands.builderOrder"}],
  ['copy-builder-appearance', english["commands.copyBuilderAppearance"], 'duplicate', {labelKey: "commands.copyBuilderAppearance", ...build, requires: ['joint'], keywords: ['style', 'color', 'colour']}],
  ['paste-builder-appearance', english["commands.pasteBuilderAppearance"], 'clipboard', {labelKey: "commands.pasteBuilderAppearance", ...build, requires: ['joint', 'appearance'], keywords: ['style', 'color', 'colour']}],
  ['toggle-builder-branch', english["commands.toggleBuilderBranch"], 'builder-branch', {labelKey: "commands.toggleBuilderBranch", ...build, toggle: true}],
  ['add-sprite-segment', english["commands.addSpriteSegment"], 'image', {labelKey: "commands.addSpriteSegment", ...build, keywords: ['sprite', 'picture']}],
  ['auto-rig-image', english["commands.autoRigImage"] ?? 'Auto-Rig from Image…', 'nodes', {...build, keywords: ['ai', 'pose', 'auto rig', 'skeleton', 'mediapipe']}],
  ['rig-connect', english["commands.rigConnect"], 'link', {labelKey: "commands.rigConnect", ...build, requires: ['figure'], keywords: ['rig', 'anchor']}],
  ['rig-weighted', english["commands.rigWeighted"], 'nodes', {labelKey: "commands.rigWeighted", ...build, requires: ['joint'], keywords: ['rig']}],
  ['rig-pick-start', english["commands.rigPickStart"], 'cursor', {labelKey: "commands.rigPickStart", ...build, palette: false}],
  ['rig-pick-end', english["commands.rigPickEnd"], 'cursor', {labelKey: "commands.rigPickEnd", ...build, palette: false}],
  ['rig-pick-driver', english["commands.rigPickDriver"], 'cursor', {labelKey: "commands.rigPickDriver", ...build, palette: false}],
  ['rig-bind-branch', english["commands.rigBindBranch"], 'stretch-horizontal', {labelKey: "commands.rigBindBranch", ...build, requires: ['joint'], keywords: ['rig', 'smart stretch']}],
  ['rig-test', english["commands.rigTest"], 'play', {labelKey: "commands.rigTest", ...build, keywords: ['preview', 'rig']}],
  ['rig-examples', english["commands.rigExamples"], 'layers', {labelKey: "commands.rigExamples", keywords: ['samples', 'library']}],
]);
group('camera', [
  ['camera-done', english["commands.cameraDone"], 'check', {labelKey: "commands.cameraDone", requires: ['camera-session']}],
  ['camera-copy', english["commands.cameraCopy"], 'duplicate', {labelKey: "commands.cameraCopy"}],
  ['camera-paste', english["commands.cameraPaste"], 'clipboard', {labelKey: "commands.cameraPaste"}],
  ['camera-reset', english["commands.cameraReset"], 'reset', {labelKey: "commands.cameraReset"}],
  ['camera-center', english["commands.cameraCenter"], 'center', {labelKey: "commands.cameraCenter", requires: ['figure'], keywords: ['centre', 'frame figures']}],
  ['camera-center-x', english["commands.cameraCenterX"], 'align-horizontal-center', {labelKey: "commands.cameraCenterX", requires: ['figure'], keywords: ['centre']}],
  ['camera-center-y', english["commands.cameraCenterY"], 'align-vertical-center', {labelKey: "commands.cameraCenterY", requires: ['figure'], keywords: ['centre']}],
  ['camera-align-view', english["commands.cameraAlignView"], 'fit', {labelKey: "commands.cameraAlignView", keywords: ['align', 'match view']}],
  ['camera-level', english["commands.cameraLevel"], 'level', {labelKey: "commands.cameraLevel", keywords: ['straighten', 'angle']}],
  ['camera-locate-previous', english["commands.cameraLocatePrevious"], 'chevron-left', {labelKey: "commands.cameraLocatePrevious"}],
  ['camera-locate-next', english["commands.cameraLocateNext"], 'chevron-right', {labelKey: "commands.cameraLocateNext"}],
  ['camera-apply-figures', english["commands.cameraApplyFigures"], 'person', {labelKey: "commands.cameraApplyFigures", keywords: ['bake']}],
  ['camera-guides', english["commands.cameraGuides"], 'grid', {labelKey: "commands.cameraGuides", toggle: true, keywords: ['safe area', 'thirds']}],
]);
group('tools', [
  ['tool-select', english["commands.toolSelect"], 'cursor', {labelKey: "commands.toolSelect", keywords: ['select tool', 'pose']}],
  ['tool-pose', english["commands.toolPose"], 'cursor', {labelKey: "commands.toolPose", aliasOf: 'tool-select', palette: false}],
  ['tool-hand', english["commands.toolHand"], 'hand', {labelKey: "commands.toolHand", keywords: ['hand', 'scroll']}],
  ['tool-line', english["commands.toolLine"], 'line', {labelKey: "commands.toolLine", ...build}],
  ['tool-circle', english["commands.toolCircle"], 'circle', {labelKey: "commands.toolCircle", ...build}],
  ['tool-polygon', english["commands.toolPolygon"], 'polygon', {labelKey: "commands.toolPolygon", ...build, keywords: ['fill', 'shape']}],
  ['tool-rig', english["commands.toolRig"], 'nodes', {labelKey: "commands.toolRig", ...build}],
  ['handle-edit-hold', english["commands.handleEditHold"], 'nodes', {...internal, labelKey: "commands.handleEditHold"}],
  ['isolate-hold', english["commands.isolateHold"], 'eye', {labelKey: "commands.isolateHold", aliasOf: 'toggle-isolate', palette: false}],
  ['depth-hold', english["commands.depthHold"], 'rotate', {...internal, labelKey: "commands.depthHold"}],
]);
group('drawing', [
  ['drawing-brush', english["commands.drawingBrush"], 'brush', {...draw, labelKey: "commands.drawingBrush"}],
  ['drawing-eraser', english["commands.drawingEraser"], 'eraser', {...draw, labelKey: "commands.drawingEraser"}],
  ['drawing-fill', english["commands.drawingFill"], 'paint-bucket', {labelKey: "commands.drawingFill", ...draw, keywords: ['bucket', 'paint']}],
  ['drawing-lasso', english["commands.drawingLasso"], 'lasso', {labelKey: "commands.drawingLasso", ...draw, keywords: ['lasso', 'marquee']}],
  ['drawing-shape', english["commands.drawingShape"], 'polygon', {labelKey: "commands.drawingShape", ...draw, keywords: ['rectangle', 'ellipse']}],
  ['drawing-smaller', english["commands.drawingSmaller"], 'minus', {...draw, labelKey: "commands.drawingSmaller"}],
  ['drawing-larger', english["commands.drawingLarger"], 'plus', {...draw, labelKey: "commands.drawingLarger"}],
  ['drawing-softer', english["commands.drawingSofter"], 'minus', {...draw, labelKey: "commands.drawingSofter"}],
  ['drawing-harder', english["commands.drawingHarder"], 'plus', {...draw, labelKey: "commands.drawingHarder"}],
  ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => [`drawing-opacity-${n}`, `Brush opacity ${n}%`, 'sliders', {...draw, palette: false}]),
  ['drawing-apply', english["commands.drawingApply"], 'check', {labelKey: "commands.drawingApply", ...draw, requires: ['pixels']}],
  ['drawing-select-all', english["commands.drawingSelectAll"], 'lasso', {...draw, labelKey: "commands.drawingSelectAll"}],
  ['drawing-deselect', english["commands.drawingDeselect"], 'close', {labelKey: "commands.drawingDeselect", ...draw, requires: ['pixels']}],
  ['drawing-invert-selection', english["commands.drawingInvertSelection"], 'lasso', {labelKey: "commands.drawingInvertSelection", ...draw, requires: ['pixels']}],
  ['drawing-fill-selection', english["commands.drawingFillSelection"], 'paint-bucket', {labelKey: "commands.drawingFillSelection", ...draw, requires: ['pixels']}],
  ['drawing-mirror', english["commands.drawingMirror"], 'flip', {labelKey: "commands.drawingMirror", ...draw, toggle: true, keywords: ['symmetry']}],
  ['drawing-swap-colors', english["commands.drawingSwapColors"], 'reset', {labelKey: "commands.drawingSwapColors", ...draw, keywords: ['colours', 'foreground', 'background']}],
  ['drawing-flip-view', english["commands.drawingFlipView"], 'flip', {labelKey: "commands.drawingFlipView", ...draw, toggle: true, keywords: ['mirror canvas']}],
]);
group('canvas', [
  ...['left', 'right', 'up', 'down'].map(direction => [`handle-${direction}`, `Nudge handle ${direction}`, `arrow-${direction}`, internal]),
  ...['left', 'right', 'up', 'down'].map(direction => [`move-${direction}`, `Move selection ${direction}`, `arrow-${direction}`, internal]),
  ['library-open', english["commands.libraryOpen"], 'import', {...internal, labelKey: "commands.libraryOpen"}],
  ['library-rename', english["commands.libraryRename"], 'file', {...internal, labelKey: "commands.libraryRename"}],
]);
group('help', [
  ['help', english["menu.shortcuts"], 'keyboard', {labelKey: 'menu.shortcuts', keywords: ['hotkeys', 'keys']}],
  ['tutorials', english["commands.tutorials"], 'learn', {labelKey: "commands.tutorials", keywords: ['learn', 'guide', 'tour', 'lesson', 'how to', 'getting started']}],
  ['tutorial-leave', english["commands.tutorialLeave"], 'close', {labelKey: "commands.tutorialLeave", ...internal}],
  ['about', english["commands.about"], 'help', {labelKey: "commands.about"}],
  ['release-notes', english["commands.releaseNotes"], 'file', {labelKey: "commands.releaseNotes", requires: ['desktop:updates'], keywords: ['release notes', 'changelog']}],
  ['check-updates', english["commands.checkUpdates"], 'import', {labelKey: "commands.checkUpdates", requires: ['desktop:updates']}],
  ['restart-update', english["commands.restartUpdate"], 'import', {labelKey: "commands.restartUpdate", requires: ['update-ready']}],
  ['feedback', english["commands.feedback"], 'message', {labelKey: "commands.feedback", requires: ['desktop:feedback'], keywords: ['feedback', 'support', 'bug']}],
  ['performance', english["menu.performance"], 'activity', {labelKey: 'menu.performance', keywords: ['fps', 'renderer', 'diagnostics']}],
  ['privacy', english["commands.privacy"], 'lock', {labelKey: "commands.privacy", requires: ['desktop:telemetry'], keywords: ['telemetry']}],
  ['donate', english["commands.donate"], 'heart', {labelKey: "commands.donate", requires: ['desktop:updates'], keywords: ['donate']}],
  ['website', english["commands.website"], 'link', {labelKey: "commands.website", requires: ['desktop:telemetry']}],
]);
group('app', [
  ['menu', english["commands.menu"], 'more', {...internal, labelKey: "commands.menu"}],
  // Opens the palette; the palette does not list itself.
  ['command-palette', english["overlays.palette.open"], 'search', {labelKey: 'overlays.palette.open', keywords: ['command palette', 'find', 'run'], palette: false}],
  ['settings', english["menu.settings"], 'settings', {labelKey: 'menu.settings', keywords: ['preferences', 'options', 'theme', 'language']}],
  ['minimize', english["commands.minimize"], 'minimize', {labelKey: "commands.minimize", requires: ['desktop']}],
  ['maximize', english["commands.maximize"], 'maximize', {labelKey: "commands.maximize", requires: ['desktop']}],
  ['close', english["commands.close"], 'close', {labelKey: "commands.close", requires: ['desktop'], keywords: ['exit', 'close window']}],
  ['close-dialog', english["commands.closeDialog"], 'close', {...internal, labelKey: "commands.closeDialog"}],
]);

/** Every entry, in declaration order; indexes order them by COMMAND_CATEGORIES, then by this order. */
export const COMMAND_CATALOG = Object.freeze(entries);
export const COMMAND_BY_ID = new Map(entries.map(entry => [entry.id, entry]));
/** Every `requires` name the catalog uses: the app's `requirements` must answer each (a missing one reads as unavailable). */
export const CATALOG_REQUIREMENTS = Object.freeze([...new Set(entries.flatMap(entry => entry.requires ?? []))].sort());
