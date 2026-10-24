import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.mjs";
import { inspectorView } from "../src/inspector-view.mjs";
import { roundTrip } from "./support/codec.mjs";
import {
  canEditNativeProperty,
  getNativePropertyValue,
  beginNativePropertyEdit,
  previewNativePropertyEdit,
  commitNativePropertyEdit,
  cancelNativePropertyEdit,
} from "../src/native-property-edit.mjs";

function fixture() {
  const editor = new Editor({ demo: false });
  editor.addFigure();
  editor.select(editor.selectedUid, 0);
  editor.updateFigureStyle({
    name: "Opacity fixture",
    outlineWidth: 3.25,
    outlineColor: "#0d99ff",
    outlineOpacity: 0.8,
  });
  editor.updateSegmentStyle({
    color: "#f8356a",
    opacity: 0.7,
    gradient: { color: "#2cd876", opacity: 0.6 },
  });
  editor._undo = [];
  editor._redo = [];
  editor._historySize = 0;
  editor.markSaved();
  return editor;
}
function set(editor, key, value) {
  const token = beginNativePropertyEdit(editor, key);
  previewNativePropertyEdit(token, value);
  commitNativePropertyEdit(token);
}
const raw = (editor) => ({
  outline: editor.figure.segment_decode.global_style.u30,
  primary: editor.figure.segments[0].transparency,
  secondary: editor.figure.segments[0].secondary.a,
});

test("outline and gradient endpoint opacity are independent inverse-alpha bytes with bounded undo", () => {
  for (const [key, component] of [
    ["outline_opacity", "outline"],
    ["segment_opacity", "primary"],
    ["segment_gradient_opacity", "secondary"],
  ]) {
    const editor = fixture(),
      figure = editor.figure,
      original = structuredClone(figure),
      before = raw(editor);
    figure.opaqueMedia = "M".repeat(2_000_000);
    const token = beginNativePropertyEdit(editor, key);
    for (let n = 0; n < 80; n++) previewNativePropertyEdit(token, n);
    previewNativePropertyEdit(token, 25);
    assert.equal(editor._undo.length, 0);
    assert.equal(editor.figure, figure);
    commitNativePropertyEdit(token);
    assert.equal(editor._undo.length, 1);
    assert.ok(editor._undo[0].bytes < 3500);
    assert.deepEqual(raw(editor), { ...before, [component]: 191 });
    assert.deepEqual(
      figure.segment_decode.global_style.rgb,
      original.segment_decode.global_style.rgb,
    );
    assert.equal(
      figure.segment_decode.global_style.u28,
      original.segment_decode.global_style.u28,
    );
    assert.deepEqual(
      figure.segments[0].color_rgb,
      original.segments[0].color_rgb,
    );
    assert.deepEqual(
      figure.segments[0].secondary.rgb,
      original.segments[0].secondary.rgb,
    );
    editor.undo();
    assert.deepEqual(raw(editor), before);
    editor.redo();
    assert.deepEqual(raw(editor), { ...before, [component]: 191 });
    assert.equal(getNativePropertyValue(editor, key), (1 - 191 / 255) * 100);
  }
});

test("opacity endpoints are exact at 0 and 100 and invalid edits do not mutate", () => {
  for (const [key, component] of [
    ["outline_opacity", "outline"],
    ["segment_gradient_opacity", "secondary"],
  ]) {
    const editor = fixture();
    set(editor, key, 0);
    assert.equal(raw(editor)[component], 255);
    set(editor, key, 100);
    assert.equal(raw(editor)[component], 0);
    const before = structuredClone(editor.report);
    for (const value of [-1, 101, NaN, Infinity]) {
      const token = beginNativePropertyEdit(editor, key);
      assert.throws(() => previewNativePropertyEdit(token, value));
      cancelNativePropertyEdit(token);
      assert.deepEqual(editor.report, before);
    }
  }
});

test("cancel restores an absent outline style and does not manufacture a gradient", () => {
  const editor = fixture();
  delete editor.figure.segment_decode;
  const before = structuredClone(editor.report);
  const token = beginNativePropertyEdit(editor, "outline_opacity");
  previewNativePropertyEdit(token, 42);
  cancelNativePropertyEdit(token);
  assert.deepEqual(editor.report, before);
  assert.equal(editor.dirty, false);
  editor.figure.segments[0].secondary = null;
  assert.equal(
    canEditNativeProperty(editor, "segment_gradient_opacity"),
    false,
  );
  assert.throws(
    () => beginNativePropertyEdit(editor, "segment_gradient_opacity"),
    /Select the property/,
  );
  editor.select(null);
  assert.equal(canEditNativeProperty(editor, "outline_opacity"), false);
});

test("inspector shows secondary color only on circles and omits figure outline controls", () => {
  const editor = fixture();
  const secondary = structuredClone(editor.figure.segments[0].secondary);
  assert.doesNotMatch(inspectorView({editor}), /id="segment-gradient-enabled"|data-property="segment_gradient_opacity"/);
  for (const shape of ['circle', 'circleFill', 'circleClear']) {
    editor.convertSegment(shape);
    const circle = inspectorView({editor});
    assert.match(circle, /id="segment-gradient-enabled"/);
    assert.match(circle, /data-property="segment_gradient_opacity"/);
  }
  const html = inspectorView({ editor });
  for (const key of [
    "segment_opacity",
    "segment_gradient_opacity",
  ]) {
    assert.match(html, new RegExp(`data-property="${key}"`));
    assert.match(html, new RegExp(`data-property-row="${key}"`));
  }
  const selection=editor.selectedJoint;editor.select(editor.selectedUid,-1);
  const figureView=inspectorView({editor});
  assert.doesNotMatch(figureView,/data-property="outline_opacity"/);
  assert.doesNotMatch(figureView,/data-property="outline_width"/);
  assert.doesNotMatch(figureView,/id="outline-color"/);
  editor.select(editor.selectedUid,selection);
  assert.match(html, /Primary opacity/);
  assert.match(html, /Secondary opacity/);
  for (const shape of ['line', 'squareLine']) {
    editor.convertSegment(shape);
    assert.doesNotMatch(inspectorView({editor}), /id="segment-gradient-enabled"|data-property="segment_gradient_opacity"/);
    assert.deepEqual(editor.figure.segments[0].secondary, secondary);
  }
  editor.convertSegment('circleFill');
  editor.figure.segments[0].secondary = null;
  assert.doesNotMatch(
    inspectorView({ editor }),
    /data-property="segment_gradient_opacity"/,
  );
  assert.match(inspectorView({editor}), /id="segment-gradient-enabled"/);
  assert.doesNotMatch(inspectorView({editor}), /id="segment-gradient-color"/);
});

test("edited native alpha bytes and untouched RGB values round-trip through real PIV and STK writers", async () => {
  const editor = fixture();
  set(editor, "outline_opacity", 25);
  set(editor, "segment_opacity", 40);
  set(editor, "segment_gradient_opacity", 75);
  const document = editor.serialize(), result = {};
  for (const kind of ["piv", "stk"]) {
    const source = document.figure_types.find((f) => f.name === "Opacity fixture");
    assert.ok(source);
    const reopened = await roundTrip({ document, format: kind, figureTypeId: source.figure_type_id });
    const figure = reopened.figure_types.find((f) => f.segment_decode?.global_style?.u30 === 191);
    assert.ok(figure, `${kind} keeps the edited outline alpha`);
    result[kind] = { style: figure.segment_decode.global_style, segment: figure.segments[0] };
  }
  for (const value of Object.values(result)) {
    assert.equal(value.style.u30, 191);
    assert.deepEqual(value.style.rgb, [13, 153, 255]);
    assert.equal(value.style.outline_thickness, 3.25);
    assert.equal(value.segment.transparency, 153);
    assert.deepEqual(value.segment.color_rgb, [248, 53, 106]);
    assert.deepEqual(value.segment.secondary, { rgb: [44, 216, 118], a: 64 });
  }
});
