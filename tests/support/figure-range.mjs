/** The figure clipboard pasted into the frames `indices`: the engine session's command `pasteFiguresInFrames`, which an owned editor
 * forwards to (the options are the command's: `offset`, `pasteMode`, `pasteDepth`, `ticks`). */
export function pasteInFrames(editor, indices, options = {}) {
  return editor.pasteFiguresInFrames(indices, {...options, pasteMode: options.pasteMode ?? 'default'});
}
