/**
 * An export renderer for tests that run in the app's page (`window.styk` is ready): the
 * engine's, on the app's stage and playback adapter, as the export dialog creates it
 * (src/engine/engine-export.mjs). Pass `{vector: true}` for SVG. The engine is brought to the
 * report given to `load()` at the editor's revision.
 */
import {createExportFrameRenderer} from '/src/engine/engine-export.mjs';

export function pageExporter(options = {}, {vector = false} = {}) {
  const {editor, playback, state} = window.styk;
  return createExportFrameRenderer(options, {stage: state.renderer, playback, revision: editor.revision, vector});
}
