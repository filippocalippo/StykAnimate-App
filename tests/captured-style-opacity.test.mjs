import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.mjs";
import { setAnimationStyle } from "../src/animation-style.mjs";
import {
  getNativePropertyValue,
  beginNativePropertyEdit,
  previewNativePropertyEdit,
  commitNativePropertyEdit,
  cancelNativePropertyEdit,
} from "../src/native-property-edit.mjs";

const specs = [
  ["outline_opacity", "figure", "outlineOpacity"],
  ["segment_opacity", "segment", "opacity"],
  ["segment_gradient_opacity", "segment", "gradientOpacity"],
];
function fixture() {
  const editor = new Editor({ demo: false });
  editor.addFigure();
  editor.select(editor.selectedUid, 0);
  editor.updateFigureStyle({
    outlineWidth: 3,
    outlineColor: "#0d99ff",
    outlineOpacity: 0.8,
  });
  editor.updateSegmentStyle({
    color: "#e82e53",
    opacity: 0.7,
    gradient: { color: "#24aefd", opacity: 0.6 },
  });
  for (const segment of editor.figure.segments) {
    segment.segment_id *= 11;
    segment.parent_id *= 11;
  }
  editor._invalidate();
  editor._undo = [];
  editor._redo = [];
  editor._historySize = 0;
  editor.markSaved();
  return editor;
}
const target = (editor, kind) =>
  kind === "figure"
    ? { kind, uid: editor.selectedUid }
    : {
        kind,
        uid: editor.selectedUid,
        handleId: editor.figure.segments[0].segment_id,
      };
function capture(editor) {
  for (const [, kind, property] of specs)
    setAnimationStyle(editor.object, target(editor, kind), property, 0.427);
  editor._invalidate();
}
function edit(editor, key, value, options) {
  const token = beginNativePropertyEdit(editor, key, options);
  previewNativePropertyEdit(token, value);
  commitNativePropertyEdit(token);
  return token;
}

test("captured opacity edits the displayed instance with one undo and no scalar channel", () => {
  for (const [key, kind, property] of specs) {
    const e = fixture();
    capture(e);
    const uid = e.selectedUid,
      definition = structuredClone(e.figure),
      beforeStyle = structuredClone(e.object._stykStyle);
    e.addFigure(e.figure.figure_type_id);
    const other = e.selectedUid;
    e.select(uid, 0);
    e._undo = [];
    e._historySize = 0;
    assert.ok(Math.abs(getNativePropertyValue(e, key) - 42.7) < 1e-9);
    edit(e, key, 64.123);
    assert.equal(e._undo.length, 1);
    assert.equal(e._undo[0].kind, "objects");
    assert.equal(e.animationChannels.length, 0);
    assert.deepEqual(e.figure, definition);
    assert.equal(
      e.frame.objects.find((o) => o.unique_id === other)._stykStyle,
      undefined,
    );
    assert.equal(getNativePropertyValue(e, key), 64.123);
    const after = structuredClone(e.object._stykStyle);
    const expected = structuredClone(beforeStyle);
    if (kind === "figure") expected.outlineOpacity = 64.123 / 100;
    else expected.segments[11][property] = 64.123 / 100;
    assert.deepEqual(after, expected);
    e.undo();
    assert.deepEqual(e.object._stykStyle, beforeStyle);
    e.redo();
    assert.deepEqual(e.object._stykStyle, after);
  }
});

test("cancel restores captured opacity without mutating definitions or other captured properties", () => {
  for (const [key] of specs) {
    const e = fixture();
    capture(e);
    const before = structuredClone(e.report);
    const token = beginNativePropertyEdit(e, key);
    previewNativePropertyEdit(token, 20);
    previewNativePropertyEdit(token, 35);
    cancelNativePropertyEdit(token);
    assert.deepEqual(e.report, before);
    assert.equal(e._undo.length, 0);
    assert.equal(e.animationChannels.length, 0);
  }
});

test("explicit native ranges edit only the captured property by stable native handle ID", () => {
  for (const [key] of specs) {
    const e = fixture();
    capture(e);
    e.addFrame();
    e.addFrame();
    e.selectFrame(1);
    e.select(e.frame.objects[0].unique_id, 0);
    const definition = structuredClone(e.figure),
      before = structuredClone(e.report.keyframes),
      undo = e._undo.length;
    edit(e, key, 23, { indices: [0, 1, 2] });
    assert.equal(e._undo.length, undo + 1);
    assert.deepEqual(e.figure, definition);
    for (let index = 0; index < 3; index++) {
      e.selectFrame(index);
      e.select(e.frame.objects[0].unique_id, 0);
      assert.equal(getNativePropertyValue(e, key), 23);
    }
    e.undo();
    assert.deepEqual(e.report.keyframes, before);
  }
});

test("a pasted authored appearance edits locally through pose history without creating a scalar channel", () => {
  for (const [key, kind, property] of specs) {
    const e = fixture(),
      source = e.selectedUid;
    e.addAnimationKey(target(e, kind), property, 0, 0.427);
    e.copyFigure();
    e.pasteFigure();
    const pasted = e.selectedUid;
    e.select(pasted, 0);
    assert.notEqual(pasted, source);
    assert.equal(e.animationChannel(target(e, kind), property), null);
    const definition = structuredClone(e.figure),
      before = getNativePropertyValue(e, key),
      count = e._undo.length;
    edit(e, key, 31);
    assert.equal(e._undo.length, count + 1);
    assert.equal(getNativePropertyValue(e, key), 31);
    assert.deepEqual(e.figure, definition);
    assert.equal(e.animationChannel(target(e, kind), property), null);
    const sourceTarget = { ...target(e, kind), uid: source };
    assert.equal(e.animationValue(sourceTarget, property), 0.427);
    e.undo();
    e.select(pasted, 0);
    assert.equal(getNativePropertyValue(e, key), before);
    e.redo();
    e.select(pasted, 0);
    assert.equal(getNativePropertyValue(e, key), 31);
  }
});
