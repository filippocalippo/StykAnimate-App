/** Camera commands use the inspector's existing button/group primitives. */
export function cameraActionsView({editor, button, group, tools}) {
  const selected = Boolean(editor.selectedObjects?.length ?? editor.object);
  return group('Camera pose', tools(
    button('camera-copy', 'duplicate', 'Copy camera pose') +
    button('camera-paste', 'clipboard', 'Paste camera pose', !editor._cameraClipboard) +
    button('camera-reset', 'undo', 'Reset camera pose'),
  )) + group('Center on selection', tools(
    button('camera-center', 'center', 'Center camera on selection', !selected) +
    button('camera-center-x', 'align-horizontal-center', 'Center camera horizontally', !selected) +
    button('camera-center-y', 'align-vertical-center', 'Center camera vertically', !selected),
  )) + group('Canvas alignment', tools(
    button('camera-align-view', 'fit', 'Fit camera to current canvas view') +
    button('camera-apply-figures', 'check', 'Apply camera transform to figures'),
  )) + group('Neighboring pose', tools(
    button('camera-locate-previous', 'chevron-left', 'Match previous camera pose', editor.frameIndex <= 0) +
    button('camera-locate-next', 'chevron-right', 'Match next camera pose', editor.frameIndex >= editor.report.keyframes.length - 1),
  ));
}
