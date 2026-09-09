import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.mjs";
import { emptyDocument, createFrame, createObject } from "../src/demo.mjs";
import {
  canEditNativeProperty,
  getNativePropertyValue,
  beginNativePropertyEdit,
  previewNativePropertyEdit,
  commitNativePropertyEdit,
  cancelNativePropertyEdit,
  applyNativePropertyCommand,
} from "../src/native-property-edit.mjs";
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} !== ${b}`);
const blank = () => {
  const e = new Editor({ demo: false });
  e.addFigure();
  e.selectedJoint = 0;
  e._undo = [];
  e._redo = [];
  e._historySize = 0;
  e.markSaved();
  return e;
};
function gesture(editor, key, value) {
  const token = beginNativePropertyEdit(editor, key);
  previewNativePropertyEdit(token, value);
  commitNativePropertyEdit(token);
  return token;
}

test("all project native fields use one small patch undo and exact redo", () => {
  for (const [key, value] of [
    ["fps", 30],
    ["canvas_width", 1100],
    ["canvas_height", 700],
    ["duration", 8],
  ]) {
    const editor = blank(),
      before = getNativePropertyValue(editor, key),
      frame = editor.frame,
      objects = frame.objects,
      figure = editor.figure;
    const token = beginNativePropertyEdit(editor, key);
    for (let n = 1; n <= 80; n++)
      previewNativePropertyEdit(
        token,
        n === 80
          ? value
          : key === "duration"
            ? n + 1
            : key === "fps"
              ? n + 1
              : value + n,
      );
    assert.equal(editor._undo.length, 0);
    assert.equal(editor.frame, frame);
    assert.equal(editor.frame.objects, objects);
    assert.equal(editor.figure, figure);
    commitNativePropertyEdit(token);
    assert.equal(editor._undo.length, 1);
    assert.equal(editor._undo[0].kind, "native-properties");
    assert.ok(editor._undo[0].bytes < 3000);
    editor.undo();
    assert.equal(getNativePropertyValue(editor, key), before);
    editor.redo();
    assert.equal(getNativePropertyValue(editor, key), value);
  }
});

test("outline and segment style history never copies a figure or embedded media", () => {
  const editor = blank(),
    figure = editor.figure;
  figure.embedded_test_media = "M".repeat(2_000_000);
  for (const [key, value] of [
    ["outline_width", 7.125],
    ["thickness", 12.75],
    ["segment_opacity", 50],
  ]) {
    const before = structuredClone(figure),
      token = beginNativePropertyEdit(editor, key),
      count = editor._undo.length;
    for (let n = 0; n < 80; n++)
      previewNativePropertyEdit(token, value + n / 10);
    previewNativePropertyEdit(token, value);
    assert.equal(editor._undo.length, count);
    assert.equal(editor.figure, figure);
    commitNativePropertyEdit(token);
    assert.ok(editor._undo.at(-1).bytes < 3500);
    assert.equal(editor.figure.embedded_test_media, before.embedded_test_media);
    editor.undo();
    assert.ok(
      JSON.stringify(editor.figure) === JSON.stringify(before),
      "Exact figure undo including embedded media",
    );
    editor.redo();
    near(
      getNativePropertyValue(editor, key),
      key === "segment_opacity" ? (1 - 128 / 255) * 100 : value,
    );
  }
});

test("cancel and motionless gestures restore missing style parents, timing, clean state and history", () => {
  const editor = blank();
  delete editor.figure.segment_decode;
  const original = structuredClone(editor.report);
  for (const [key, value] of [
    ["outline_width", 20],
    ["fps", 40],
    ["duration", 30],
    ["canvas_width", 1000],
    ["thickness", 0],
  ]) {
    const token = beginNativePropertyEdit(editor, key);
    previewNativePropertyEdit(token, value);
    cancelNativePropertyEdit(token);
    assert.deepEqual(editor.report, original);
    assert.equal(editor._undo.length, 0);
    assert.equal(editor.dirty, false);
    assert.equal(cancelNativePropertyEdit(token), false);
  }
  const token = beginNativePropertyEdit(editor, "outline_width");
  assert.equal(commitNativePropertyEdit(token), false);
  assert.deepEqual(editor.report, original);
});

test("joint numeric edits capture only affected objects and form one pose undo", () => {
  for (const [key, value] of [
    ["joint_angle", 120.25],
    ["joint_length", 80.25],
    ["joint_bend", 40.125],
  ]) {
    const editor = blank(),
      before = structuredClone(editor.frame),
      other = editor.report.keyframes[1],
      count = editor._undo.length;
    const token = beginNativePropertyEdit(editor, key);
    for (let n = 0; n < 80; n++)
      previewNativePropertyEdit(token, value + n / 10);
    previewNativePropertyEdit(token, value);
    assert.equal(editor._undo.length, count);
    commitNativePropertyEdit(token);
    assert.equal(editor._undo.length, count + 1);
    assert.equal(editor._undo.at(-1).kind, "objects");
    near(getNativePropertyValue(editor, key), value);
    editor.undo();
    assert.deepEqual(editor.frame, before);
    assert.equal(editor.report.keyframes[1], other);
    editor.redo();
    near(getNativePropertyValue(editor, key), value);
  }
});

test("group translations and scaling are absolute from the starting snapshot", () => {
  for (const key of ["group_x", "group_y", "group_width", "group_height"]) {
    const editor = blank();
    editor.addFigure();
    editor.selectedUids = new Set(editor.frame.objects.map((o) => o.unique_id));
    editor._undo = [];
    editor._historySize = 0;
    const before = structuredClone(editor.frame),
      initial = getNativePropertyValue(editor, key),
      token = beginNativePropertyEdit(editor, key),
      value =
        initial + (key.endsWith("width") || key.endsWith("height") ? 80 : 120);
    for (let n = 0; n < 80; n++)
      previewNativePropertyEdit(token, value + n / 10);
    previewNativePropertyEdit(token, value);
    assert.equal(editor._undo.length, 0);
    commitNativePropertyEdit(token);
    const assertValue = () =>
      key === "group_width" || key === "group_height"
        ? near(editor.object.scale, value / initial)
        : near(getNativePropertyValue(editor, key), value);
    assertValue();
    assert.equal(editor._undo.length, 1);
    editor.undo();
    assert.deepEqual(editor.frame, before);
    editor.redo();
    assertValue();
  }
});

test("invalid finite/range/integer edits never partially mutate and cancellation stays exact", () => {
  for (const [key, value] of [
    ["fps", 1.5],
    ["fps", 0],
    ["duration", -1],
    ["duration", 65536],
    ["canvas_width", 16385],
    ["canvas_height", 2.4],
    ["outline_width", -1],
    ["thickness", Infinity],
    ["joint_length", -1],
    ["segment_opacity", 101],
  ]) {
    const editor = blank(),
      before = structuredClone(editor.report),
      token = beginNativePropertyEdit(editor, key);
    assert.throws(() => previewNativePropertyEdit(token, value));
    cancelNativePropertyEdit(token);
    assert.deepEqual(editor.report, before);
    assert.equal(editor._undo.length, 0);
  }
});

test("old Pivot FPS updates and undoes frame delay; property capability checks are contextual", () => {
  const editor = blank();
  editor.report.version = 4;
  editor.report.frame_delay_ms = 42;
  gesture(editor, "fps", 40);
  assert.equal(editor.report.frame_delay_ms, 25);
  editor.undo();
  assert.equal(editor.report.frame_delay_ms, 42);
  editor.selectedJoint = -1;
  assert.equal(canEditNativeProperty(editor, "joint_angle"), false);
  assert.equal(canEditNativeProperty(editor, "outline_width"), true);
  editor.select(null);
  assert.equal(canEditNativeProperty(editor, "outline_width"), false);
  assert.equal(canEditNativeProperty(editor, "duration"), true);
  assert.equal(canEditNativeProperty(editor, "root_x"), false);
});

test("small patch apply restores field absence without removing pre-existing metadata", () => {
  const editor = blank();
  editor.figure.segment_decode = { format: "native" };
  const token = beginNativePropertyEdit(editor, "outline_width");
  previewNativePropertyEdit(token, 3);
  commitNativePropertyEdit(token);
  const command = editor._undo.at(-1);
  applyNativePropertyCommand(editor, command, "before");
  assert.deepEqual(editor.figure.segment_decode, { format: "native" });
  applyNativePropertyCommand(editor, command, "after");
  assert.equal(editor.figure.segment_decode.global_style.outline_thickness, 3);
});

test("unkeyed figure and camera values edit the native pose without creating scalar channels", () => {
  for (const [key, value] of [
    ["root_x", 240],
    ["root_y", 190],
    ["scale", 125.5],
    ["rotation", 112.25],
    ["figure_opacity", 50],
    ["camera_x", 70],
    ["camera_y", 45],
    ["camera_scale", 145.25],
    ["camera_angle", 35.125],
  ]) {
    const editor = blank(),
      before = structuredClone(editor.report),
      token = beginNativePropertyEdit(editor, key);
    for (let n = 0; n < 40; n++)
      previewNativePropertyEdit(
        token,
        value + (key.includes("opacity") ? n / 100 : n / 10),
      );
    previewNativePropertyEdit(token, value);
    assert.equal(editor._undo.length, 0);
    commitNativePropertyEdit(token);
    near(
      getNativePropertyValue(editor, key),
      key === "figure_opacity" ? (1 - 128 / 255) * 100 : value,
    );
    assert.equal(editor.report._styk?.animation, undefined);
    assert.equal(editor._undo.length, 1);
    const after = structuredClone(editor.report);
    editor.undo();
    assert.deepEqual(editor.report, before);
    editor.redo();
    assert.deepEqual(editor.report, after);
    const cancel = beginNativePropertyEdit(editor, key);
    previewNativePropertyEdit(cancel, value + 1);
    cancelNativePropertyEdit(cancel);
    assert.deepEqual(editor.report, after);
  }
});

test("numeric fallback edits a composed-only figure through one authored layer pose", () => {
  const report = emptyDocument(),
    figure = report.figure_types[0];
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200)], 10),
    createFrame([createObject(figure, 2, 300, 200)], 10),
  ];
  const editor = new Editor({ demo: false }).load(report);
  editor.adoptNativePoseTrack({ kind: "layer", id: "layer-1" });
  const channel = editor.animationChannels[0];
  editor.setAnimationKey(channel.id, channel.keys[1].id, { tick: 5 });
  editor.seek(5);
  editor.select(2);
  const native = structuredClone(editor.report.keyframes),
    history = editor._undo.length;
  const token = beginNativePropertyEdit(editor, "root_x");
  assert.equal(token.initialValue, 300);
  for (let n = 0; n < 80; n++) previewNativePropertyEdit(token, 310 + n);
  assert.deepEqual(editor.report.keyframes, native);
  assert.equal(editor._undo.length, history);
  commitNativePropertyEdit(token);
  assert.equal(editor._undo.length, history + 1);
  assert.equal(editor.tick, 5);
  assert.equal(editor.object.root_x, 389);
  assert.equal(editor.animationChannel({ kind: "figure", uid: 2 }, "x"), null);
  assert.deepEqual(editor.report.keyframes, native);
  editor.undo();
  assert.equal(editor.object.root_x, 300);
  editor.redo();
  assert.equal(editor.object.root_x, 389);
  const cancel = beginNativePropertyEdit(editor, "root_y");
  previewNativePropertyEdit(cancel, 210);
  cancelNativePropertyEdit(cancel);
  assert.equal(editor.object.unique_id, 2);
  assert.equal(editor.object.root_y, 200);
  assert.equal(editor.tick, 5);
});

test("absolute ranges update only the requested value and matching figures in one undo", () => {
  for (const [key, value] of [
    ["root_x", 450],
    ["root_y", 160],
    ["scale", 150],
    ["rotation", 90],
    ["figure_opacity", 40],
    ["joint_angle", 45],
    ["joint_length", 100],
    ["joint_bend", 20],
  ]) {
    const report = emptyDocument(),
      figure = report.figure_types[0];
    report.keyframes = [0, 1, 2].map((i) => {
      const object = createObject(figure, 1, 100 + i * 70, 200 + i * 15);
      object.scale = 1 + i * 0.3;
      return createFrame([object, createObject(figure, 2, 50, 50)], 3);
    });
    const editor = new Editor({ demo: false }).load(report);
    editor.select(1, 0);
    const original = structuredClone(editor.report.keyframes),
      otherRefs = editor.report.keyframes.map((f) => f.objects[1]);
    const token = beginNativePropertyEdit(editor, key, {
      indices: [0, 2],
      rangeMode: "absolute",
    });
    for (let n = 0; n < 40; n++)
      previewNativePropertyEdit(token, value + n / 100);
    assert.deepEqual(editor.report.keyframes[2], original[2]);
    assert.equal(editor._undo.length, 0);
    previewNativePropertyEdit(token, value);
    commitNativePropertyEdit(token);
    assert.equal(editor._undo.length, 1);
    assert.equal(editor._undo[0].scope, "objects-range");
    assert.deepEqual(editor.report.keyframes[1], original[1]);
    for (const index of [0, 2]) {
      editor.selectFrame(index);
      editor.select(1, 0);
      near(
        getNativePropertyValue(editor, key),
        key === "figure_opacity" ? 40 : value,
      );
      assert.equal(editor.frame.objects[1], otherRefs[index]);
      if (key === "root_x")
        assert.equal(editor.object.root_y, original[index].objects[0].root_y);
    }
    const final = structuredClone(editor.report.keyframes);
    editor.undo();
    assert.deepEqual(editor.report.keyframes, original);
    editor.redo();
    assert.deepEqual(editor.report.keyframes, final);
  }
});

test("camera and duration ranges retain unrelated values and share one history entry", () => {
  for (const [key, value] of [
    ["duration", 9],
    ["camera_x", 42],
    ["camera_y", 35],
    ["camera_scale", 125],
    ["camera_angle", 15],
  ]) {
    const editor = blank();
    editor.report.keyframes.push(
      structuredClone(editor.frame),
      structuredClone(editor.frame),
    );
    editor.report.keyframes.forEach((f, i) => {
      f._styk = { ...f._styk, frameId: `range-${i}` };
      f.camera = {
        is_default: false,
        x: 10 + i,
        y: 20 + i,
        scale: 1 + i / 10,
        angle_rad: i / 10,
      };
    });
    editor.load(editor.report);
    const original = structuredClone(editor.report.keyframes),
      token = beginNativePropertyEdit(editor, key, { indices: [0, 2] });
    previewNativePropertyEdit(token, value);
    assert.deepEqual(editor.report.keyframes[2], original[2]);
    commitNativePropertyEdit(token);
    assert.equal(editor._undo.length, 1);
    assert.deepEqual(editor.report.keyframes[1], original[1]);
    for (const index of [0, 2]) {
      editor.selectFrame(index);
      near(getNativePropertyValue(editor, key), value);
    }
    editor.undo();
    assert.deepEqual(editor.report.keyframes, original);
  }
});

test("duration range signals every committed frame while previews and cancellation only signal the current frame", () => {
  const editor = blank();
  editor.report.keyframes.push(
    structuredClone(editor.frame),
    structuredClone(editor.frame),
  );
  editor.report.keyframes.forEach((frame, index) => {
    frame._styk = { ...frame._styk, frameId: `duration-signal-${index}` };
  });
  editor.load(editor.report);
  const events = [];
  editor.addEventListener("change", (event) => {
    if (event.detail.nativeProperty === "duration") events.push(event.detail);
  });
  let token = beginNativePropertyEdit(editor, "duration", { indices: [0, 2] });
  previewNativePropertyEdit(token, 9);
  assert.deepEqual(events.at(-1).frameIndices, [0]);
  assert.deepEqual(events.at(-1).changedFrames, [0]);
  commitNativePropertyEdit(token);
  assert.deepEqual(events.at(-1).frameIndices, [0, 2]);
  assert.deepEqual(events.at(-1).changedFrames, [0, 2]);
  assert.equal(events.at(-1).live, false);
  token = beginNativePropertyEdit(editor, "duration", { indices: [0, 2] });
  previewNativePropertyEdit(token, 5);
  cancelNativePropertyEdit(token);
  assert.deepEqual(events.at(-1).frameIndices, [0]);
  assert.deepEqual(events.at(-1).changedFrames, [0]);
  assert.equal(editor.report.keyframes[0].duration_raw, 9);
  assert.equal(editor.report.keyframes[2].duration_raw, 9);
});
