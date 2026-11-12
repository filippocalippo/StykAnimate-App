import {messageTuple} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

/**
 * The canvas's right-click menus in Animate (Build has its own, builder-context-menu.mjs). They show only what you
 * reach for while posing: the clipboard, the figure's everyday commands and Delete last. Rarer commands for the same
 * thing (the paste kinds, selecting, matching poses, the library) are in one submenu, so the menu stays short.
 * Rows are the app's menu tuples ([command, glyph, label, shortcut, disabled]), group names ({label}), submenus
 * ({label, icon, submenu}) and null between groups.
 */
const row = (command, glyph, key, shortcut = '', disabled = false) =>
  messageTuple([command, glyph, interfaceText(key), shortcut, disabled], {2: {key, params: {}}});

/** Paste in place, as an instance or as a unique copy: the paste kinds behind Paste as ▸ and More ▸. */
export function pasteKindItems() {
  return [
    row('paste-in-place', 'clipboard', 'app.pasteInPlace', 'Ctrl Shift V'),
    row('paste-instance', 'clipboard', 'app.pasteInstance'),
    row('paste-unique', 'duplicate', 'app.pasteUniqueCopy'),
  ];
}

/** The selection's less frequent commands (the `selection-more` command, and More figure actions ▸ on the canvas). */
export function selectionMoreItems({join = null} = {}) {
  return [
    {label: interfaceText('app.select'), labelKey: 'app.select'},
    row('select-same', 'person', 'app.selectSameFigure'),
    row('select-invert', 'cursor', 'app.invertSelection'),
    null,
    {label: interfaceText('app.pose'), labelKey: 'app.pose'},
    row('locate-previous', 'match-prev', 'app.matchPreviousPose', 'L'),
    row('locate-next', 'match-next', 'app.matchNextPose', 'Shift L'),
    ...(join ? [join] : []),
    null,
    row('add-to-library', 'plus', 'app.addToLibrary'),
    row('zoom-selection', 'center', 'app.fitSelection', 'Shift 2'),
  ];
}

/**
 * The menu for a right-click on the canvas. `hit` is false for empty canvas; otherwise `title` names the selection,
 * `join` is the Join or Unjoin row, `joint` says a single joint of a posable figure was clicked, `canDisconnect`
 * whether its branch can come off, and `building`/`movieclip` leave out what does not apply there.
 */
export function canvasMenuItems({hit, title = '', join = null, joint = false, canDisconnect = false, building = false, movieclip = false, single = true}) {
  if (!hit) return [
    row('paste', 'clipboard', 'common.paste', 'Ctrl V'),
    {label: interfaceText('app.pasteAs'), labelKey: 'app.pasteAs', icon: 'clipboard', submenu: pasteKindItems()},
    null,
    row('select-all', 'cursor', 'app.selectAll', 'Ctrl A'),
    null,
    row('scene-settings', 'scene', 'app.sceneProperties'),
    row('zoom-reset', 'fit', 'app.fitCanvas', 'Shift 1'),
  ];
  return [
    {label: title},
    row('copy', 'duplicate', 'common.copy', 'Ctrl C'),
    row('paste', 'clipboard', 'common.paste', 'Ctrl V'),
    row('duplicate', 'duplicate', 'common.duplicate', 'Ctrl D'),
    null,
    {label: interfaceText('applicationMenu.flip'), labelKey: 'applicationMenu.flip', icon: 'flip', submenu: [
      row('mirror', 'flip', 'app.flipHorizontally', 'Shift H'),
      row('mirror-vertical', 'flip-vertical', 'app.flipVertically', 'Shift V'),
    ]},
    ...(join ? [join] : []),
    ...(joint ? [row('disconnect-segment', 'cut', 'app.disconnectSegment', '', !canDisconnect), row('segment-values', 'sliders', 'app.exactValues', 'I')] : []),
    row('camera-follow', 'camera', 'app.followWithCamera', '', building),
    {label: interfaceText('app.moreFigureActions2'), labelKey: 'app.moreFigureActions2', icon: 'more', submenu: [
      {label: interfaceText('common.paste'), labelKey: 'common.paste'},
      ...pasteKindItems(),
      null,
      ...selectionMoreItems(),
    ]},
    ...(!building && !movieclip ? [null, row('edit-in-build-mode', 'nodes', 'app.editInBuild', '', !single)] : []),
    null,
    ['delete', 'trash', 'Delete', 'Delete'],
  ];
}
