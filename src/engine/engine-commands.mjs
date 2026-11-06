// The editor calls the engine's session runs (D19), as the interface makes them.
//
// One list, held to the session's own dispatch (`engine/crates/styk-edit/src/lib.rs` and the modules it delegates to) by
// tests/engine-owner-commands.test.mjs: every name here is a command the session has, and every public method of the editor
// that is in neither list is one it answers "no command" for. The owner (`engine-owner.mjs`) installs each of these on the
// editor, so the editor's own body of a call is never run (deleting one changes nothing here).

/** Calls that only change what is shown or selected: the editor runs them, and the session receives the result as the view of the next call. */
export const VIEW_CALLS = Object.freeze(new Set(['select', 'selectMany', 'selectPolygon', 'toggleSegment', 'selectBranch', 'selectConnected', 'selectMarquee',
  'selectSameDefinition', 'invertSelection', 'seek', 'setActiveLayer', 'selectSheetLayer', 'selectFrame', 'keepSelectionOnSeek']));

/** The commands of the session that edit the document, its history or the gesture in progress. The calls that only move the view
 * (`select`, `seek`, …) and the reads stay the editor's (`VIEW_CALLS` in the owner). `movieclipBatch`, `bakeMovieclip`
 * (the session's `bakeMovieclipBegin`, `bakeMovieclipSample` and `bakeMovieclipPublish`, with the thread given back between them) and
 * the drawing pixel commits (`commitDrawingPixels`, `resampleDrawing`) are the owner's compositions of session calls; `undo` and `redo` are its own. */
export const SESSION_COMMANDS = Object.freeze([
  'addAnimationKey', 'addAnimationKeys', 'addAudioTrack', 'addCameraMotion', 'addConnector', 'addDraftFrame', 'addDrawingFrame', 'addFigure',
  'addFigureInFrames', 'addMovieclipToNextKeyframes', 'addPaletteColor', 'addPaletteColors', 'addPolygon', 'addSegment', 'addSegments',
  'addSpriteSegment', 'addVfx', 'addVfxClip', 'addVfxGroup', 'addVfxGroupEffect', 'addVfxUserPreset', 'addWeightedJoint', 'alignCameraToView',
  'alignFiguresInFrames', 'alignHandle', 'alignSelection', 'applyCameraToFigures', 'applyVfxPreset', 'arrangeLayers', 'assignFiguresToLayer',
  'autoKeyDrawing', 'bakeCameraMotion', 'bakeMovieclipBegin', 'bakeMovieclipCancel', 'bakeMovieclipPublish', 'bakeMovieclipSample',
  'beginAnimationEdit', 'beginCameraDrag', 'beginDrag', 'beginDuplicateDrag',
  'beginFigureHandleDrag', 'beginFrameDraft', 'beginFrameDraftPreview', 'beginHandleEditDrag', 'beginMotionPathEdit', 'beginRigDrag',
  'beginSegmentValueEdit', 'beginTranslationDrag', 'beginTween', 'beginVfxClipEdit', 'bendJoint', 'bindStretchParts', 'breakApartMovieclip',
  'bringToFront', 'cancelAnimationEdit', 'cancelAuthoredPoseDrag', 'cancelCameraDrag', 'cancelDocumentPreview', 'cancelDrag',
  'cancelFigureHandleDrag', 'cancelHandleEditDrag', 'cancelMotionPathEdit', 'cancelRigDrag', 'cancelVfxClipEdit', 'centerCamera', 'centerFigure',
  'centerFiguresInFrames', 'changeBranchThickness', 'combineJoinedFigure', 'commitAnimationEdit', 'commitCameraDrag', 'commitDrag',
  'commitDrawingPixels', 'commitFigureHandleDrag', 'commitFrameDraft', 'commitHandleEditDrag', 'commitMotionPathEdit', 'commitRigDrag',
  'commitVfxClipEdit', 'convertSegment', 'copyAudioClip', 'copyCamera', 'copyCameraMotion', 'copySegmentValues', 'copySelection', 'copyVfxClip',
  'createDrawingLayer', 'createEmptyMovieclip', 'createLayer', 'createLayerFolder', 'createMovieclip', 'cutAudioClip', 'cutSelection',
  'deleteAudioClip', 'deleteAudioTrack', 'deleteCameraMotion', 'deleteFigure', 'deleteFiguresInFrames', 'deleteLayer', 'deleteLayerFolder',
  'deleteSegment', 'deleteSelection', 'deleteSingleSegment', 'deleteVfxClip', 'deleteVfxClipKeys', 'detachFiguresInFrames', 'disableFrameDrafts',
  'discardFrameDraft', 'discardNewFigure', 'disconnectSegment', 'drawingKey', 'duplicateAudioClip', 'duplicateCameraMotion', 'duplicateFigure',
  'duplicateFiguresInFrames', 'duplicateInFrames', 'duplicateSegment', 'duplicateSegmentBranch', 'duplicateSelection', 'duplicateVfx',
  'duplicateVfxClip', 'editFigureColors', 'editFrameDraftTimeline', 'editHandlePosition', 'editRigJoint', 'editStoredFrames', 'enableFrameDrafts',
  'enableSmartStretch', 'endFrameDraftPreview', 'extendDrawing', 'finishDuplicateDrag', 'importAudio', 'importFigure', 'importSceneBackground',
  'joinFigure', 'joinFiguresInFrames', 'joinTo', 'locateCamera', 'locateEditedHandle', 'locateHandle', 'makeMovieclipUnique', 'mirrorFigure',
  'mirrorFiguresInFrames', 'mirrorSegment', 'mirrorSegmentBranch', 'mirrorSelection', 'moveBuilderOrder', 'moveBuilderSegment', 'moveLayerTo',
  'moveLayersToFolder', 'movePaletteColor', 'moveSelection', 'moveSelectionInFrames', 'moveSelectionLayer', 'moveVfx', 'moveVfxClipKey',
  'moveVfxClipKeys', 'moveVfxClipOrder', 'nextDrawing', 'nudgeHandle', 'orderFiguresInFrames', 'orderSelection', 'pasteAudioClip', 'pasteCamera',
  'pasteCameraMotion', 'pasteFiguresInFrames', 'pasteSegmentValues', 'pasteSelection', 'pasteVfx', 'pasteVfxClip', 'placeMovieclip', 'poseJoint',
  'previewAnimationEdit', 'previewCameraMotion', 'previewLayerParallax', 'randomizeCameraMotion', 'removeMovieclipRestart', 'removePaletteColor',
  'removePolygon', 'removeVfx', 'renameLayer', 'renameLayerFolder', 'renameMovieclip', 'renameSceneBackground', 'reorderLayers', 'reorderVfx',
  'reorderVfxGroupEffect', 'replaceFigureColor', 'replaceFigureDefinition', 'resampleDrawing', 'resetCamera', 'resetFigureColors', 'resetPose',
  'resetPoseInFrames', 'resetSpatialPose', 'resetSpatialProportions', 'resetVfx', 'restartMovieclip', 'rippleAudio', 'rotateFigure',
  'rotateFiguresInFrames', 'rotateIKTarget', 'rotateJoint', 'rotateSelection', 'scaleFiguresInFrames', 'scaleSelected', 'scaleSelection',
  'sendToBack', 'setAngleLock', 'setAudioClip', 'setAudioTrack', 'setBackgroundColor', 'setBranchCaps', 'setBranchFill', 'setBuilderOrder',
  'setCameraMotion', 'setCameraValues', 'setCanvasSize', 'setConnectorPosition', 'setFPS', 'setFigureColor', 'setFrameDuration', 'setLayerColor',
  'setLayerLocked', 'setLayerParallax', 'setLayerVisible', 'setMotionPathFalloff', 'setMovieclipDrawing', 'setMovieclipPlayback', 'setNodeIK',
  'setOrigin', 'setPolygonOpacity', 'setPoseChoice', 'setPoseProperty', 'setRigBehavior', 'setSceneBackground', 'setSceneColor', 'setSecondaryAngleReference',
  'setSegmentValues', 'setSpatialCamera', 'setSpatialFeetPinned', 'setSpatialIKTarget', 'setSpatialMotion', 'setSpatialPose',
  'setSpatialProportions', 'setVfxClip', 'setVfxClipEasing', 'setVfxClipParameter', 'setVfxClipParameters', 'setVfxParameter', 'setVfxScope',
  'sheetAppendFrame', 'sheetClearFrames', 'sheetClearKeys', 'sheetCopyFrames', 'sheetDuplicateFrameAfter', 'sheetInsertFrames', 'sheetInsertKey',
  'sheetMoveFrames', 'sheetPasteFrames', 'sheetRemoveFrames', 'sheetSetDuration', 'sheetSetEasing', 'sheetTransferFrames', 'slideConnector',
  'splitAudioClip', 'splitBuilderSegments', 'splitMovieclip', 'splitSegment', 'splitSegmentBranch', 'toggleVfxClipKey', 'transformCamera',
  'transformFigureHandle', 'trimVfxClipStart', 'unjoinFigure', 'unsplitSegment', 'updateBuilderSegmentStyle', 'updateCameraDrag', 'updateDraftFrame',
  'updateFigureStyle', 'updateFiguresInFrames', 'updateMotionPathEdit', 'updateObject', 'updatePolygon', 'updateProject', 'updateSegment',
  'updateSegmentBranchStyle', 'updateSegmentStyle', 'updateSelection', 'updateTween',
]);
