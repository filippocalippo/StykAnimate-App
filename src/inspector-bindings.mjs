import {t as interfaceText} from './localization.mjs';
import {messageError} from './localized-error.mjs';
/**
 * What a changed control in #inspector does (architecture.md §3.13): an
 * ordered, declarative map from a control's selector to the handler that
 * applies its value through the editor's commands.
 *
 * The first binding whose selector matches the changed control handles the
 * change. A handler that returns `false` passes it on to the next match (a
 * control that only means something in Build, say). `*` matches any control:
 * the rig controls (rig-controls.mjs) claim theirs by id. Controls with their
 * own owners keep their own handling: property scrubbing (property-controls),
 * the movieclip fields (movieclip-ui), the drawing and camera widgets.
 *
 * DOM-free at import. installInspectorBindings() is the thin DOM half: one
 * `change` listener on the inspector's root, installed once.
 *
 * ctx (from app.mjs): {editor, state, telemetry, guarded, pause,
 * finishCurrentEdit, queueUI, requestRender, fit, changeFigureLayer,
 * timeline(), builderActive(), usesBuilderBranch(event),
 * updateBuilderStyle(patch, event), rangeFrames(), selectionBounds(),
 * moveSelected(dx, dy), updateSelection(patch), showDialog, closeDialog}.
 */
import {rigControlChange} from './rig-controls.mjs';
import {installInspectorChrome} from './inspector-header.mjs';
import {changeSurfaceSide} from './builder-surface-ui.mjs';
import {layerIdForUid} from './layers.mjs';
import {shortest} from './pivot/read-view.mjs';

/** The handlers in the order they are tried. Each is [selector, (target, event) => false | anything]. */
export function inspectorBindings(ctx) {
  const {editor, state} = ctx;
  const layerId = (target) => target.dataset.layerId || editor.activeLayerId;
  return [
    ['#figure-layer', async (target) => {
      ctx.finishCurrentEdit();const id=target.value,uids=[...editor.selectedUids];
      const changed=await ctx.changeFigureLayer(interfaceText('inspectorView.moveFiguresToLayer'),options=>editor.assignFiguresToLayerAsync(uids,id,options), {labelKey:'inspectorView.moveFiguresToLayer'});
      if(changed){editor.setActiveLayer(id);state.selectedTrackId=id;ctx.timeline()?.selectTrack?.(id);}ctx.queueUI();ctx.requestRender();
    }],
    ['#builder-branch', (target) => {
      state.builderBranch = target.checked;
      if (!target.checked && editor.branchSelected) {
        const uid = editor.selectedUid, joint = editor.selectedJoint;
        editor._branchSelection = null; editor.select(uid, joint);
      }
      if (target.checked && editor.selectedUid != null) {
        state.selectedTrackId = layerIdForUid(
          editor.report,
          editor.selectedUid,
        );
        state.inspectorContext = "figure";
        state.inspectorTab = "design";
      }
      ctx.queueUI();
      ctx.requestRender();
    }],
    ['#inspector-layer-name', (target) => { editor.renameLayer(layerId(target), target.value); }],
    ['#inspector-layer-visible', (target) => { editor.setLayerVisible(layerId(target), target.checked); }],
    ['#inspector-layer-locked', (target) => { editor.setLayerLocked(layerId(target), target.checked); }],
    ['#rig-mode', (target) => { state.rigMode = target.value; }],
    ['*', (target) => rigControlChange(editor, target) || false],
    ['[data-polygon-side]', (target) => {
      if (!ctx.builderActive()) return false;
      const index=Number(target.dataset.polygonSide),side=target.value;target.value=editor.figure.polyfills[index]._stykSurface?.side??(editor.figure.polyfills[index]._stykSurface?'front':'both');
      changeSurfaceSide(editor,index,side,{showDialog:ctx.showDialog,closeDialog:ctx.closeDialog});
    }],
    ['#node-is-ik', (target) => { editor.setNodeIK({enabled: target.checked}); }],
    ['#node-ik-pinned', (target) => { ctx.telemetry.count('ik'); editor.setNodeIK({pinned: target.checked}); }],
    ['#node-ik-chain', (target) => { editor.setNodeIK({chainLength: target.valueAsNumber}); }],
    ['#node-ik-rotation', (target) => { editor.rotateIKTarget(target.valueAsNumber * Math.PI / 180); }],
    ['#node-ik-stretch', (target) => { editor.setNodeIK({allowStretch: target.checked}); }],
    ['[name="node-ik-bend"]', (target) => { editor.setNodeIK({bendDirection: Number(target.value)}); }],
    // The checkbox mirrors the timeline header's Edit selected frames (toggle-range-edit).
    ['#apply-range-movement', (target) => { state.applyRange = target.checked; ctx.queueUI(); }],
    ['#figure-name', (target) => { editor.updateFigureStyle({ name: target.value }); }],
    ['#builder-joint-name', (target) => {
      if (!ctx.builderActive()) return false;
      editor.updateSegment({name:target.value.trim().slice(0,120)});
    }],
    ['#segment-gradient-enabled', (target, event) => {
      ctx.updateBuilderStyle({ gradient: target.checked ? { color: "#ffffff" } : null }, event);
    }],
    ['#segment-gradient-color', (target, event) => { ctx.updateBuilderStyle({ gradient: { color: target.value } }, event); }],
    ['#segment-shape', (target, event) => {
      if (ctx.usesBuilderBranch(event) && ["line", "squareLine"].includes(target.value))
        editor.setBranchCaps(target.value === "squareLine");
      else if (
        ctx.usesBuilderBranch(event) &&
        [1, 3, 4].includes(
          editor.figure?.segments[editor.selectedJoint]?.primitive_code,
        )
      )
        editor.setBranchFill(target.value);
      else editor.convertSegment(target.value);
    }],
    ['#segment-color', (target, event) => { ctx.updateBuilderStyle({ color: target.value }, event); }],
    ['#segment-opacity', (target, event) => { ctx.updateBuilderStyle({ opacity: Number(target.value) / 100 }, event); }],
    ['[data-polygon-color]', (target) => {
      editor.updatePolygon(Number(target.dataset.polygonColor), {
        color: target.value,
      });
    }],
    ['[data-field]', (target, event) => {
      const key = target.dataset.field;
      if (!key) return false;
      return fieldChange(ctx, key, target, event);
    }],
    ['#figure-color', (target) => { editor.setFigureColor(target.value,{indices:ctx.rangeFrames()}); }],
    ['#figure-opacity', (target) => {
      ctx.updateSelection({
        field28: Math.round(
          (1 - Math.max(0, Math.min(100, Number(target.value))) / 100) * 255,
        ),
      });
    }],
    ['#static-joint', (target, event) => { ctx.updateBuilderStyle({ static: target.checked }, event); }],
    ['#background-color', (target) => {
      const raw = (0xff000000 | parseInt(target.value.slice(1), 16)) >>> 0;
      editor.setSceneColor(raw, { indices: ctx.rangeFrames() });
    }],
    ['#join-target', (target) => {
      if (ctx.rangeFrames()) {
        if (target.value)
          editor.joinFiguresInFrames(Number(target.value), 0, ctx.rangeFrames());
        else editor.detachFiguresInFrames(ctx.rangeFrames());
      } else {
        editor.joinFigure(target.value ? Number(target.value) : null, 0);
      }
    }],
  ];
}

/** A numeric field (`data-field`) the property controls do not take: the scene, the selection, the figure or the joint. The camera's
 * fields (`camera_*`) are always the property controls' (`propertyChannel` in app.mjs answers for them), and no view renders a
 * field for the parent joint an attachment hangs from. */
function fieldChange(ctx, key, target, event) {
  const {editor} = ctx;
  const value = Number(target.value);
  if (!Number.isFinite(value)) throw messageError(new Error(''), "errors.inspectorBindings.enterAFiniteNumber", {});
  if (key === "fps") editor.setFPS(value);
  else if (key === "duration") editor.setFrameDuration(value);
  else if (key.startsWith("group_")) {
    const b = ctx.selectionBounds();
    if (key === "group_x") ctx.moveSelected(value - b.minX, 0);
    else if (key === "group_y") ctx.moveSelected(0, value - b.minY);
    else {
      const old = key === "group_width" ? b.maxX - b.minX : b.maxY - b.minY;
      if (value <= 0 || old <= 0)
        throw messageError(new Error(''), "errors.inspectorBindings.selectionSizeMustBeGreaterThanZero", {});
      editor.scaleSelection(value / old);
    }
  } else if (key === "rotation")
    editor.rotateFigure(
      shortest(
        (value * Math.PI) / 180 -
          ((editor.object.angles[0] ?? 0) -
            (editor.figure.segments[0]?.angle_rad ?? 0)),
      ),
    );
  else if (key === "scale") editor.updateObject({ scale: value / 100 });
  else if (["root_x", "root_y"].includes(key)) {
    if (ctx.rangeFrames())
      ctx.moveSelected(
        key === "root_x" ? value - editor.object.root_x : 0,
        key === "root_y" ? value - editor.object.root_y : 0,
      );
    else editor.updateObject({ [key]: value });
  } else if (key === "thickness")
    ctx.updateBuilderStyle({ thickness: value }, event);
  else if (key === "joint_angle") {
    const angle = (value * Math.PI) / 180,
      obj = editor.object,
      delta = shortest(angle - obj.angles[editor.selectedJoint]);
    editor.rotateJoint(delta);
  } else if (key === "joint_length" || key === "joint_bend") {
    editor.updateSegment(
      key === "joint_length"
        ? { length: value }
        : { bend_rad: (value * Math.PI) / 180 },
    );
  } else if (key === "canvas_width" || key === "canvas_height") {
    if (value < 1 || value > 16384 || !Number.isInteger(value))
      throw messageError(new Error(''), "errors.inspectorBindings.canvasDimensionsMustBeWholePixelsBetween1", {});
    editor.updateProject({ [key]: value });
    ctx.fit();
  }
}

/**
 * Runs the first binding that takes `event`'s control. Playback pauses before
 * any change applies. Returns the handler's result (a promise for an async one).
 */
export function applyInspectorChange(bindings, event, {pause} = {}) {
  const target = event.target;
  pause?.();
  for (const [selector, handler] of bindings) {
    if (selector !== '*' && !target.matches?.(selector)) continue;
    const result = handler(target, event);
    if (result !== false) return result;
  }
  return undefined;
}

/**
 * Listens for changes in the inspector's root (#inspector) and its header's
 * target line (where the name is renamed in place), and installs the
 * Properties panel's header and kit (inspector-header.mjs). Returns a
 * function that removes them.
 */
export function installInspectorBindings(root, ctx) {
  const bindings = inspectorBindings(ctx);
  const listener = ctx.guarded(async (event) => applyInspectorChange(bindings, event, {pause: ctx.pause}));
  const chrome = installInspectorChrome(root, ctx);
  const target = chrome.header?.element;
  root.addEventListener('change', listener);
  target?.addEventListener('change', listener);
  return () => {
    root.removeEventListener('change', listener);
    target?.removeEventListener('change', listener);
    chrome.destroy();
  };
}
