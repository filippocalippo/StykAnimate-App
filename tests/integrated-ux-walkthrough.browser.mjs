import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const out = "artifacts/integrated-ux-walkthrough";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const checks = [],
  defects = [],
  errors = [],
  details = {};
const requestedSteps = process.env.STYK_UX_STEPS?.split(",");
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
const check = (name, ok, detail) => {
  (ok ? checks : defects).push({ name, ...(detail ? { detail } : {}) });
  console.log(ok ? "PASS" : "FAIL", name, detail ? JSON.stringify(detail) : "");
};
const settle = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const layout = () =>
  page.evaluate(() => ({
    sizes: styk.workspace.sizes,
    floating: structuredClone(styk.workspace.floating),
  }));
async function drag(locator, dx, dy) {
  const r = await locator.boundingBox(),
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await settle();
}
async function mode(value) {
  await page.evaluate(() => styk.settingsUI.open("interface"));
  await page
    .locator(`.styk-settings [data-setting="timelineMode"][value="${value}"]`)
    .check();
  await page.locator(".styk-settings-head button").click();
  await settle();
}
async function step(name, fn) {
  if (requestedSteps && !requestedSteps.includes(name)) return;
  console.log("STEP", name);
  try {
    await fn();
  } catch (e) {
    defects.push({ name, error: e.message });
    console.log("FAILED STEP", name, e.message);
    await page
      .screenshot({ path: `${out}/failure-${name}.png` })
      .catch(() => {});
  }
}
async function canvasPoint(point) {
  return page.evaluate((p) => {
    const r = document.querySelector("#viewport").getBoundingClientRect(),
      v = styk.state.view;
    return { x: r.x + v.x + p.x * v.scale, y: r.y + v.y + p.y * v.scale };
  }, point);
}
async function clickTrack(id) {
  await page.evaluate((id) => {
    const t = styk.timeline,
      index = t.tracks.findIndex((row) => row.id === id);
    if (index < 0) throw Error("Track missing " + id);
    t.scroll.scrollTop = Math.max(0, index * 30 - 30);
  }, id);
  await settle();
  await page
    .locator(
      `.styk-timeline-label:not([hidden])[data-track-id="${id}"] .styk-timeline-label-select`,
    )
    .click();
  await settle();
}
async function expandTrack(id) {
  await page.evaluate((id) => {
    const t = styk.timeline,
      index = t.tracks.findIndex((row) => row.id === id);
    if (index < 0) throw Error("Track missing " + id);
    t.scroll.scrollTop = Math.max(0, index * 30 - 30);
  }, id);
  await settle();
  if (!(await page.evaluate((id) => styk.timeline.expandedTracks.has(id), id)))
    await page
      .locator(
        `.styk-timeline-label:not([hidden])[data-track-id="${id}"] .styk-timeline-label-disclosure`,
      )
      .click();
  await settle();
}
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => styk.workspace.reset());
  await settle();
  details.backend = await page.evaluate(
    () => styk.state.renderer.stats.backend,
  );
  await step("panels", async () => {
    const before = await layout();
    await drag(
      page.locator('.styk-workspace-splitter[data-panel="left"]'),
      35,
      0,
    );
    const after = await layout();
    check(
      "Dock splitter increases Layers width and preserves canvas minimum",
      after.sizes.left > before.sizes.left && after.sizes.stage >= 420,
    );
    await page.locator('[data-panel-toggle="left"]').click();
    await settle();
    const floated = await layout();
    await drag(page.locator('[data-panel-move="left"]'), 180, 65);
    const moved = await layout();
    check(
      "Layers floats and moves in both axes",
      moved.floating.left?.x > floated.floating.left.x + 175 &&
        moved.floating.left.y > floated.floating.left.y + 60,
    );
    await drag(
      page.locator('[data-workspace-panel="left"] [data-edge="se"]'),
      45,
      35,
    );
    const resized = await layout();
    check(
      "Floating panel corner changes both dimensions",
      resized.floating.left.width > moved.floating.left.width + 40 &&
        resized.floating.left.height > moved.floating.left.height + 30,
    );
    await page.locator('[data-panel-move="left"]').focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    const keyboard = await layout();
    check(
      "Floating panel supports keyboard and fine movement",
      keyboard.floating.left.x === resized.floating.left.x + 10 &&
        keyboard.floating.left.y === resized.floating.left.y + 1,
    );
    await page.keyboard.press("Enter");
    await settle();
    check("Enter redocks the focused panel", !(await layout()).floating.left);
    await mode("simple");
    check(
      "Preferences switches to Simple filmstrip with usable minimum",
      await page.evaluate(
        () =>
          styk.timeline.constructor.name === "SimpleTimeline" &&
          document.querySelector(".timeline-panel").getBoundingClientRect()
            .height >= 205,
      ),
    );
    await page.locator('[data-panel-toggle="timeline"]').click();
    await drag(
      page.locator('[data-workspace-panel="timeline"] [data-edge="se"]'),
      -700,
      -500,
    );
    check(
      "Simple floating resize preserves complete 205px controls",
      await page.evaluate(
        () =>
          document.querySelector(".timeline-panel").getBoundingClientRect()
            .height >= 205,
      ),
    );
    await page.locator('[data-panel-toggle="timeline"]').click();
    await mode("advanced");
    for (const [width, height] of [
      [1560, 1000],
      [1280, 800],
      [1100, 740],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => styk.workspace.reset());
      await settle();
      const metrics = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth <= innerWidth,
        controls: [...document.querySelectorAll(".styk-panel-controls")].every(
          (e) => {
            const a = e.getBoundingClientRect(),
              b = e.parentElement.getBoundingClientRect();
            return a.x >= b.x && a.right <= b.right + 0.5;
          },
        ),
        canvas:
          Math.abs(
            document.querySelector("#scene").width / devicePixelRatio -
              document.querySelector("#viewport").clientWidth,
          ) <= 1,
        inspector:
          document.querySelector("#inspector").scrollWidth <=
          document.querySelector("#inspector").clientWidth + 1,
      }));
      check(
        `Workspace fits ${width}px without clipped headers or inspector`,
        Object.values(metrics).every(Boolean),
        metrics,
      );
      await page.screenshot({ path: `${out}/workspace-${width}.png` });
    }
    await page.setViewportSize({ width: 1560, height: 1000 });
    await page.evaluate(() => styk.workspace.reset());
    await settle();
  });
  await step("focus-and-track", async () => {
    await page.evaluate(() => {
      const e = styk.editor;
      e.newDocument();
      e.setFramesDuration([0], 21);
      e.addFrame();
      e.selectFrame(0);
      e.addAnimationKey(
        { kind: "figure", uid: e.selectedUid },
        "opacity",
        0,
        0.6,
      );
    });
    await settle();
    const uid = await page.evaluate(() => styk.editor.selectedUid),
      before = await page.evaluate(() => ({
        tool: styk.state.tool,
        root: [styk.editor.object.root_x, styk.editor.object.root_y],
        frames: styk.editor.report.keyframes.length,
      }));
    await page.evaluate(() => styk.settingsUI.open("canvas"));
    await page.keyboard.press("l");
    await page.keyboard.press("Delete");
    await page.keyboard.press("ArrowRight");
    check(
      "Modal focus prevents canvas shortcuts and frame deletion",
      await page.evaluate(
        (before) =>
          styk.state.tool === before.tool &&
          styk.editor.report.keyframes.length === before.frames &&
          styk.editor.object.root_x === before.root[0],
        before,
      ),
    );
    await page.keyboard.press("Escape");
    check(
      "Escape closes Preferences",
      await page.locator(".styk-settings").evaluate((e) => !e.open),
    );
    const field = page.locator('#inspector [data-property="root_x"]');
    await field.focus();
    const rootBefore = await page.evaluate(() => styk.editor.object.root_x);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    check(
      "Numeric field arrows do not nudge canvas figures",
      await page.evaluate((x) => styk.editor.object.root_x === x, rootBefore),
    );
    await field.press("Tab");
    const tooltips = await page.locator("[data-tool]").evaluateAll((nodes) =>
      nodes.map((e) => ({
        title: e.title,
        aria: e.getAttribute("aria-label"),
        icon: !!e.querySelector("svg"),
      })),
    );
    check(
      "Canvas tools have real SVG icons and descriptive tooltips",
      tooltips.every((t) => t.title.length > 3 && t.icon),
    );
    const layer = await page.evaluate(
      (uid) => styk.editor.layerForUid(uid),
      uid,
    );
    await page
      .locator(
        `.styk-timeline-label:not([hidden])[data-track-id="${layer}"] .styk-timeline-label-disclosure`,
      )
      .click();
    await settle();
    await page.evaluate((uid) => {
      const t = styk.timeline,
        index = t.tracks.findIndex((row) => row.id === `figure:${uid}`);
      t.scroll.scrollTop = Math.max(0, index * 30 - 30);
    }, uid);
    await settle();
    await page
      .locator(
        `.styk-timeline-label:not([hidden])[data-track-id="figure:${uid}"] .styk-timeline-label-disclosure`,
      )
      .click();
    await settle();
    const track = await page.evaluate(
      () =>
        styk.timeline.tracks.find(
          (t) =>
            t.kind === "channel" &&
            t.target.kind === "figure" &&
            t.property === "opacity",
        ).id,
    );
    await clickTrack(track);
    await page.evaluate(() => styk.editor.seek(5));
    await settle();
    const selected = await page.evaluate(
      (track) => ({
        timeline: styk.timeline.selectedTrackId,
        state: styk.state.selectedTrackId,
        aria: document
          .querySelector(
            `.styk-timeline-label:not([hidden])[data-track-id="${track}"]`,
          )
          ?.getAttribute("aria-selected"),
      }),
      track,
    );
    check(
      "Clicked property retains highlight after selection and two rendered frames",
      selected.timeline === track &&
        selected.state === track &&
        selected.aria === "true",
      selected,
    );
    const channelsBefore = await page.evaluate(() =>
      styk.editor.report._styk.animation.channels.map((c) => ({
        id: c.id,
        property: c.property,
        keys: c.keys.length,
      })),
    );
    await page.locator('[data-track-action="addTrackKey"]').click();
    await settle();
    const inserted = await page.evaluate(
      ({ uid, track }) => ({
        target: styk.timeline.selectedTrackId,
        key: styk.editor
          .animationChannel({ kind: "figure", uid }, "opacity")
          .keys.some((k) => k.tick === 5),
        channels: styk.editor.report._styk.animation.channels.map((c) => ({
          id: c.id,
          property: c.property,
          keys: c.keys.length,
        })),
      }),
      { uid, track },
    );
    check(
      "Timeline Key button inserts only in the clicked property",
      inserted.target === track &&
        inserted.key &&
        inserted.channels.every(
          (c) =>
            c.property === "opacity" ||
            channelsBefore.some((b) => b.id === c.id && b.keys === c.keys),
        ),
      inserted,
    );
    await page.screenshot({ path: `${out}/property-track.png` });
    const handleId = await page.evaluate(
      (uid) =>
        styk.editor.report.figure_types.find(
          (f) =>
            f.figure_type_id ===
            styk.editor.selectionFrame.objects.find((o) => o.unique_id === uid)
              .figure_type_id,
        ).segments[0].segment_id,
      uid,
    );
    for (const [parent, target, property] of [
      ["camera", { kind: "camera" }, "x"],
      ["scene", { kind: "scene" }, "color"],
      [
        `segment:${uid}:${handleId}`,
        { kind: "segment", uid, handleId },
        "opacity",
      ],
    ]) {
      await expandTrack(parent);
      const id = await page.evaluate(
        ({ target, property }) =>
          styk.timeline.tracks.find(
            (t) =>
              t.kind === "channel" &&
              t.property === property &&
              t.target.kind === target.kind &&
              (target.uid === undefined || t.target.uid === target.uid) &&
              (target.handleId === undefined ||
                t.target.handleId === target.handleId),
          ).id,
        { target, property },
      );
      await clickTrack(id);
      await page.evaluate(() => styk.editor.seek(8));
      await settle();
      check(
        `${target.kind} property row retains selection after inspector update`,
        await page.evaluate(
          (id) =>
            styk.timeline.selectedTrackId === id &&
            styk.state.selectedTrackId === id &&
            document
              .querySelector(
                `.styk-timeline-label:not([hidden])[data-track-id="${id}"]`,
              )
              ?.getAttribute("aria-selected") === "true",
          id,
        ),
      );
      const before = await page.evaluate(() =>
        styk.editor.animationChannels.map((c) => ({
          id: c.id,
          keys: c.keys.length,
        })),
      );
      await page.locator('[data-track-action="addTrackKey"]').click();
      await settle();
      check(
        `${target.kind} property toolbar creates only its requested key`,
        await page.evaluate(
          ({ target, property, id, before }) => {
            const channel = styk.editor.animationChannel(target, property);
            return (
              styk.timeline.selectedTrackId === id &&
              channel?.keys.some((k) => k.tick === 8) &&
              styk.editor.animationChannels.every(
                (c) =>
                  c.id === channel.id ||
                  before.some((b) => b.id === c.id && b.keys === c.keys.length),
              )
            );
          },
          { target, property, id, before },
        ),
      );
    }
    for (const id of [`figure:${uid}`, `segment:${uid}:${handleId}`]) {
      await clickTrack(id);
      check(
        `${id.startsWith("segment") ? "Segment" : "Figure"} row remains selected after inspector refresh`,
        await page.evaluate(
          (id) =>
            styk.timeline.selectedTrackId === id &&
            styk.state.selectedTrackId === id,
          id,
        ),
      );
    }
    await page.screenshot({ path: `${out}/segment-track.png` });
  });
  await step("build-across-figures", async () => {
    await page.evaluate(() => {
      const e = styk.editor;
      e.newDocument();
      const first = e.selectedUid;
      e.moveSelection(-120, 0);
      e.addFigure(e.figure.figure_type_id);
      e.moveSelection(120, 0);
      window.buildUids = [first, e.selectedUid];
      styk.fit();
    });
    await settle();
    await page.locator('[data-tool="line"]').click();
    for (const index of [0, 1]) {
      const data = await page.evaluate((index) => {
        const e = styk.editor,
          uid = window.buildUids[index],
          g = [...e.geometry.objects.values()].find(
            (g) => g.obj.unique_id === uid,
          );
        return {
          uid,
          point: g.segments[0].end,
          count: g.fig.segments.length,
          other: e.selectedUid,
        };
      }, index);
      const p = await canvasPoint(data.point);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 35, p.y - 25, { steps: 6 });
      await page.mouse.up();
      await settle();
      const result = await page.evaluate(() => ({
        uid: styk.editor.selectedUid,
        count: styk.editor.figure.segments.length,
        tool: styk.state.tool,
      }));
      check(
        `Line tool builds on figure ${index + 1} while staying active`,
        result.uid === data.uid &&
          result.count === data.count + 1 &&
          result.tool === "line",
        result,
      );
    }
    const viewport = await page.locator("#viewport").boundingBox(),
      empty = { x: viewport.x + 50, y: viewport.y + 65 },
      before = await page.evaluate(
        () => styk.editor.selectionFrame.objects.length,
      );
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.move(empty.x + 35, empty.y + 45, { steps: 6 });
    await page.mouse.up();
    await settle();
    check(
      "Drawing on empty canvas starts a separate figure",
      await page.evaluate(
        (before) => styk.editor.selectionFrame.objects.length === before + 1,
        before,
      ),
    );
    await page.locator('[data-tool="select"]').click();
  });
  await step("akane", async () => {
    await mode("simple");
    await page.evaluate(() => styk.editor.markSaved());
    await page
      .locator("#file-input")
      .setInputFiles(
        "C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv",
      );
    await page.waitForFunction(
      () =>
        !styk.state.importing &&
        styk.editor.name === "16 Akane vs Akato Segundo round (3)",
      null,
      { timeout: 180000 },
    );
    await page.waitForFunction(
      () => styk.timeline.stats.cachedPreviews >= 4,
      null,
      { timeout: 90000 },
    );
    details.akane = await page.evaluate(() => ({
      definitions: styk.editor.report.figure_types.length,
      frames: styk.editor.report.keyframes.length,
      import: styk.state.lastImport,
    }));
    check(
      "Actual large PIV loads 881 definitions and 1479 frames",
      details.akane.definitions === 881 && details.akane.frames === 1479,
    );
    await page.locator(".styk-simple-strip").focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => styk.editor.frameIndex === 1478);
    await settle();
    check(
      "Simple keyboard End reaches last native frame with bounded cards",
      await page.evaluate(
        () =>
          document.querySelectorAll(".styk-simple-card").length < 15 &&
          styk.timeline.stats.cachedPreviews <= 72,
      ),
    );
    await page.locator('[data-tab="assets"]').click();
    await page.waitForTimeout(150);
    details.assets = await page.evaluate(() => ({ ...styk.assets.stats }));
    check(
      "Large asset library virtualizes definitions and lazy previews",
      details.assets.rows < 40 && details.assets.cachedPreviews <= 72,
      details.assets,
    );
    await page.locator('[data-tab="layers"]').click();
    await mode("advanced");
    const attached = await page.evaluate(async () => {
      const { getPivotHandles, pickCanvasHandle } = await import(
          "/src/canvas-interactions.mjs"
        ),
        e = styk.editor,
        geometry = e.geometry;
      const handles = getPivotHandles(geometry, { frame: e.selectionFrame }),
        cases = [];
      for (const child of geometry.objects.values()) {
        if (!child?.obj.join) continue;
        const parent = geometry.objects.get(child.obj.join.target_object_slot),
          target = parent?.segments.find(
            (s) => s.seg.segment_id === child.obj.join.target_handle_id,
          );
        if (!target || target.static) continue;
        const hit = pickCanvasHandle(geometry, child.root, {
          handles,
          radius: 4,
        });
        if (hit?.action === "pose")
          cases.push({
            uid: hit.g.obj.unique_id,
            joint: hit.joint,
            point: child.root,
            parent: parent.obj.unique_id,
          });
      }
      const chosen = cases.find((c) => c.parent === 460616) || cases[0];
      if (!chosen) throw Error("No dynamic attachment candidate");
      e.select(chosen.uid, chosen.joint);
      window.akaneBefore = e.selectionFrame.objects.map((o) => ({
        uid: o.unique_id,
        x: o.root_x,
        y: o.root_y,
        join: !!o.join,
        angles: o.angles.slice(),
      }));
      const r = document.querySelector("#viewport").getBoundingClientRect();
      styk.state.view = {
        scale: 2,
        x: r.width / 2 - chosen.point.x * 2,
        y: r.height / 2 - chosen.point.y * 2,
      };
      e.select(chosen.uid, chosen.joint);
      return chosen;
    });
    await settle();
    await page.locator('[data-tool="pose"]').click();
    const p = await canvasPoint(attached.point);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const routed = await page.evaluate(() => ({
      uid: styk.editor.selectedUid,
      joint: styk.editor.selectedJoint,
      kind: styk.state.drag?.kind,
    }));
    await page.mouse.move(p.x + 17, p.y - 13, { steps: 10 });
    await page.mouse.up();
    await settle();
    const pose = await page.evaluate(() => {
      const old = new Map(window.akaneBefore.map((o) => [o.uid, o]));
      let freeMoved = 0,
        changed = 0;
      for (const o of styk.editor.selectionFrame.objects) {
        const b = old.get(o.unique_id);
        if (
          !o.join &&
          (Math.abs(o.root_x - b.x) > 0.00001 ||
            Math.abs(o.root_y - b.y) > 0.00001)
        )
          freeMoved++;
        if (
          o.angles.some((v, i) => v !== b.angles[i]) ||
          o.root_x !== b.x ||
          o.root_y !== b.y
        )
          changed++;
      }
      return {
        freeMoved,
        changed,
        total: old.size,
        dragging: !!styk.editor.dragging,
      };
    });
    check(
      "Attached-node drag routes to native parent joint",
      routed.uid === attached.uid &&
        routed.joint === attached.joint &&
        routed.kind === "pose",
      { attached, routed },
    );
    check(
      "Attached posing keeps every free assembly origin fixed",
      pose.freeMoved === 0 &&
        pose.changed > 0 &&
        pose.changed < pose.total &&
        !pose.dragging,
      pose,
    );
    await page.evaluate(() => styk.editor.undo());
    await settle();
    await page.screenshot({ path: `${out}/akane-attached.png` });
    await page.locator('[data-tool="rig"]').click();
    const buildTargets = await page.evaluate(async () => {
      const { getPivotHandles, pickCanvasHandle } = await import(
          "/src/canvas-interactions.mjs"
        ),
        e = styk.editor,
        g = e.geometry,
        handles = getPivotHandles(g, {
          frame: e.selectionFrame,
          selectedUid: null,
          selectedUids: new Set(),
          showStatic: true,
          allowStaticManipulation: true,
          viewScale: 2,
          autoSize: styk.state.settings.autoSizeHandles,
          maxDiameter: styk.state.settings.handleSize * 2,
        }),
        out = [];
      for (const object of g.objects.values()) {
        if (object.obj.join) continue;
        const hit = pickCanvasHandle(g, object.root, {
          handles,
          project: (point) => ({ x: point.x * 2, y: point.y * 2 }),
        });
        if (hit && !out.some((item) => item.uid === hit.g.obj.unique_id))
          out.push({ uid: hit.g.obj.unique_id, point: object.root });
        if (out.length === 2) break;
      }
      return out;
    });
    for (const target of buildTargets) {
      await page.evaluate((target) => {
        const r = document.querySelector("#viewport").getBoundingClientRect();
        styk.state.view = {
          scale: 2,
          x: r.width / 2 - target.point.x * 2,
          y: r.height / 2 - target.point.y * 2,
        };
        styk.editor.select(null);
      }, target);
      await settle();
      const p = await canvasPoint(target.point);
      await page.mouse.click(p.x, p.y);
      await settle();
      const result = await page.evaluate(() => ({
        tool: styk.state.tool,
        uid: styk.editor.selectedUid,
        joint: styk.editor.selectedJoint,
      }));
      check(
        `Build tool switches to native Akane figure ${target.uid}`,
        result.tool === "rig" && result.uid === target.uid,
        { target, result },
      );
    }
    check(
      "Large scene supplies two independent Build selection targets",
      buildTargets.length === 2,
    );
    await page.locator('[data-tool="select"]').click();
    await page.setViewportSize({ width: 1100, height: 740 });
    await mode("simple");
    await settle();
    check(
      "Switching to Simple reveals the current late native frame",
      await page.evaluate(() => {
        const strip = document
          .querySelector(".styk-simple-strip")
          .getBoundingClientRect();
        const card = document
          .querySelector(
            `.styk-simple-card[data-frame="${styk.editor.frameIndex}"] .styk-simple-preview`,
          )
          ?.getBoundingClientRect();
        return card && card.left >= strip.left && card.right <= strip.right;
      }),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(
          `.styk-simple-card[data-frame="${styk.editor.frameIndex}"] canvas`,
        ),
      null,
      { timeout: 15000 },
    );
    check(
      "Akane Simple controls fit compact workspace",
      await page.evaluate(() => {
        const p = document
            .querySelector(".timeline-panel")
            .getBoundingClientRect(),
          b = document
            .querySelector(".styk-simple-update")
            .getBoundingClientRect();
        return (
          p.height >= 205 &&
          b.height >= 24 &&
          b.bottom <= p.bottom &&
          b.right <= p.right
        );
      }),
    );
    await page.screenshot({ path: `${out}/akane-simple-1100.png` });
  });
  await step("simple-initial-reveal", async () => {
    const hidden = await page.evaluate(async () => {
      const { SimpleTimeline } = await import("/src/simple-timeline.mjs");
      const { Editor } = await import("/src/editor.mjs");
      const editor = new Editor({ demo: true });
      editor.selectFrame(23);
      const host = document.createElement("div");
      host.id = "simple-hidden-mount";
      host.style.cssText =
        "position:fixed;left:20px;top:60px;width:600px;height:205px;z-index:80;display:none";
      document.body.append(host);
      const ui = new SimpleTimeline(host, editor);
      window.hiddenSimpleTest = { host, ui, editor };
      return ui.revealOnFirstLayout && ui.strip.clientWidth === 0;
    });
    check("Hidden Simple panel defers initial scroll until layout", hidden);
    await page.evaluate(() =>
      hiddenSimpleTest.host.style.removeProperty("display"),
    );
    await page.waitForFunction(() => !hiddenSimpleTest.ui.revealOnFirstLayout);
    check(
      "First visible layout reveals the current frame in a hidden-mounted panel",
      await page.evaluate(() => {
        const { host } = hiddenSimpleTest,
          strip = host
            .querySelector(".styk-simple-strip")
            .getBoundingClientRect(),
          card = host
            .querySelector('[data-frame="23"] .styk-simple-preview')
            ?.getBoundingClientRect();
        return card && card.left >= strip.left && card.right <= strip.right;
      }),
    );
    await page.evaluate(() => {
      hiddenSimpleTest.ui.strip.scrollLeft = 0;
      hiddenSimpleTest.ui.render();
    });
    check(
      "Later renders preserve deliberate filmstrip scrolling",
      await page.evaluate(() => hiddenSimpleTest.ui.strip.scrollLeft === 0),
    );
    await page.evaluate(() => {
      hiddenSimpleTest.ui.destroy();
      hiddenSimpleTest.host.remove();
      delete window.hiddenSimpleTest;
    });
  });
  await step("device-loss", async () => {
    await mode("advanced");
    await page.setViewportSize({ width: 1560, height: 1000 });
    await page.evaluate(() => {
      styk.editor.newDocument();
      styk.workspace.reset();
      styk.fit();
    });
    await settle();
    await page.locator('[data-tool="select"]').click();
    const p = await canvasPoint(
      await page.evaluate(() => ({
        x: styk.editor.object.root_x,
        y: styk.editor.object.root_y,
      })),
    );
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 10, p.y + 10, { steps: 3 });
    const held = await page.evaluate(() => ({
      drag: styk.state.drag?.kind,
      dragging: !!styk.editor.dragging,
    }));
    await page.evaluate(() => styk.state.renderer.device.destroy());
    await page.locator("#retry-renderer").waitFor({ state: "visible" });
    const lost = await page.evaluate(() => ({
      drag: styk.state.drag?.kind,
      dragging: !!styk.editor.dragging,
      root: [styk.editor.object.root_x, styk.editor.object.root_y],
      backend: styk.state.renderer.stats.backend,
    }));
    await page.mouse.move(p.x + 35, p.y + 30, { steps: 3 });
    const moved = await page.evaluate(() => ({
      drag: styk.state.drag?.kind,
      dragging: !!styk.editor.dragging,
      root: [styk.editor.object.root_x, styk.editor.object.root_y],
    }));
    check(
      "Device loss exposes a clear reconnect action",
      lost.backend === "WebGPU device lost",
    );
    check(
      "Device loss cancels active edits and blocks stale pointer movement",
      !lost.drag &&
        !lost.dragging &&
        JSON.stringify(moved.root) === JSON.stringify(lost.root),
      { held, lost, moved },
    );
    await page.mouse.up();
    await page.screenshot({ path: `${out}/device-lost.png` });
    await page.locator("#retry-renderer").click();
    await page.waitForFunction(
      () =>
        styk.state.renderer.stats.backend === "WebGPU" &&
        document.querySelector("#renderer-error").hidden,
    );
    check("Reconnect restores WebGPU canvas and clears error", true);
    await settle();
  });
  await step("loss-keyboard-properties", async () => {
    await page.locator("#viewport").focus();
    const before = await page.evaluate(() => ({
      root: styk.editor.object.root_x,
      undo: styk.editor._undo.length,
    }));
    await page.keyboard.down("ArrowRight");
    const held = await page.evaluate(() => !!styk.editor.dragging);
    await page.evaluate(() => styk.state.renderer.device.destroy());
    await page.locator("#retry-renderer").waitFor({ state: "visible" });
    await page.keyboard.up("ArrowRight");
    await settle();
    check(
      "Device loss cancels held keyboard gesture without committing history",
      held &&
        (await page.evaluate(
          (before) =>
            !styk.editor.dragging &&
            styk.editor.object.root_x === before.root &&
            styk.editor._undo.length === before.undo,
          before,
        )),
    );
    const p = await canvasPoint(
      await page.evaluate(() => ({
        x: styk.editor.object.root_x,
        y: styk.editor.object.root_y,
      })),
    );
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 30, p.y + 20);
    await page.mouse.up();
    await page.locator("#viewport").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    check(
      "Disconnected canvas rejects new pointer and keyboard editing",
      await page.evaluate(
        (before) =>
          !styk.state.drag &&
          !styk.editor.dragging &&
          !styk.state.playing &&
          styk.editor.object.root_x === before.root,
        before,
      ),
    );
    await page.locator("#retry-renderer").click();
    await page.waitForFunction(
      () =>
        styk.state.renderer.stats.backend === "WebGPU" &&
        document.querySelector("#renderer-error").hidden,
    );
    await settle();
    const scrub = page.locator(
      '#inspector [data-property-row="root_x"] [data-property-scrub]',
    );
    await scrub.scrollIntoViewIfNeeded();
    const r = await scrub.boundingBox(),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2,
      old = await page.evaluate(() => ({
        root: styk.editor.object.root_x,
        undo: styk.editor._undo.length,
      }));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 18, y, { steps: 5 });
    const active = await page.evaluate(() => !!styk.properties.gesture);
    await page.evaluate(() => styk.state.renderer.device.destroy());
    await page.locator("#retry-renderer").waitFor({ state: "visible" });
    await page.mouse.up();
    await settle();
    check(
      "Device loss cancels inspector scrub and restores value without history",
      active &&
        (await page.evaluate(
          (old) =>
            !styk.properties.gesture &&
            !styk.editor.dragging &&
            styk.editor.object.root_x === old.root &&
            styk.editor._undo.length === old.undo,
          old,
        )),
    );
    await page.locator("#retry-renderer").click();
    await page.waitForFunction(
      () =>
        styk.state.renderer.stats.backend === "WebGPU" &&
        document.querySelector("#renderer-error").hidden,
    );
  });
  await step("loss-space", async () => {
    await mode("simple");
    await page.locator("#viewport").focus();
    const frames = await page.evaluate(
      () => styk.editor.report.keyframes.length,
    );
    await page.keyboard.down("Space");
    await page.evaluate(() => styk.state.renderer.device.destroy());
    await page.locator("#retry-renderer").waitFor({ state: "visible" });
    await page.keyboard.up("Space");
    await settle();
    check(
      "Device loss clears held Space without adding a Simple frame",
      await page.evaluate(
        (frames) =>
          !styk.state.space &&
          !styk.state.playing &&
          styk.editor.report.keyframes.length === frames,
        frames,
      ),
    );
    await page.locator("#retry-renderer").click();
    await page.waitForFunction(
      () =>
        styk.state.renderer.stats.backend === "WebGPU" &&
        document.querySelector("#renderer-error").hidden,
    );
  });
  await step("compatibility", async () => {
    const fallback = await browser.newPage({
      viewport: { width: 1100, height: 740 },
    });
    try {
      await fallback.addInitScript(() =>
        Object.defineProperty(navigator, "gpu", { get: () => undefined }),
      );
      await fallback.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
      await fallback.waitForFunction(() => window.styk?.ready);
      const label = await fallback.locator("#renderer-label").evaluate((e) => ({
        text: e.textContent,
        title: e.title,
        display: getComputedStyle(e).display,
        backend: styk.state.renderer.stats.backend,
      }));
      check(
        "Unavailable WebGPU reveals stable compatibility label and reason",
        label.text === "Compatibility mode" &&
          label.title.includes("unavailable") &&
          label.display !== "none" &&
          label.backend === "Canvas 2D fallback",
        label,
      );
      await fallback.evaluate(() => styk.editor.moveSelection(10, 0));
      await fallback.waitForTimeout(60);
      check(
        "Compatibility label remains stable while editing",
        (await fallback.locator("#renderer-label").textContent()) ===
          "Compatibility mode",
      );
      await fallback.screenshot({ path: `${out}/compatibility-1100.png` });
    } finally {
      await fallback.close();
    }
  });
} finally {
  check("No uncaught page errors in walkthrough", errors.length === 0, errors);
  await writeFile(
    `${out}/report${requestedSteps ? "-" + requestedSteps.join("-") : ""}.json`,
    JSON.stringify(
      {
        checks,
        defects,
        errors,
        details,
        scope:
          "Integrated usability checks; not a complete parity or physical presentation latency claim.",
      },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(JSON.stringify({ checks: checks.length, defects, errors }));
if (defects.length) process.exitCode = 1;
