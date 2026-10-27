import {localizedAttribute, messageHTML} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

/** Builder mode controller: owns the bounded figure session and its chrome —
 * the outliner (Structure), selection bounding, the context menu and the exit
 * flow. The part commands live where the selection is: Properties' quick tiles
 * and ⋯ menu, the right-click menu and the stage header (tool options and the
 * view toggles); they run through the app's shared [data-action] dispatcher.
 * Document work lives in BuilderSession; this module only coordinates UI. */
import {icon} from './icons.mjs';
import {BuilderSession} from './builder-session.mjs';
import {FigureOutliner, partName} from './builder-outliner.mjs';
import {builderContextItems} from './builder-context-menu.mjs';

const ENTRY_TOOLS = new Set(['rig', 'line', 'chain', 'circle', 'polygon', 'attach']);

export function initBuilderMode({editor, state, host}) {
  const workspace = document.querySelector('.workspace');
  const outlinerHost = document.getElementById('builder-outliner');
  if (!outlinerHost)
    return {enter: () => false, requestExit: () => {}, leave: () => {}, sync: () => {},
      get active() { return false; }, get session() { return null; }, get boundUids() { return null; },
      get mode() { return 'animate'; }};
  let session = null, events = null, context = null, resolving = false;
  /** Translates an outliner drop into a parent/sibling insert plan. 'before'
   * and 'after' keep the target's parent; 'child' reparents onto the target
   * (as first child so the drop point matches the row under the pointer). */
  function dropPlan(draggedId, target, zone) {
    const figure = session?.figure;
    if (!figure) return null;
    if (zone === 'child') {
      const firstChild = figure.segments.find(segment =>
        Number(segment.parent_id) === target.id && Number(segment.segment_id) !== draggedId);
      return {parentId: target.id, beforeId: firstChild ? Number(firstChild.segment_id) : null};
    }
    const parentId = target.parent;
    if (zone === 'before') return {parentId, beforeId: target.id};
    const siblings = figure.segments.filter(segment =>
      Number(segment.parent_id ?? 0) === parentId && Number(segment.segment_id) !== draggedId);
    const at = siblings.findIndex(segment => Number(segment.segment_id) === target.id);
    return {parentId, beforeId: at >= 0 && at + 1 < siblings.length ? Number(siblings[at + 1].segment_id) : null};
  }
  const outliner = new FigureOutliner(outlinerHost, {
    editor,
    onMove: (draggedId, target, zone) => {
      const plan = dropPlan(draggedId, target, zone);
      if (!plan) return;
      try { editor.moveBuilderSegment(draggedId, plan); } catch (error) { host.fail?.(error); }
    },
    onSelect: (entry, options = {}) => {
      const uid = session?.preferredUid;
      if (uid == null) return;
      if (options.polygon) {editor.selectPolygon(uid,entry.index);return;}
      if (options.shift) editor.toggleSegment(uid, entry);
      else editor.select(uid, entry);
    },
    onBranch: index => { const uid = session?.preferredUid; if (uid != null) editor.selectBranch(uid, index); },
    onMenu: (entry, x, y) => showContextMenu({entry, x, y, tree: true}),
    onRename: name => { try { editor.updateFigureStyle({name}); } catch (error) { host.fail?.(error); } },
  });
  const timelineToggle = outlinerHost.querySelector('#builder-timeline-toggle');
  // Build hides the timeline by default; the shell's layout for Build shows it
  // (host.toggleTimeline) and writes .workspace[data-builder-timeline].
  const timelineVisible = () => workspace.dataset.builderTimeline === 'visible';
  function syncTimelineToggle() {
    if (!timelineToggle) return;
    timelineToggle.setAttribute('aria-expanded', String(timelineVisible()));
    localizedAttribute(timelineToggle, "title", (timelineVisible() ? "builderMode.hideAnimationTimeline" : "builderMode.showAnimationTimeline"), (timelineVisible() ? {} : {}));
  }
  function showContextMenu({hit, entry, x, y, tree = false}) {
    if (!session) return;
    host.pause?.(); host.finishCurrentEdit?.();
    const boundHit = hit && session.boundUids.has(hit.g.obj.unique_id);
    const uid = boundHit ? hit.g.obj.unique_id : session.preferredUid;
    const joint = tree && entry?.kind === 'segment' ? entry.index : boundHit ? hit.joint : -1;
    if ((joint >= 0 || boundHit) && (editor.selectedUid !== uid || editor.selectedJoint !== joint)) editor.select(uid, joint);
    if (entry?.kind === 'polygon') editor.selectPolygon(uid,entry.index);
    const kind = entry?.kind === 'polygon' ? 'polygon' : joint >= 0 ? 'joint' : boundHit ? 'figure' : 'canvas';
    context = {kind, uid, jointId: session.figure?.segments[joint]?.segment_id,
      polygon: kind === 'polygon' ? session.figure?.polyfills?.[entry.index] : null,
      // Focus returns to the invoker when the menu closes.
      anchor: {left: x, bottom: y, invoker: tree ? outliner.tree : document.getElementById('viewport')}};
    showContextPage('main');
  }
  function showContextPage(page) {
    if (!session || !context) return;
    const part = context.kind === 'joint' ? session.figure?.segments.find(segment => segment.segment_id === context.jointId) : null;
    host.showCommandMenu?.(builderContextItems({kind: context.kind, page, name: part ? partName(part) : '',
      hasFigure: Boolean(session.figure), state: {...state, builderBranchSelected: editor.branchSelected, builderTimelineVisible: timelineVisible()}}), context.anchor);
  }
  function runContextCommand(name) {
    if (!session || !context) return;
    const page = name.slice('builder-context-'.length);
    if (['main', 'branch', 'arrange', 'view'].includes(page)) return showContextPage(page);
    if (page.startsWith('tool-')) return host.setTool(page.slice(5));
    if (page === 'timeline') return timelineToggle?.click();
    const figure = session.figure;
    if (!figure) return;
    if (page.includes('fill')) {
      const index = figure.polyfills?.indexOf(context.polygon) ?? -1;
      if (index < 0) return;
      if (page === 'delete-fill') return editor.removePolygon(index);
      if (page === 'fill-front' || page === 'fill-back') return editor.moveBuilderOrder({kind: 'polygon', index}, page === 'fill-front' ? 'front' : 'back');
    }
    const joint = figure.segments.findIndex(segment => segment.segment_id === context.jointId);
    if (joint < 0 || !session.boundUids.has(context.uid)) return;
    if (page === 'select-branch') return editor.selectBranch(context.uid, joint);
    if (page === 'split-branch') { editor.select(context.uid, joint); return editor.splitBuilderSegments({branch: true, fraction: .5}); }
  }
  /** Selection may only contain bound instances; an empty selection reselects
   * the preferred instance so builder commands always have a figure. */
  function enforceSelection() {
    if (!session || session.stale) return;
    const bound = session.boundUids;
    if (editor._branchSelection && bound.has(editor._branchSelection.uid)) return;
    const selected = [...editor.selectedUids];
    if (selected.every(uid => bound.has(uid))) {
      if (!selected.length && bound.size) editor.select(session.preferredUid);
      return;
    }
    const keep = selected.filter(uid => bound.has(uid));
    if (keep.length) editor.selectMany(keep);
    else if (bound.size) editor.select(session.preferredUid);
    else if (selected.length || editor.selectedUid !== null) editor.select(null);
  }
  function onEditorChange() {
    if (!session || resolving) return;
    session.sync();
    if (session.stale) { leave(); return; }
    // Keep a bound instance on the current frame: the figure under
    // construction is always editable, even on frames where it is absent.
    if (session.typeId !== null && session.figure && !session.boundUids.size && !editor.dragging) {
      try { editor.addFigure(session.typeId); } catch { /* stays unbound */ return; }
      return;
    }
    enforceSelection();
    outliner.update(session);
    if (session.mode === 'create' && session.figure && state.inspectorContext === 'scene') {
      state.inspectorContext = 'figure';
      host.queueUI?.();
    }
    sync();
  }
  /** Structure's Timeline toggle follows the shell (the part commands' states come from the command registry). */
  function sync() {
    if (!session) return;
    syncTimelineToggle();
  }
  function enter() {
    if (session) return true;
    host.pause?.(); host.finishCurrentEdit?.(); host.cancelDrag?.(); host.cancelPolygonDraft?.();
    const insertDialog = document.getElementById('insert-dialog');
    if (insertDialog?.open) insertDialog.close();
    session = new BuilderSession(editor).begin();
    state.selectedTrackId = editor.activeLayerId;
    session.entryTool = state.tool;
    events = new AbortController();
    timelineToggle?.addEventListener('click', () => {
      host.toggleTimeline?.();
      syncTimelineToggle();
    }, {signal: events.signal});
    editor.addEventListener('change', onEditorChange, {signal: events.signal});
    workspace.dataset.mode = 'rig';
    state.builderActive = true;
    state.inspectorContext = session.mode === 'edit' ? 'figure' : 'scene';
    state.inspectorTab = 'design';
    host.setTool(session.figure ? 'rig' : 'line');
    onEditorChange();
    host.onModeChange?.();
    host.status?.(session.mode === 'edit'
      ? {messageKey:'builderMode.buildingFigure',messageParams:{name:session.figure?.name||{messageKey:'vfxInspector.figure'}}}
      : {messageKey:'builderMode.newFigureDrawALineOrCircleTo'});
    return true;
  }
  /** Ends the session after applying the exit choice to the document. */
  function leave() {
    host.cancelConstruction?.();
    events?.abort(); events = null;
    context = null;
    const entryTool = session?.entryTool;
    session = null;
    state.builderActive = false;
    state.spritePlacement = null;
    state.duplicatePlacement = null;
    outliner.update(null);
    workspace.dataset.mode = 'animate';
    host.setTool(entryTool && !ENTRY_TOOLS.has(entryTool) ? entryTool : 'select');
    host.onModeChange?.();
    host.queueUI?.();
  }
  /** An explicit action can keep the live construction and continue in Animate.
   * This preserves session commands and their undo history, including new rigs. */
  function keepChangesAndLeave() {
    if (!session) return;
    host.finishCurrentEdit?.();
    if (!session.stale) session.resolve(session.mode === 'edit' ? 'update' : 'import');
    leave();
  }
  /** Animate button while building: silent exit when nothing changed, else the
   * update / import-new / discard or import / discard confirmation modal. */
  function requestExit() {
    if (!session) return;
    if (session.stale) return leave();
    host.finishCurrentEdit?.();
    if (!session.changed) { session.resolve(session.mode === 'edit' ? 'update' : 'import'); return leave(); }
    if (document.querySelector('#dialog')?.open) host.closeDialog?.();
    const edit = session.mode === 'edit', name = session.figure?.name || {messageKey:'vfxInspector.figure'};
    host.showDialog(edit ? interfaceText("builderMode.keepChangesTo", {name}) : interfaceText("builderMode.addTheNewFigureToTheScene"),
      `<div class="builder-exit-options">${edit ? `<button class="builder-exit-option primary" id="builder-exit-update">${icon('check')}<span><strong data-i18n="builderMode.updateFigure">${messageHTML("builderMode.updateFigure", {})}</strong><small>${messageHTML("builderMode.applyTheChangesEveryInstanceOfInThe", {name})}</small></span></button>
        <button class="builder-exit-option" id="builder-exit-import-new">${icon('duplicate')}<span><strong data-i18n="builderMode.importAsNewFigure">${messageHTML("builderMode.importAsNewFigure", {})}</strong><small>${messageHTML("builderMode.keepUnchangedAndAddTheEditedFigureTo", {name})}</small></span></button>`
        : `<button class="builder-exit-option primary" id="builder-exit-import">${icon('check')}<span><strong data-i18n="builderMode.importIntoScene">${messageHTML("builderMode.importIntoScene", {})}</strong><small data-i18n="builderMode.addTheFigureToTheCurrentFrame">${messageHTML("builderMode.addTheFigureToTheCurrentFrame", {})}</small></span></button>`}
        <button class="builder-exit-option" id="builder-exit-discard">${icon('reset')}<span><strong data-i18n="common.discardChanges">${messageHTML("builderMode.discardChanges", {})}</strong><small data-i18n="builderMode.undoEverythingDoneInTheBuilder">${messageHTML("builderMode.undoEverythingDoneInTheBuilder", {})}</small></span></button>
      </div><div class="dialog-actions"><button type="button" class="ui-button" data-variant="ghost" id="builder-exit-cancel" data-i18n="common.keepEditing">${messageHTML("builderMode.keepEditing", {})}</button></div>`, {titleKey: edit ? "builderMode.keepChangesTo" : "builderMode.addTheNewFigureToTheScene", titleParams: {name}});
    const choose = choice => {
      let imported;
      try {
        // Undo/import emits changes synchronously. Selection confinement and
        // auto-insertion belong to live editing, not the exit transaction.
        resolving = true;
        host.cancelPolygonDraft?.();
        imported = session.resolve(choice);
      } catch (error) { host.fail?.(error); return; }
      finally { resolving = false; }
      host.closeDialog?.();
      leave();
      if (imported) editor.select(imported.unique_id);
      host.status?.({messageKey:choice === 'discard' ? "builderMode.builderChangesDiscarded"
        : choice === 'import-new' ? "builderMode.importedAsANewFigure" : "builderMode.figureUpdated"});
    };
    document.getElementById('builder-exit-update')?.addEventListener('click', () => choose('update'));
    document.getElementById('builder-exit-import-new')?.addEventListener('click', () => choose('import-new'));
    document.getElementById('builder-exit-import')?.addEventListener('click', () => choose('import'));
    document.getElementById('builder-exit-discard')?.addEventListener('click', () => choose('discard'));
    document.getElementById('builder-exit-cancel')?.addEventListener('click', () => host.closeDialog?.());
  }
  return {
    enter, requestExit, leave, keepChangesAndLeave, sync, showContextMenu, runContextCommand,
    get active() { return Boolean(session); },
    get session() { return session; },
    get boundUids() { return session?.boundUids ?? null; },
    get mode() { return session ? 'rig' : 'animate'; },
  };
}
