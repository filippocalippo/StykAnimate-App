import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainWorkspace,
  normalizeWorkspacePreferences,
} from "../src/workspace-layout.mjs";
import { constrainFloatingPanel } from "../src/workspace-panels.mjs";

test("Simple timeline reserves room for the filmstrip controls when docked and floating", () => {
  assert.equal(
    constrainWorkspace({ timeline: 135 }, 1100, 660, 740, {
      minTimelineHeight: 205,
    }).timeline,
    205,
  );
  assert.equal(
    constrainWorkspace({ timeline: 135 }, 1100, 660, 740).timeline,
    135,
  );
  assert.equal(
    constrainFloatingPanel({ height: 100 }, "timeline", 1100, 660, {
      minTimelineHeight: 205,
    }).height,
    205,
  );
  assert.equal(
    constrainFloatingPanel({ height: 100 }, "timeline", 1100, 660).height,
    150,
  );
});

test("workspace keeps the stage usable with oversized saved preferences", () => {
  const layout = constrainWorkspace(
    { left: 420, right: 420, timeline: 800 },
    1100,
    660,
    740,
  );
  assert.ok(layout.stage >= 420);
  assert.ok(layout.left >= 170 && layout.right >= 210);
  assert.ok(layout.timeline <= 444);
  assert.ok(660 - layout.timeline - 47 >= 160);
});

test("portable workspace preferences retain only finite layout data", () => {
  const input = {
    left: 310,
    right: Infinity,
    timeline: -1,
    source: "private-path",
    floating: {
      left: { x: 25, y: 48, width: 330, height: 440, extra: "omit" },
      right: { x: NaN, y: 20, width: -5, height: Infinity },
      unknown: { x: 100 },
    },
  };
  const normalized = normalizeWorkspacePreferences(input);
  assert.deepEqual(normalized, {
    left: 310,
    floating: {
      left: { x: 25, y: 48, width: 330, height: 440 },
      right: { y: 20 },
    },
  });
  normalized.floating.left.x = 70;
  assert.equal(input.floating.left.x, 25);
  assert.deepEqual(normalizeWorkspacePreferences(null), {});
  assert.deepEqual(normalizeWorkspacePreferences([]), {});
  assert.deepEqual(normalizeWorkspacePreferences({ floating: {} }), {});
});

test("floating panels release dock space and remain reachable in smaller windows", () => {
  const layout = constrainWorkspace(
    { floating: { left: {}, right: {}, timeline: {} } },
    1100,
    660,
    740,
  );
  assert.equal(layout.stage, 1100);
  assert.equal(layout.timeline, 0);
  const panel = constrainFloatingPanel(
    { x: 1400, y: 800, width: 900, height: 700 },
    "right",
    1100,
    660,
  );
  assert.ok(
    panel.x >= 8 &&
      panel.y >= 8 &&
      panel.x + panel.width <= 1092 &&
      panel.y + panel.height <= 652,
  );
});

test("compact clamping leaves saved preferences intact for a larger window", () => {
  const preference = { left: 360, right: 400, timeline: 400 };
  const compact = constrainWorkspace(preference, 960, 660, 740);
  assert.ok(compact.stage >= 360);
  const large = constrainWorkspace(preference, 1600, 920, 1000);
  assert.equal(large.left, 360);
  assert.equal(large.right, 400);
  assert.equal(large.timeline, 400);
  assert.deepEqual(preference, { left: 360, right: 400, timeline: 400 });
});

test("responsive defaults and impossible small bounds never overflow", () => {
  assert.equal(constrainWorkspace({}, 1560, 920, 1000).left, 224);
  assert.equal(constrainWorkspace({}, 1100, 660, 740).left, 190);
  assert.equal(constrainWorkspace({}, 960, 600, 680).timeline, 193);
  for (const width of [0, 100, 320, 600, 800, 960, 1100, 1560]) {
    const layout = constrainWorkspace({}, width, 150, 230);
    assert.ok(layout.left + layout.right <= width + 0.001);
    assert.ok(layout.stage >= 0);
    assert.equal(layout.timeline, 0);
  }
});
