import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
/** Bounded figure-builder sessions.
 *
 * A session is bound to one figure definition: either the selected scene
 * figure (`edit`) or a figure the user is about to create (`create`). While a
 * session is open the app constrains picking and selection to instances of the
 * bound definition, so every document change inside the session is bounded to
 * that figure (or is part of the session window either way).
 *
 * Commits ride the existing command history. Every command records the
 * document revision it was created from, so `beforeRevision >= baselineRevision`
 * identifies session work precisely even after old entries are evicted. Exit
 * choices:
 *   update      keep the edits on the shared definition (every instance)
 *   import-new  restore the original definition, then add the edited figure as
 *               a new definition and instance via an ordinary import command
 *   discard     undo all session commands; if history eviction dropped early
 *               session entries, fall back to the captured baseline so the
 *               document still ends up exactly as it was
 *   import      (create mode) keep the drawn figure in the scene
 *
 * The session intentionally does not snapshot the document: history undo
 * restores exact pre-session state including object poses, joins and frame
 * sources, which a definition-only snapshot could not.
 */
import {isMovieclip} from './movieclips.mjs';
import {drawingMetadata, isDrawingLayer} from './drawing-model.mjs';

const clone = value => structuredClone(value);

export class BuilderSession {
  constructor(editor) {
    this.editor = editor;
    this.mode = 'create';
    this.typeId = null;
    this.uid = null;
    this.stale = false;
    this.baselineFigure = null;
    this._uidsSource = null;
    this._uids = new Set();
  }
  /** Binds to the selected figure, or to the next new figure the user creates. */
  begin() {
    const editor = this.editor;
    this.documentToken = editor._documentToken;
    this.baselineRevision = editor.revision;
    this.preexistingUids = new Set(editor.selectionFrame.objects.map(object => object.unique_id));
    this.preexistingTypeIds = new Set(editor.report.figure_types.map(figure => figure.figure_type_id));
    const object = editor.object, figure = editor.figure;
    const editableLayer = layer => layer?.kind === 'layer' && layer.visible && !layer.locked && !isDrawingLayer(layer);
    const selectedLayer = object && editor.getLayer(editor.layerForUid(object.unique_id));
    if (object && figure && !isMovieclip(figure) && !drawingMetadata(figure) && editableLayer(selectedLayer)) {
      editor.setActiveLayer(selectedLayer.id);
      this.mode = 'edit';
      this.typeId = figure.figure_type_id;
      this.uid = object.unique_id;
      this.baselineFigure = clone(figure);
    } else {
      // Draw and the fixed tracks are not figure insertion targets. Clear their
      // selection before binding, so a drawing cel can never become the rig.
      editor.select(null);
      const active = editor.getLayer(editor.activeLayerId);
      const target = (editableLayer(active) ? active : editor.layers.find(editableLayer)) ?? editor.createLayer();
      editor.setActiveLayer(target.id);
    }
    return this;
  }
  /** The bound definition. Independent of selection: it exists even when no
   * bound instance is currently on screen or selected. */
  get figure() {
    return this.typeId === null ? null :
      this.editor.report.figure_types.find(figure => figure.figure_type_id === this.typeId) ?? null;
  }
  /** UIDs of bound-figure instances in the current selection frame. Lazily
   * rebuilt whenever the frame's object array changes identity. */
  get boundUids() {
    const editor = this.editor;
    const sel = editor.selectionFrame.objects, authored = editor.frame.objects;
    // Identity plus length: frames mutate object arrays in place
    // (frame.objects.push), and the authored frame is unioned in so a
    // just-created instance is bound before the evaluated frame catches up.
    if (sel !== this._uidsSource || authored !== this._uidsAuthored || sel.length !== this._uidsLength ||
        authored.length !== this._uidsAuthoredLength || this._uidsType !== this.typeId) {
      this._uidsSource = sel;
      this._uidsAuthored = authored;
      this._uidsLength = sel.length;
      this._uidsAuthoredLength = authored.length;
      this._uidsType = this.typeId;
      this._uids = new Set();
      if (this.typeId !== null) {
        for (const object of sel) if (object.figure_type_id === this.typeId) this._uids.add(object.unique_id);
        if (sel !== authored)
          for (const object of authored) if (object.figure_type_id === this.typeId) this._uids.add(object.unique_id);
      }
    }
    return this._uids;
  }
  /** A bound instance to keep selected: the entry instance when present. */
  get preferredUid() {
    return this.uid !== null && this.boundUids.has(this.uid) ? this.uid : this.boundUids.values().next().value ?? null;
  }
  /** Session commands are exactly the undo entries recorded after begin. */
  get changed() {
    return this.editor._undo.some(command => command.beforeRevision >= this.baselineRevision);
  }
  /** Reacts to document changes: detects document replacement and adopts the
   * first figure created inside a `create` session. */
  sync() {
    if (this.stale) return;
    if (this.editor._documentToken !== this.documentToken) { this.stale = true; return; }
    if (this.mode === 'create' && this.typeId === null) {
      // The authored keyframe is checked too: under the layer-sheet timeline
      // the evaluated selection frame can lag a just-created object.
      const object = this.editor.object ??
        this.editor.frame.objects.find(candidate => candidate.unique_id === this.editor.selectedUid);
      if (object && !this.preexistingUids.has(object.unique_id) && !this.preexistingTypeIds.has(object.figure_type_id)) {
        this.typeId = object.figure_type_id;
        this.uid = object.unique_id;
      }
    }
  }
  /** Undoes every command recorded since begin, oldest-eviction safe. Entries
   * move to the redo stack, so a discard remains recoverable. */
  undoSession() {
    const undo = this.editor._undo;
    while (undo.length && undo.at(-1).beforeRevision >= this.baselineRevision) this.editor.undo();
  }
  /** Applies an exit decision. Returns the new scene object for import-new. */
  resolve(choice) {
    if (choice === 'import-new') return this._resolveImportNew();
    if (choice === 'discard') {
      this.undoSession();
      this._repairDiscard();
      return null;
    }
    // 'update' (edit) and 'import' (create): the live document is the result.
    return null;
  }
  _resolveImportNew() {
    const editor = this.editor;
    if (!this.figure?.segments?.length) throw messageError(new Error(''), "errors.builderSession.theEditedFigureNoLongerExists", {});
    // The definition alone is not the displayed figure: native poses, paint
    // overrides and rig controls belong to its instance. Capture both before
    // undo restores the original, using the same portable format as the library.
    const edited = editor._shown.figureDocument({figureUid: this.preferredUid, tick: editor.tick});
    this.undoSession();
    const source = editor.selectionFrame.objects.find(object => object.unique_id === this.uid)
      ?? editor.selectionFrame.objects.find(object => object.figure_type_id === this.typeId);
    const position = source
      ? {x: source.root_x + 24, y: source.root_y + 24}
      : {x: editor.report.canvas_width / 2, y: editor.report.canvas_height / 2};
    return editor.importFigure(edited, {position});
  }
  /** Covers the rare case where session commands were evicted before discard:
   * restores the bound definition (edit) or removes the created figure
   * (create), as one undoable command of the engine. */
  _repairDiscard() {
    const editor = this.editor;
    if (this.mode === 'edit') {
      const current = this.figure;
      if (current && JSON.stringify(current) !== JSON.stringify(this.baselineFigure))
        editor.replaceFigureDefinition(this.typeId, clone(this.baselineFigure), {label: interfaceText("builderSession.discardFigureEdits"), labelKey: "builderSession.discardFigureEdits"});
      return;
    }
    if (this.typeId === null || !editor.report.figure_types.some(figure => figure.figure_type_id === this.typeId)) return;
    this._removeCreatedFigure(this.typeId);
  }
  /** The creation of the figure left the history: its instances in every frame and its definition go, as one entry of the engine. */
  _removeCreatedFigure(typeId) {
    this.editor.discardNewFigure(typeId, {label: interfaceText("builderSession.discardNewFigure"), labelKey: "builderSession.discardNewFigure"});
  }
}
