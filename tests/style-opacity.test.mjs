import test from "node:test";
import assert from "node:assert/strict";
import {newOwnedEditor} from './support/owned-editor.mjs';
import { inspectorView } from "../src/inspector-view.mjs";

function fixture() {
  const editor = newOwnedEditor({ demo: false, layerTimeline: true });
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
  editor.markSaved();
  return editor;
}

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
});

