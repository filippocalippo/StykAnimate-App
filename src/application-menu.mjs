/** Classic application menus use the same commands as keyboard and canvas actions. */
export function applicationMenuItems(name, editor, desktop) {
  const noFigure = !editor.object;
  const noJoint = noFigure || Boolean(editor.figure?._styk?.movieclip) || editor.selectedJoint < 0 || editor.selectedUids?.size > 1;
  const segment = (action, symbol, label, shortcut = '') => [action, symbol, label, shortcut, noJoint];
  const menus = {
    file: [
      ['new', 'plus', 'New animation', 'Ctrl N'],
      ['open', 'folder', 'Open project…', 'Ctrl O'],
      ['open-recent', 'clock', 'Open recent…', '', !desktop?.listRecentFiles],
      null,
      ['save', 'save', 'Save', 'Ctrl S'],
      ['save-as', 'save', 'Save as…', 'Ctrl Shift S'],
      ['export-stkz', 'person', 'Save figure…', '', noFigure],
      ['rename', 'file', 'Rename project…'],
      null,
      ['import', 'import', 'Import figures…'],
      ['import-sprite', 'image', 'Import sprite image…'],
      ['import-background', 'image', 'Import background…'],
      ['export', 'export', 'Export…'],
    ],
    edit: [
      ['undo', 'undo', 'Undo', 'Ctrl Z'], ['redo', 'redo', 'Redo', 'Ctrl Shift Z'], null,
      ['copy', 'duplicate', 'Copy', 'Ctrl C', noFigure], ['paste', 'clipboard', 'Paste', 'Ctrl V'],
      ['duplicate', 'duplicate', 'Duplicate selection', 'Ctrl D', noFigure],
      ['delete', 'trash', 'Delete selection', 'Delete', noFigure], null,
      ['select-all', 'cursor', 'Select all', 'Ctrl A'], ['select-invert', 'cursor', 'Invert selection'], null,
      ['settings', 'settings', 'Preferences…', 'Ctrl ,'],
    ],
    view: [
      ['zoom-in', 'plus', 'Zoom in', '+'], ['zoom-out', 'minus', 'Zoom out', '−'],
      ['zoom-reset', 'frame', 'Fit canvas', 'Shift 1'], ['zoom-selection', 'center', 'Fit selection', 'Shift 2', noFigure], null,
      ['toggle-handles', 'nodes', 'Show / hide joints', 'J'],
      ['toggle-onion', 'onion', 'Toggle onion skin', 'O'],
      ['scene-settings', 'frame', 'Scene properties'],
    ],
    editor: [
      segment('segment-values', 'sliders', 'Segment editor…', 'I'), null,
      segment('split-segment', 'split', 'Split segment'),
      segment('unsplit-segment', 'nodes', 'Remove joint, keep endpoints', 'Ctrl Delete'),
      segment('origin-segment', 'origin', 'Set as origin'),
      segment('duplicate-segment', 'duplicate', 'Duplicate segment'),
      segment('duplicate-branch', 'duplicate', 'Duplicate branch'), null,
      segment('mirror-segment', 'flip', 'Mirror segment horizontally'),
      segment('mirror-segment-vertical', 'flip', 'Mirror segment vertically'),
      segment('mirror-branch', 'nodes', 'Mirror branch horizontally'),
      segment('mirror-branch-vertical', 'nodes', 'Mirror branch vertically'), null,
      segment('segment-order-front', 'bring-to-front', 'Bring segment to front'),
      segment('segment-order-up', 'chevron-right', 'Bring segment forward'),
      segment('segment-order-down', 'chevron-left', 'Send segment backward'),
      segment('segment-order-back', 'send-to-back', 'Send segment to back'), null,
      segment('delete-single-segment', 'minus', 'Delete segment', 'Delete'),
      segment('delete-segment', 'trash', 'Delete branch', 'Shift Delete'),
    ],
    animation: [
      ['movieclip-new', 'frame', 'New movieclip…'],
      ['movieclip-create', 'frame', 'Movieclip from selection…', '', noFigure],
      ['movieclip-range', 'frame', 'Movieclip from frame range…'], null,
      ['play', 'play', 'Play / pause', 'Space'], ['toggle-loop', 'loop', 'Toggle loop'], null,
      ['first-frame', 'first', 'First frame', 'Home'], ['previous-frame', 'previous', 'Previous frame', '←'],
      ['next-frame', 'next', 'Next frame', '→'], ['last-frame', 'next', 'Last frame', 'End'], null,
      ['add-frame', 'plus', 'Add keyframe', 'F6'], ['delete-frame', 'trash', 'Delete keyframe'],
      ['duplicate-frame-after', 'duplicate', 'Duplicate frame after current', 'Ctrl Enter'],
      ['blank-frame', 'circle', 'Insert blank keyframe', '', !editor.report._styk?.layerSheet],
    ],
    help: [['help', 'help', 'Keyboard shortcuts', '?'], ['performance', 'activity', 'Performance']],
  };
  return menus[name] || menus.file;
}
