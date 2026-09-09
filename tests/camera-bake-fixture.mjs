import { emptyDocument, createFrame, createObject } from "../src/demo.mjs";
import { createLayerState } from "../src/layers.mjs";
import { animationChannelId } from "../src/animation-channels.mjs";
import {
  timeline,
  evaluatedFrame,
  buildGeometry,
} from "../src/pivot/geometry.mjs";
import { cameraMatrix } from "../src/renderer-geometry.mjs";

export const channel = (target, property, entries) => ({
  id: animationChannelId(target, property),
  target,
  property,
  source: "authored",
  retained_metadata: { token: property },
  keys: entries.map(
    ([tick, value, interpolation = "linear", passthrough], i) => ({
      id: `source-${i}`,
      tick,
      value: property === "pose" ? { frameId: value } : value,
      interpolation,
      ...(passthrough ? { passthrough: true } : {}),
    }),
  ),
});

export function cameraBakeFixture({ scalar = true, poses = true } = {}) {
  const report = emptyDocument(),
    figure = report.figure_types[0];
  report.canvas_width = 600;
  report.canvas_height = 340;
  report.auto_easing = true;
  report.auto_easing_disabled_raw = 0;
  figure.segments[2].bend_rad = 0.35;
  report._styk.layers = {
    ...createLayerState(),
    nextId: 4,
    order: ["layer-1", "layer-2", "layer-3"],
    byId: Object.fromEntries(
      [1, 2, 3].map((id) => [
        `layer-${id}`,
        { name: `Part ${id}`, visible: true, locked: false },
      ]),
    ),
    assignments: { 2: "layer-2", 3: "layer-3" },
  };
  report.keyframes = [0, 1, 2].map((i) => {
    const parent = createObject(figure, 1, 180 + i * 45, 145 + i * 8, {
      scale: 0.45 + i * 0.03,
    });
    const child = createObject(figure, 2, 0, 0, { scale: 0.27 + i * 0.015 });
    const grandchild = createObject(figure, 3, 0, 0, {
      scale: 0.18 - i * 0.02,
    });
    const independent = createObject(figure, 4, 430 - i * 35, 150 + i * 6, {
      scale: 0.4,
    });
    for (const object of [parent, child, grandchild, independent]) {
      object.angles = object.angles.map(
        (angle, j) => angle + 0.2 * i + Math.sin(j + i) * 0.13,
      );
      object.len_flag = 1;
      object.lengths = figure.segments.map(
        (segment, j) => segment.length * (1 + Math.cos(j + i) * 0.06),
      );
      object.bend_flag = 1;
      object.bends = figure.segments.map(
        (segment, j) => segment.bend_rad + Math.sin(j + i) * 0.1,
      );
      object.opaque_pose = { native: object.unique_id * 100 + i };
    }
    const objects = [
      [grandchild, independent, parent, child],
      [child, grandchild, parent, independent],
      [independent, grandchild, child, parent],
    ][i];
    const slots = new Map(
      objects.map((object, slot) => [object.unique_id, slot]),
    );
    child.join = {
      target_object_slot: slots.get(1),
      target_unique_id: 1,
      target_handle_id: 4,
    };
    grandchild.join = {
      target_object_slot: slots.get(2),
      target_unique_id: 2,
      target_handle_id: 8,
    };
    return {
      ...createFrame(objects, 8),
      _styk: { frameId: `frame-${i + 1}` },
      opaque_frame: { native: i },
      camera: {
        is_default: false,
        x: 18 - i * 12,
        y: -7 + i * 4,
        scale: 0.85 + i * 0.16,
        angle_rad: 0.15 - i * 0.12,
      },
    };
  });
  report._styk.frameSources = {
    "source-retained": {
      ...structuredClone(report.keyframes[2]),
      _styk: { frameId: "source-retained" },
      source_extra: { untouched: true },
    },
  };
  const channels = [];
  if (poses)
    channels.push(
      channel({ kind: "layer", id: "layer-1" }, "pose", [
        [0, "frame-1"],
        [14, "frame-3"],
        [23, "frame-2"],
      ]),
      channel({ kind: "layer", id: "layer-2" }, "pose", [
        [0, "frame-3"],
        [9, "frame-1"],
        [23, "frame-2"],
      ]),
      channel({ kind: "layer", id: "layer-3" }, "pose", [
        [0, "frame-2"],
        [16, "frame-3"],
        [23, "frame-1"],
      ]),
      channel({ kind: "camera" }, "pose", [
        [0, "source-retained"],
        [13, "frame-1"],
        [23, "frame-2"],
      ]),
    );
  if (scalar)
    channels.push(
      channel({ kind: "figure", uid: 1 }, "x", [
        [0, 230],
        [23, 255],
      ]),
      channel({ kind: "figure", uid: 2 }, "y", [
        [7, 165],
        [18, 135, "hold"],
        [23, 170],
      ]),
      channel({ kind: "figure", uid: 2 }, "rotation", [
        [0, 0.2],
        [23, -0.25],
      ]),
      channel({ kind: "figure", uid: 3 }, "scale", [
        [0, 0.19, "hold"],
        [11, 0.24],
        [23, 0.14],
      ]),
      channel({ kind: "figure", uid: 4 }, "x", [
        [0, 390],
        [12, 0, "linear", true],
        [19, 420],
        [23, 400],
      ]),
      channel({ kind: "figure", uid: 4 }, "opacity", [
        [0, 0.8],
        [23, 0.45],
      ]),
      channel({ kind: "camera" }, "x", [
        [0, 12],
        [23, 38],
      ]),
      channel({ kind: "camera" }, "rotation", [
        [6, 0.23],
        [23, -0.14],
      ]),
      channel({ kind: "scene" }, "color", [[0, 0xffffffff, "hold"]]),
    );
  report._styk.animation = {
    version: 1,
    nextKeyId: 100,
    retained_metadata: { token: "animation" },
    channels,
  };
  return report;
}

export function sampleCameraBake(report, tick) {
  const rows = timeline(report);
  let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(
    report,
    index,
    rows[index].count ? (tick - rows[index].start) / rows[index].count : 0,
    tick,
  );
}

export function projectedCameraBake(report, tick) {
  const frame = sampleCameraBake(report, tick),
    geometry = buildGeometry(report, frame),
    matrix = cameraMatrix({ report, frame });
  const point = (value) => ({
    x: matrix[0] * value.x + matrix[2] * value.y + matrix[4],
    y: matrix[1] * value.x + matrix[3] * value.y + matrix[5],
  });
  return new Map(
    [...geometry.objects.values()].map((entry) => [
      entry.obj.unique_id,
      {
        root: point(entry.root),
        joints: [...entry.joints].map(([id, value]) => [id, point(value)]),
        segments: entry.segments.map((segment) => ({
          start: point(segment.start),
          end: point(segment.end),
          points: segment.points.map(point),
          thickness: segment.thickness * Math.hypot(matrix[0], matrix[1]),
          opacity: segment.opacity,
          rgb: segment.rgb,
        })),
      },
    ]),
  );
}
