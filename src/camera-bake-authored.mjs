import {assignKeyEasing, keyEasing, easingMode, autoKeyRange} from './keyframe-easing.mjs';
/** Apply the camera at selected display ticks using sparse affine property keys.
 * Native pose curves remain untouched, so their easing/topology is not resampled.
 */
import {
  animationChannelId,
  sampleAnimationChannel,
  validateAnimationDocument,
  validateAnimationValue,
} from "./animation-channels.mjs";
import { evaluatedFrame, buildGeometry } from "./pivot/geometry.mjs";
import { cameraMatrix } from "./renderer-geometry.mjs";
import {
  cameraIsIdentity,
  inverseCameraScale,
  effectiveCamera,
} from "./pivot/background.mjs";
import { validateObjectChanges } from "./pivot/model.mjs";

function frameAt(editor, tick, report = editor.report) {
  const rows = editor.timeline;
  let low = 0,
    high = rows.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (rows[mid].start <= tick) low = mid;
    else high = mid - 1;
  }
  const row = rows[low];
  return {
    index: low,
    frame: evaluatedFrame(
      report,
      low,
      row.count > 0 ? Math.min(1, (tick - row.start) / row.count) : 0,
      tick,
    ),
  };
}
function previousKey(channel, tick) {
  const keys = channel?.keys;
  if (!keys?.length || keys[0].tick > tick) return null;
  let low = 0,
    high = keys.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (keys[mid].tick <= tick) low = mid;
    else high = mid - 1;
  }
  return keys[low];
}

/** Before/after guards retain existing values at every unedited
 * integer tick. Passthrough returns an absent scalar to its original pose track.
 */
function guardedChannels(before, points, endTick) {
  const after = {
    ...before,
    version: 1,
    nextKeyId: before?.nextKeyId ?? 1,
    channels: [...(before?.channels ?? [])],
  };
  const indices = new Map(
    after.channels.map((channel, index) => [channel.id, index]),
  );
  for (const [id, entry] of points) {
    const index = indices.get(id),
      original = index === undefined ? null : after.channels[index];
    const channel = {
      ...original,
      id,
      target: entry.target,
      property: entry.property,
      source: "authored",
      keys: (original?.keys ?? []).map((key) => ({ ...key })),
    };
    const byTick = new Map(channel.keys.map((key) => [key.tick, key])),
      ids = new Set(channel.keys.map((key) => key.id));
    const put = (
      tick,
      value,
      { passthrough = false, interpolation = "linear", bezier } = {},
    ) => {
      value = validateAnimationValue(entry.target, entry.property, value);
      let key = byTick.get(tick);
      if (!key) {
        let identity;
        do {
          if (!Number.isSafeInteger(after.nextKeyId) || after.nextKeyId < 1)
            throw new Error("Animation key identity capacity exceeded.");
          identity = `key-${after.nextKeyId++}`;
        } while (ids.has(identity));
        ids.add(identity);
        key = { id: identity, tick };
        channel.keys.push(key);
        byTick.set(tick, key);
      }
      key.value = value;
      assignKeyEasing(key, {interpolation, ...(interpolation === "bezier" ? {bezier} : {})});
      if (passthrough) key.passthrough = true;
      else delete key.passthrough;
    };
    const guards = new Set();
    for (const tick of entry.values.keys())
      for (const neighbor of [tick - 1, tick + 1])
        if (neighbor >= 0 && neighbor < endTick && !entry.values.has(neighbor))
          guards.add(neighbor);
    // Splitting a nonlinear curve at a guard would change every other sample
    // in that span. Retain its unedited integer samples explicitly when baking.
    const sampledGuards = new Set(), sampledSpans = new Set(), affected = new Set([...guards, ...entry.values.keys()]);
    const keyIndices = new Map(original?.keys.map((key, index) => [key, index]));
    for (const tick of affected) {
      const left = previousKey(original, tick);
      if (!left) continue;
      const index = keyIndices.get(left);
      if (!['auto', 'bezier', 'ease-in', 'ease-out'].includes(easingMode(left)) && easingMode(original.keys[index - 1]) !== 'auto') continue;
      const right = original.keys[index + 1];
      if (!right) continue;
      const [start, end] = autoKeyRange(original.keys, index, index + 1);
      const startTick = original.keys[start].tick, endTick = original.keys[end].tick;
      if (endTick - startTick > 10000) throw new Error('Split this easing span before baking the camera; at most 10,000 guard samples are supported.');
      if (sampledSpans.has(startTick)) continue;
      sampledSpans.add(startTick);
      for (let sample = startTick; sample < endTick; sample++) if (!entry.values.has(sample)) {
        sampledGuards.add(sample); guards.add(sample);
      }
      if (guards.size > 10000) throw new Error('Bake a smaller camera range; at most 10,000 guard samples are supported.');
    }
    for (const tick of guards) {
      const value = sampleAnimationChannel(original, tick),
        key = previousKey(original, tick);
      put(tick, value ?? (entry.property === "scale" ? 1 : 0), {
        passthrough: value === undefined,
        ...keyEasing(sampledGuards.has(tick) ? {interpolation: "constant"} : key),
      });
    }
    for (const [tick, value] of entry.values)
      put(tick, value, { interpolation: "hold" });
    channel.keys.sort((a, b) => a.tick - b.tick);
    if (index === undefined) {
      indices.set(id, after.channels.length);
      after.channels.push(channel);
    } else after.channels[index] = channel;
  }
  return after;
}

export function applyAuthoredCameraToFigures(editor, indices, { ticks } = {}) {
  const selected = editor._frameIndices(indices);
  const times = [
    ...new Set(
      ticks ??
        selected.map((index) =>
          selected.length === 1 && index === editor.frameIndex
            ? editor.tick
            : editor.timeline[index].start,
        ),
    ),
  ].sort((a, b) => a - b);
  const endTick = editor.totalTicks;
  if (
    times.some((tick) => !Number.isInteger(tick) || tick < 0 || tick >= endTick)
  )
    throw new Error("Choose whole display frames inside this animation.");
  const points = new Map(),
    changedTicks = [],
    changedFrames = new Set(),
    changedUids = new Set();
  const types = new Map(
    editor.report.figure_types.map((figure) => [figure.figure_type_id, figure]),
  );
  const put = (target, property, tick, value) => {
    const id = animationChannelId(target, property);
    let entry = points.get(id);
    if (!entry) {
      entry = { target, property, values: new Map() };
      points.set(id, entry);
    }
    entry.values.set(tick, validateAnimationValue(target, property, value));
  };
  // Read all composed values before publishing any key. Each figure receives
  // the same affine transform, including connected members in arbitrary slots.
  for (const tick of times) {
    const { index, frame } = frameAt(editor, tick),
      camera = effectiveCamera(editor.report, frame);
    if (cameraIsIdentity(camera)) continue;
    const matrix = cameraMatrix({ report: editor.report, frame }),
      scale = inverseCameraScale(camera),
      angle = Number(camera?.angle_rad ?? 0);
    const geometry = buildGeometry(editor.report, frame);
    for (const object of frame.objects) {
      const target = { kind: "figure", uid: object.unique_id },
        root = geometry.objects.get(object.object_slot)?.root ?? {
          x: object.root_x,
          y: object.root_y,
        };
      put(
        target,
        "x",
        tick,
        matrix[0] * root.x + matrix[2] * root.y + matrix[4],
      );
      put(
        target,
        "y",
        tick,
        matrix[1] * root.x + matrix[3] * root.y + matrix[5],
      );
      put(target, "scale", tick, object.scale * scale);
      const baseAngle = Number(
        types.get(object.figure_type_id)?.segments[0]?.angle_rad ?? 0,
      );
      put(
        target,
        "rotation",
        tick,
        Number(object.angles?.[0] ?? 0) - baseAngle - angle,
      );
      changedUids.add(object.unique_id);
    }
    for (const property of ["x", "y", "scale", "rotation"])
      put({ kind: "camera" }, property, tick, property === "scale" ? 1 : 0);
    changedTicks.push(tick);
    changedFrames.add(index);
  }
  if (!changedTicks.length) return 0;
  const before = editor.report._styk?.animation ?? null,
    after = guardedChannels(before, points, endTick);
  const candidate = {
    ...editor.report,
    _styk: { ...editor.report._styk, animation: after },
  };
  validateAnimationDocument(candidate);
  for (const tick of changedTicks) {
    const { frame } = frameAt(editor, tick, candidate);
    validateObjectChanges(
      candidate,
      frame,
      new Set(frame.objects.map((object) => object.unique_id)),
    );
  }
  const selection = editor._selectionState(),
    label = "Apply camera to figures";
  editor.report._styk ??= {};
  editor.report._styk.animation = after;
  editor._invalidate({ timing: true });
  editor._record({
    kind: "animation",
    label,
    before,
    after,
    beforeSelection: selection,
    afterSelection: editor._selectionState(),
    structural: false,
    timing: true,
  });
  editor._emit("edit", {
    label,
    animation: true,
    camera: true,
    timing: true,
    changedTicks,
    changedFrames: [...changedFrames],
    changedUids: [...changedUids],
  });
  return changedTicks.length;
}
