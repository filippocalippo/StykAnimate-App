import {messageTuple, tupleMessages} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
import {HOTKEY_BY_ID, shortcutLabel} from './hotkeys.mjs';
/** Classic application menus use the same commands as keyboard and canvas actions. Each is a few named groups
 * (separators between them), families in submenus (Import ▸, Duplicate ▸, Flip ▸, Arrange ▸) and what removes
 * something last; view toggles show a check while they are on (the command registry's toggle states). */
export function applicationMenuItems(name, editor, desktop) {
  const noFigure = !editor.object;
  const noJoint = noFigure || Boolean(editor.figure?._styk?.movieclip) || editor.selectedJoint < 0 || editor.selectedUids?.size > 1;
  const segment = (action, symbol, label, shortcut = '') => [action, symbol, label, shortcut, noJoint];
  const menus = {
    file: [
      messageTuple(['home', 'home', interfaceText("commands.home")], {2: {key: "commands.home", params: {}}}),
      null,
      messageTuple(['new', 'plus', interfaceText("applicationMenu.newAnimation"), 'Ctrl N'], {2: {key: "applicationMenu.newAnimation", params: {}}}),
      messageTuple(['new-window', 'plus', interfaceText("applicationMenu.newWindow"), '', !desktop?.newWindow], {2: {key: "applicationMenu.newWindow", params: {}}}),
      messageTuple(['open', 'folder', interfaceText("applicationMenu.openProject"), 'Ctrl O'], {2: {key: "applicationMenu.openProject", params: {}}}),
      messageTuple(['reload-project', 'folder', interfaceText("applicationMenu.reloadProject"), '', !desktop?.reloadDocument], {2: {key: "applicationMenu.reloadProject", params: {}}}),
      messageTuple(['open-recent', 'clock', interfaceText("applicationMenu.openRecent"), '', !desktop?.listRecentFiles], {2: {key: "applicationMenu.openRecent", params: {}}}),
      null,
      messageTuple(['save', 'save', interfaceText("common.save"), 'Ctrl S'], {2: {key: "common.save", params: {}}}),
      messageTuple(['save-as', 'save', interfaceText("common.saveAs"), 'Ctrl Shift S'], {2: {key: "common.saveAs", params: {}}}),
      messageTuple(['rename', 'file', interfaceText("applicationMenu.renameProject")], {2: {key: "applicationMenu.renameProject", params: {}}}),
      messageTuple(['close-project', 'close', interfaceText("commands.closeProject"), 'Ctrl W'], {2: {key: "commands.closeProject", params: {}}}),
      null,
      {label: interfaceText("applicationMenu.import"), labelKey: "applicationMenu.import", icon: 'import', submenu: [
        messageTuple(['import', 'import', interfaceText("applicationMenu.importFigures")], {2: {key: "applicationMenu.importFigures", params: {}}}),
        messageTuple(['import-sprite', 'image', interfaceText("applicationMenu.importSpriteImage")], {2: {key: "applicationMenu.importSpriteImage", params: {}}}),
        messageTuple(['import-background', 'image', interfaceText("applicationMenu.importBackground")], {2: {key: "applicationMenu.importBackground", params: {}}}),
      ]},
      messageTuple(['export-stkz', 'person', interfaceText("applicationMenu.saveFigure"), '', noFigure], {2: {key: "applicationMenu.saveFigure", params: {}}}),
      messageTuple(['export', 'export', interfaceText("common.export")], {2: {key: "common.export", params: {}}}),
    ],
    edit: [
      messageTuple(['undo', 'undo', interfaceText("common.undo"), 'Ctrl Z'], {2: {key: "common.undo", params: {}}}), messageTuple(['redo', 'redo', interfaceText("common.redo"), 'Ctrl Shift Z'], {2: {key: "common.redo", params: {}}}), null,
      messageTuple(['copy', 'duplicate', interfaceText("common.copy"), 'Ctrl C', noFigure], {2: {key: "common.copy", params: {}}}), messageTuple(['paste', 'clipboard', interfaceText("common.paste"), 'Ctrl V'], {2: {key: "common.paste", params: {}}}),
      messageTuple(['paste-in-place', 'clipboard', interfaceText("applicationMenu.pasteInPlace"), 'Ctrl Shift V'], {2: {key: "applicationMenu.pasteInPlace", params: {}}}),
      messageTuple(['duplicate', 'duplicate', interfaceText("applicationMenu.duplicateSelection"), 'Ctrl D', noFigure], {2: {key: "applicationMenu.duplicateSelection", params: {}}}),
      messageTuple(['delete', 'trash', interfaceText("applicationMenu.deleteSelection"), "Delete", noFigure], {2: {key: "applicationMenu.deleteSelection", params: {}}}), null,
      messageTuple(['select-all', 'cursor', interfaceText("applicationMenu.selectAll"), 'Ctrl A'], {2: {key: "applicationMenu.selectAll", params: {}}}), messageTuple(['select-invert', 'cursor', interfaceText("applicationMenu.invertSelection")], {2: {key: "applicationMenu.invertSelection", params: {}}}), null,
      messageTuple(['settings', 'settings', interfaceText("applicationMenu.preferences"), 'Ctrl ,'], {2: {key: "applicationMenu.preferences", params: {}}}),
    ],
    view: [
      messageTuple(['zoom-in', 'plus', interfaceText("applicationMenu.zoomIn"), '+'], {2: {key: "applicationMenu.zoomIn", params: {}}}), messageTuple(['zoom-out', 'minus', interfaceText("applicationMenu.zoomOut"), '−'], {2: {key: "applicationMenu.zoomOut", params: {}}}),
      messageTuple(['zoom-reset', 'frame', interfaceText("applicationMenu.fitCanvas"), 'Shift 1'], {2: {key: "applicationMenu.fitCanvas", params: {}}}), messageTuple(['zoom-selection', 'center', interfaceText("applicationMenu.fitSelection"), 'Shift 2', noFigure], {2: {key: "applicationMenu.fitSelection", params: {}}}), null,
      messageTuple(['toggle-handles', 'joints', interfaceText("applicationMenu.joints"), 'Shift J'], {2: {key: "applicationMenu.joints", params: {}}}),
      messageTuple(['toggle-motion-paths', 'motion-path', interfaceText("applicationMenu.motionPaths"), "M"], {2: {key: "applicationMenu.motionPaths", params: {}}}),
      messageTuple(['toggle-onion', 'onion', interfaceText("applicationMenu.onionSkin"), "O"], {2: {key: "applicationMenu.onionSkin", params: {}}}),
      messageTuple(['toggle-grid', 'grid', interfaceText("applicationMenu.grid")], {2: {key: "applicationMenu.grid", params: {}}}), null,
      messageTuple(['scene-settings', 'scene', interfaceText("applicationMenu.sceneProperties")], {2: {key: "applicationMenu.sceneProperties", params: {}}}), null,
      messageTuple(['layout-focus', 'maximize', interfaceText("applicationMenu.focusMode")], {2: {key: "applicationMenu.focusMode", params: {}}}),
      messageTuple(['layout-menu', 'layout', interfaceText("applicationMenu.layout")], {2: {key: "applicationMenu.layout", params: {}}}),
    ],
    // The Joint menu (data-app-menu="editor"): the selected joint's segment and branch.
    editor: [
      segment('segment-values', 'sliders', interfaceText("applicationMenu.exactValues"), "I"), null,
      segment('split-segment', 'split', interfaceText("applicationMenu.splitSegment")),
      segment('unsplit-segment', 'builder-unsplit', interfaceText("applicationMenu.removeJointKeepEnds"), 'Ctrl Delete'),
      segment('origin-segment', 'origin', interfaceText("applicationMenu.setAsOrigin")), null,
      {label: interfaceText("common.duplicate"), labelKey: "common.duplicate", icon: 'duplicate', disabled: noJoint, submenu: [
        segment('duplicate-segment', 'duplicate', interfaceText("applicationMenu.duplicateSegment")),
        segment('duplicate-branch', 'duplicate', interfaceText("applicationMenu.duplicateBranch")),
      ]},
      {label: interfaceText("applicationMenu.flip"), labelKey: "applicationMenu.flip", icon: 'flip', disabled: noJoint, submenu: [
        segment('mirror-segment', 'flip', interfaceText("applicationMenu.flipSegmentHorizontally")),
        segment('mirror-segment-vertical', 'flip-vertical', interfaceText("applicationMenu.flipSegmentVertically")),
        null,
        segment('mirror-branch', 'flip', interfaceText("applicationMenu.flipBranchHorizontally")),
        segment('mirror-branch-vertical', 'flip-vertical', interfaceText("applicationMenu.flipBranchVertically")),
      ]},
      {label: interfaceText("applicationMenu.arrange"), labelKey: "applicationMenu.arrange", icon: 'layers', disabled: noJoint, submenu: [
        segment('segment-order-front', 'bring-to-front', interfaceText("applicationMenu.bringSegmentToFront")),
        segment('segment-order-up', 'up', interfaceText("applicationMenu.bringSegmentForward")),
        segment('segment-order-down', 'down', interfaceText("applicationMenu.sendSegmentBackward")),
        segment('segment-order-back', 'send-to-back', interfaceText("applicationMenu.sendSegmentToBack")),
      ]},
      null,
      segment('delete-single-segment', 'trash', interfaceText("applicationMenu.deleteSegment"), "Delete"),
      segment('delete-segment', 'trash', interfaceText("applicationMenu.deleteBranch"), 'Shift Delete'),
    ],
    animation: [
      messageTuple(['play', 'play', interfaceText("applicationMenu.playPause"), 'Space'], {2: {key: "applicationMenu.playPause", params: {}}}), messageTuple(['toggle-loop', 'loop', interfaceText("applicationMenu.loop")], {2: {key: "applicationMenu.loop", params: {}}}), null,
      messageTuple(['first-frame', 'first', interfaceText("applicationMenu.firstFrame"), "Home"], {2: {key: "applicationMenu.firstFrame", params: {}}}), messageTuple(['previous-frame', 'previous', interfaceText("applicationMenu.previousFrame"), '←'], {2: {key: "applicationMenu.previousFrame", params: {}}}),
      messageTuple(['next-frame', 'next', interfaceText("applicationMenu.nextFrame"), '→'], {2: {key: "applicationMenu.nextFrame", params: {}}}), messageTuple(['last-frame', 'last', interfaceText("applicationMenu.lastFrame"), "End"], {2: {key: "applicationMenu.lastFrame", params: {}}}), null,
      messageTuple(['add-frame', 'plus', interfaceText("applicationMenu.addFrame"), 'A'], {2: {key: "applicationMenu.addFrame", params: {}}}), null,
      {label: interfaceText("applicationMenu.movieclip"), labelKey: "applicationMenu.movieclip", icon: 'frame', submenu: [
        messageTuple(['movieclip-new', 'frame', interfaceText("applicationMenu.newMovieclip")], {2: {key: "applicationMenu.newMovieclip", params: {}}}),
        messageTuple(['movieclip-create', 'frame', interfaceText("applicationMenu.movieclipFromSelection"), '', noFigure], {2: {key: "applicationMenu.movieclipFromSelection", params: {}}}),
        messageTuple(['movieclip-range', 'frame', interfaceText("applicationMenu.movieclipFromFrameRange")], {2: {key: "applicationMenu.movieclipFromFrameRange", params: {}}}),
      ]},
      null,
      messageTuple(['delete-frame', 'trash', interfaceText("applicationMenu.deleteKeyframe")], {2: {key: "applicationMenu.deleteKeyframe", params: {}}}),
    ],
    help: [messageTuple(['help', 'help', interfaceText("applicationMenu.keyboardShortcuts"), '?'], {2: {key: "applicationMenu.keyboardShortcuts", params: {}}}), messageTuple(['tutorials', 'learn', interfaceText("commands.tutorials")], {2: {key: "commands.tutorials", params: {}}}), messageTuple(['performance', 'activity', interfaceText("applicationMenu.performance")], {2: {key: "applicationMenu.performance", params: {}}}), ...(desktop?.sendTelemetryFeedback ? [null, messageTuple(['feedback', 'help', interfaceText("applicationMenu.sendFeedbackReportABug")], {2: {key: "applicationMenu.sendFeedbackReportABug", params: {}}})] : []), ...(desktop?.getUpdateState ? [null, messageTuple(['check-updates', 'import', interfaceText("applicationMenu.checkForUpdates")], {2: {key: "applicationMenu.checkForUpdates", params: {}}}), messageTuple(['release-notes', 'file', interfaceText("applicationMenu.whatSNew")], {2: {key: "applicationMenu.whatSNew", params: {}}}), messageTuple(['donate', 'help', interfaceText("applicationMenu.supportDevelopment")], {2: {key: "applicationMenu.supportDevelopment", params: {}}})] : []), ...(desktop?.getTelemetryState ? [null, messageTuple(['privacy', 'settings', interfaceText("applicationMenu.privacyDiagnostics")], {2: {key: "applicationMenu.privacyDiagnostics", params: {}}}), messageTuple(['website', 'help', interfaceText("applicationMenu.stykanimateWebsite")], {2: {key: "applicationMenu.stykanimateWebsite", params: {}}})] : [])],
  };
  return (menus[name] || menus.file).map(item => item && HOTKEY_BY_ID.has(item[0]) ? messageTuple([item[0], item[1], item[2], shortcutLabel(undefined, item[0]), item[4]], tupleMessages(item)) : item);
}
