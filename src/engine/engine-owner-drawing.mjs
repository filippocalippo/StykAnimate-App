/**
 * The interface's half of the drawing pixel commits the engine's session runs (docs/engine/drawing.md, "History").
 *
 * A stroke, an erase, a fill, a pasted or moved selection and a resample change the pixels of a cel, which the interface's
 * drawing store holds (`DrawingResources`) with their before and after tiles in its history (`DrawingHistory`, spilling to
 * disk). The session never takes tiles: it records a history entry that names the cel and the history record, with the label and
 * the weight this module measured (`engine/crates/styk-edit/src/drawing_pixels.rs`). Around the session's call this module
 *
 * - commits: lets the session record the entry, which names the record the history is about to make (the session also writes a cel
 *   the stroke created or migrated into the layer sheet), then applies the tiles to the store and tracks the record, before the
 *   call's events reach the interface;
 * - replays: before the session undoes or redoes an entry that names records, loads the records (they may be on the disk), prepares
 *   the tiles and checks nothing changed meanwhile; then the session's undo or redo and the store's tiles apply in one synchronous
 *   step, so a failed or cancelled replay changes neither;
 * - takes a commit back whose tiles could not be applied (the session drops the entry it recorded), and takes the tiles of the commits of
 *   a grouped edit back when the group fails (the session aborts it);
 * - follows the weights: a record whose tiles leave memory or come back weighs less or more in the session's history limit;
 * - lets go of what no entry refers to any more: records and cels, when the session says an entry that referred to them is gone.
 */
import {messageError} from '../localized-error.mjs';
import {drawingMetadata} from '../drawing-model.mjs';
import {drawingResourcesFor} from '../drawing-resources.mjs';
import {pixelChangeBytes} from '../drawing-pixels.mjs';
import {TILE_BYTES} from '../drawing-tiles.mjs';

/** The editor's calls that carry a cel's pixels: the session records them as entries, this module applies the pixels. */
export const DRAWING_COMMITS = new Set(['commitDrawingPixels', 'resampleDrawing']);

const aborted = () => messageError(new DOMException('', 'AbortError'), 'errors.editor.historyChangedBeforeUndoRedoCompleted', {});
const missing = () => messageError(new Error(''), 'errors.editorDrawing.theDrawingHistoryReferencesAMissingCel', {});

/**
 * @param {object} editor the app's Editor, owned by the engine
 * @param {{
 *   live(): object|null,
 *   call(name: string, args: Array, step: {adopted(answer: object): void}): any,
 *   adjust(record: number, delta: number): void,
 *   retract(record: number): void,
 *   synced(figures: object[]): void,
 * }} host `live`: the session of the editor's document (starting it if it can); `call`: a call of the session that runs `step.adopted`
 *   after its answer is adopted and before its events reach the interface; `adjust`: tells the session a record weighs `delta` bytes
 *   more; `retract`: the session takes back the entry it recorded for the record; `synced`: the cels' definitions were changed in place (revision, bounds): the session's copies follow.
 */
export function createOwnedDrawings(editor, host) {
  const resources = () => drawingResourcesFor(editor.report);
  const figureOf = celId => editor.report.figure_types.find(figure => drawingMetadata(figure)?.celId === celId) ?? null;
  /** What the session's history refers to by name: the pixel commits of the entry an undo (or redo) applies next, in the order it applies them. */
  const steps = redo => {
    const live = host.live();
    return live ? JSON.parse(live.query('drawingReplay', JSON.stringify([redo]), 'null')).v : [];
  };
  /** The entry's commands as the store prepares and checks them: oldest first, wherever the history holds them. */
  const rootOf = (list, redo) => {
    const history = resources()?.history;
    const commands = list.map(step => history?.commandOf(step.record));
    if (!history || commands.some(command => !command)) throw missing();
    return {root: {kind: 'drawing-replay', commands: redo ? commands : [...commands].reverse()}, commands, history};
  };

  /** Applies the tiles of the commits `list` names (`commands`: their history commands, in the same order) to the store in `direction`. */
  const applySteps = (list, commands, direction, prepared) => {
    const store = resources(), changed = [];
    list.forEach((step, index) => {
      const command = commands[index], figure = figureOf(step.celId), entry = figure ? store.entry(figure) : store.entries.get(step.celId);
      // The document may have lost the cel with this very entry (a creation undone): its store keeps the pixels for the redo.
      if (!entry) throw missing();
      store.applyEntry(entry, figure, command.tiles, direction, prepared);
      const d = figure && drawingMetadata(figure);
      if (d) {
        if (d.version === 2) d.bounds = command[`${direction}Bounds`] ?? null;
        changed.push(figure);
      }
    });
    editor._invalidate({timing: false});
    host.synced(changed);
  };

  /** `commitDrawingPixels(target, tiles, label, prepared, {resident})`. */
  function commitDrawingPixels(args) {
    const [target, tiles, label = 'Brush stroke', prepared, {resident = false} = {}] = args;
    if (!tiles.length) return false;
    const store = editor.drawingResources, history = store.pixelHistory();
    const {celId, bounds: beforeBounds = null} = drawingMetadata(target.figure);
    const command = {kind: 'drawing-pixels', celId, tiles, label, beforeBounds, afterBounds: null, bytes: pixelChangeBytes(tiles)};
    // The store's own memory check comes first: a refused commit has changed nothing.
    store.checkHistory(command, 'after', prepared);
    // The record the history will make of the commit, and what it will weigh: the session's entry names it before the tiles apply.
    const record = history.nextId(), created = Boolean(target.created), migrated = Boolean(target.migratedFrom);
    const exposure = {id: target.id, tick: target.key.tick, keyId: target.key.id, celId, selectable: Boolean(editor.getLayer(target.id)) && !editor.isLayerFocusLocked(target.id),
      ...(created || migrated ? {figure: target.figure, object: target.object} : {}), ...(created ? {created} : {}), ...(migrated ? {migratedFrom: target.migratedFrom} : {})};
    return host.call('commitDrawingPixels', [exposure, {record, bytes: history.weight(command)}, label], {
      adopted() {
        if (migrated) store.retarget(target.migratedFrom, target.figure);
        // Committing ends the gesture's exclusive hold on the store: publication barriers triggered by this commit's own broadcast must see the tiles.
        store.entry(target.figure).pinned = false;
        let figure;
        try {
          figure = figureOf(celId);
          if (!figure) throw missing();
          store.apply(figure, tiles, 'after', prepared, {resident});
          command.afterBounds = drawingMetadata(figure).bounds ?? null;
        } catch (error) {
          // The session recorded the entry: it takes it back, so no entry names a record the history never made, and the record's identity is not handed out again.
          history.skip(record);
          try { host.retract(record); } catch { /* the failure of the pixels is the error raised */ }
          throw error;
        }
        history.track(command, delta => host.adjust(record, delta));
        editor._invalidate({timing: false});
        host.synced([figure]);
      },
    });
  }

  /** `resampleDrawing(target, {pixelsPerUnit, tiles, bounds, owned})`: the session makes the cel of the new resolution; the store gets its tiles. */
  function resampleDrawing(args) {
    const [target, {pixelsPerUnit, tiles, bounds, owned = false}] = args;
    const store = editor.drawingResources;
    // The new cel's tiles must fit before the session records it.
    store.reserve((tiles?.length ?? 0) * TILE_BYTES);
    host.call('resampleDrawing', [{id: target.id, keyId: target.key.id, celId: drawingMetadata(target.figure).celId}, {pixelsPerUnit, bounds: bounds ?? null}], {
      adopted(answer) {
        // Install before the events: their drawing barrier encodes the resampled tiles instead of serializing an empty cel.
        const figure = figureOf(answer.result);
        if (!figure) throw missing();
        store.install(figure, tiles, {owned});
      },
    });
    return true;
  }

  /**
   * An undo or redo of the entry on top. When the entry names pixel commits, `run(pixels)` is the session's undo or redo and the
   * adoption of its answer, which calls `pixels(answer)` before the events: the store's tiles apply there. Loading cold records and
   * preparing large replacements wait; a replay that fails, is cancelled or finds the history changed leaves the pixels and the history as they were.
   */
  function replay(redo, signal, run) {
    const list = steps(redo);
    if (!list.length) return run();
    const store = resources(), direction = redo ? 'after' : 'before';
    const {root, commands, history} = rootOf(list, redo);
    const report = editor.report, revision = editor.revision;
    const check = () => { if (signal?.aborted || report !== editor.report || revision !== editor.revision) throw aborted(); };
    const apply = prepared => applySteps(list, commands, direction, prepared);
    const replayNow = prepared => {
      try {
        check();
        store.checkHistory(root, direction, prepared);
        return run(() => apply(prepared));
      } finally { prepared?.release(); }
    };
    const prepare = () => {
      check();
      const pending = store.prepareChanges(root, direction, {signal, checkCurrent: check});
      return pending ? pending.then(replayNow) : replayNow();
    };
    try {
      const pending = history.prepare(root, {signal}), result = pending ? pending.then(prepare) : prepare();
      if (result?.then) return result.finally(() => history.release(root));
      history.release(root);
      return result;
    } catch (error) {
      history.release(root);
      throw error;
    }
  }

  return {
    commitDrawingPixels,
    resampleDrawing,
    replay,
    /** The grouped edit failed: the tiles of the commits it recorded go back, last first, before the session takes their entries back. */
    abortBatch() {
      const live = host.live(), list = live ? JSON.parse(live.query('drawingBatch', '[]', 'null')).v : [];
      if (!list.length) return;
      const history = resources()?.history, commands = list.map(step => history?.commandOf(step.record));
      if (!history || commands.some(command => !command?.tiles)) throw missing();
      applySteps(list, commands, 'before');
    },
    /** The commands of the entry the next undo (`redo` false) or redo applies, as one root (oldest first), or null when it names none. */
    root(redo) {
      const list = steps(redo);
      return list.length ? rootOf(list, redo).root : null;
    },
    /** The records and cels the session's history refers to: `{records, cels}`. */
    refs() {
      const live = host.live();
      return live ? JSON.parse(live.query('drawingRefs', '[]', 'null')).v : undefined;
    },
  };
}
