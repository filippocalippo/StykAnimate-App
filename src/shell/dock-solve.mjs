/**
 * The docking solver: fits an arrangement (dock-model.mjs) into the window.
 * Pure and deterministic; the host applies the solution in one commit and
 * nothing it computes is ever written back to the arrangement.
 *
 * The window's chrome keeps today's numbers (layout-solver.mjs: the tiers,
 * the band and its folds, the field's padding and gaps, the stage header,
 * the tool bar, the timeline's rows and default height), so the default
 * arrangement lands on today's rectangles.
 *
 * Along each split, fixed children take their stored size (or their panels'
 * preferred size), flexible ones share the rest by weight, never under their
 * minimum; a shortage shrinks fixed children toward their minimum first.
 * Small windows then fold, without changing the arrangement:
 *   - the width tier (compact, minimal) and the touch profile fold groups
 *     beside the stage: those on its left to strips, those on its right and
 *     floats to the sheet the band's Properties button opens;
 *   - the low height tier folds groups above or below the stage to their
 *     header (the timeline's body then opens as a sheet);
 *   - while the stage is still under its minimum (360×200 below its header),
 *     groups fold in today's order: left ones to strips, right ones to
 *     strips, right ones to the sheet, left ones to the sheet; and above or
 *     below it, to their headers.
 */
import {PANEL_CATALOG} from './panel-registry.mjs';
import {STAGE, walk} from './dock-model.mjs';
import {SHELL_METRICS, TIER_THRESHOLDS, chromeFor, fitZoom, resolveTiers, stageInsetsFor, timelineDefaultHeight, timelineHeightFor} from './layout-solver.mjs';

/** A strip's width beside the stage, and a folded group's header height above or below it. */
export const STRIP = 40;
export const HEADER = 40;
/** Side panels' height limits in a column (they keep their tab row and a few rows of controls). */
const SIDE_MIN_HEIGHT = 160, SIDE_PREF_HEIGHT = 320;
/** The timeline's width limits beside the stage (its layer names and a few frames). */
const TIMELINE_MIN_WIDTH = 360, TIMELINE_PREF_WIDTH = 480;
/** Floats keep this much of themselves on screen, and at least this size. */
const FLOAT_KEEP = 80, FLOAT_MIN = {w: 200, h: 120};

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const dimension = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const rect = (x, y, width, height) => ({x, y, width: Math.max(0, width), height: Math.max(0, height)});

/**
 * Solves an arrangement for a window. `env`:
 *   width, height     the #app box in CSS px
 *   mode              animate, draw or rig
 *   footer            px kept under the workspace (the status bar)
 *   bandMin           the band's measured fold widths (layout-solver resolveTiers)
 *   measured          {band, stageHead} heights measured in the app
 *   metrics           SHELL_METRICS, with the timeline painter's rows (dock-host paintedMetrics)
 *   railColumns       1 or 2 (the tool bar's measured columns)
 *   touch             the touch mode's state ({active, form, orient})
 *   panels            the panel catalogue
 * Returns the window's chrome as layout-solver did (tier, height, chrome,
 * padTop, band, touch, rail, stage, stageHead, viewport, stageInsets,
 * timelineRows, messageSlot, rects, zoom) and the arrangement's geometry:
 *   groups     [{id, state: docked|strip|header, rect, tabs, active, axis, side, timeline}]
 *   dividers   [{key, path, a, b, axis, rect, now, min, max, kinds}]
 *   floats     [{id, rect, collapsed, tabs, active}]
 *   sheet      panel ids folded into the band's sheet
 *   panels     {[id]: {presentation, group, active, visible}}
 * Every rect is in the #app box's coordinates.
 */
export function solveDock(layout, env = {}) {
  const catalog = env.panels ?? PANEL_CATALOG;
  const metrics = env.metrics ?? SHELL_METRICS;
  const width = dimension(env.width), height = dimension(env.height);
  const known = new Map(catalog.map(panel => [panel.id, panel]));
  const touch = env.touch?.active ? metrics.touch?.[env.touch.form] ?? null : null;
  const {tier, height: heightTier, band: bandFolds} = resolveTiers(width, height, {bandMin: touch?.ownBand ? 0 : env.bandMin, thresholds: env.tiers ?? TIER_THRESHOLDS, bandMargin: metrics.bandMargin});
  const across = metrics.width[tier], down = metrics.height[heightTier];
  const chrome = chromeFor(height, metrics);
  const gapX = across.columnGap, gapY = down.rowGap;
  const padEnd = Math.min(across.padEnd, Math.floor(width / 2)), padBottom = down.padBottom, padTop = Math.min(chrome.padTop, padBottom);
  const band = Math.min(env.measured?.band ?? chrome.band, height);
  const head = env.measured?.stageHead ?? chrome.stageHead;
  const workspaceHeight = Math.max(0, height - band - dimension(env.footer));
  const inner = rect(padEnd, band + padTop, width - 2 * padEnd, workspaceHeight - padTop - padBottom);
  const stageMin = touch?.stageMin ?? metrics.stageMin;
  const t = touch?.timelineHeader ? {...metrics.timeline, header: touch.timelineHeader} : metrics.timeline;
  const rowMetrics = t === metrics.timeline ? metrics : {...metrics, timeline: t};
  const portrait = touch && env.touch.orient === 'portrait' ? touch.portraitTimeline ?? null : null;
  const landscape = touch && env.touch.orient === 'landscape' ? touch.landscapeTimeline ?? null : null;

  // ---- What each group holds and its limits ----
  const shown = group => group.tabs.filter(id => known.has(id));
  const isTimeline = group => shown(group).length === 1 && shown(group)[0] === 'timeline';
  const timelineMin = landscape ?? Math.max(timelineHeightFor(t.minSlots, heightTier, rowMetrics), known.get('timeline')?.min ?? 0);
  const timelineDefault = portrait ? Math.round(portrait * height) : landscape ?? timelineDefaultHeight(height, heightTier, rowMetrics);
  const timelineMax = Math.min(Math.floor((known.get('timeline')?.maxFraction ?? 0.6) * height), down.timeline?.capAtDefault && !portrait && !landscape ? timelineDefault : Infinity);
  const sideDefault = across.dock?.right ?? 320;
  function panelLimits(id, axis) {
    const panel = known.get(id);
    if (id === 'timeline') {
      return axis === 'row' ? {min: TIMELINE_MIN_WIDTH, pref: TIMELINE_PREF_WIDTH, max: Infinity} : {min: timelineMin, pref: timelineDefault, max: timelineMax};
    }
    if (axis === 'column') return {min: SIDE_MIN_HEIGHT, pref: SIDE_PREF_HEIGHT, max: Infinity};
    // Structure keeps its own width (232); the inspector's panels take the tier's column (320, 296, 256).
    const pref = panel?.sizeKey ? panel.pref ?? sideDefault : sideDefault;
    return {min: panel?.min ?? 0, pref: clamp(pref, panel?.min ?? 0, panel?.max ?? Infinity), max: panel?.max ?? Infinity};
  }
  function groupLimits(group, axis) {
    const ids = shown(group);
    const parts = ids.map(id => panelLimits(id, axis));
    const min = Math.max(0, ...parts.map(part => part.min));
    const max = Math.max(min, Math.min(...parts.map(part => part.max)));
    // A group with tabs keeps its tab row on top of its panel.
    const header = axis === 'column' && !isTimeline(group) ? 40 : 0;
    const pref = Math.max(0, ...parts.map(part => part.pref));
    return {min: min + (ids.includes('timeline') && !isTimeline(group) ? header : 0), pref, max};
  }

  // ---- Folds ----
  // `fold` maps a group id to 'strip' (a strip beside the stage, or its header above or below it) or 'sheet'.
  const fold = new Map();
  const groups = [];
  walk(layout.root, node => { if (node.type === 'group' && shown(node).length) groups.push(node); });
  for (const group of groups) if (group.collapsed) fold.set(group.id, 'strip');

  /** A node's limits along `axis` given the current folds; null when it takes no room. Memoized per placement. */
  let memo = new Map();
  function limits(node, axis) {
    let entry = memo.get(node);
    if (!entry) memo.set(node, entry = {});
    if (!(axis in entry)) entry[axis] = computeLimits(node, axis);
    return entry[axis];
  }
  function computeLimits(node, axis) {
    if (node.type === STAGE) {
      const min = axis === 'row' ? stageMin.width : stageMin.height + head;
      return {min, pref: min, max: Infinity, flex: 1};
    }
    if (node.type === 'group') {
      if (!shown(node).length || fold.get(node.id) === 'sheet') return null;
      if (fold.get(node.id) === 'strip') {
        const extent = axis === 'row' ? STRIP : isTimeline(node) ? t.header : HEADER;
        return {min: extent, pref: extent, max: extent, strip: true};
      }
      const own = groupLimits(node, axis);
      const pref = clamp(node.size ?? own.pref, own.min, own.max);
      return {...own, pref, flex: node.flex};
    }
    const parts = node.children.map(child => limits(child, axis)).filter(Boolean);
    if (!parts.length) return null;
    const gap = axis === 'row' ? gapX : gapY;
    if (node.axis === axis) {
      const gaps = gap * (parts.length - 1);
      const min = parts.reduce((sum, part) => sum + part.min, gaps);
      const pref = node.size ?? parts.reduce((sum, part) => sum + part.pref, gaps);
      const anyFlex = parts.some(part => part.flex);
      const max = anyFlex ? Infinity : parts.reduce((sum, part) => sum + part.max, gaps);
      return {min, pref: clamp(pref, min, max), max, flex: node.flex};
    }
    const min = Math.max(...parts.map(part => part.min));
    const pref = node.size ?? Math.max(...parts.map(part => part.pref));
    const max = parts.some(part => part.flex || part.max === Infinity) ? Infinity : Math.max(...parts.map(part => part.max));
    return {min, pref: clamp(pref, min, max), max, flex: node.flex};
  }

  /** Lays a split's visible children along its axis; returns [{child, index, extent, info}]. */
  function distribute(node, length) {
    const axis = node.axis, gap = axis === 'row' ? gapX : gapY;
    const items = node.children.map((child, index) => ({child, index, info: limits(child, axis)})).filter(item => item.info);
    const available = Math.max(0, length - gap * (items.length - 1));
    const fixed = items.filter(item => !item.info.flex);
    const flex = items.filter(item => item.info.flex);
    for (const item of fixed) item.extent = item.info.pref;
    const flexMin = flex.reduce((sum, item) => sum + item.info.min, 0);
    let rest = available - fixed.reduce((sum, item) => sum + item.extent, 0);
    if (rest < flexMin) {
      // Fixed children give way toward their minimum, those farthest from the flexible ones first.
      let deficit = flexMin - rest;
      const order = [...fixed].filter(item => !item.info.strip).sort((a, b) => distanceToFlex(b) - distanceToFlex(a));
      for (const item of order) {
        if (deficit <= 0) break;
        const give = Math.min(deficit, item.extent - item.info.min);
        item.extent -= give;
        deficit -= give;
      }
      rest = available - fixed.reduce((sum, item) => sum + item.extent, 0);
    }
    function distanceToFlex(item) {
      return Math.min(...flex.map(other => Math.abs(other.index - item.index)), Infinity);
    }
    if (flex.length) {
      let pool = Math.max(0, rest), open = [...flex];
      // Weights share the rest; a child its share would put under its minimum takes the minimum instead.
      for (let pass = 0; pass < flex.length && open.length; pass++) {
        const weight = open.reduce((sum, item) => sum + item.info.flex, 0);
        const under = open.filter(item => (pool * item.info.flex) / weight < item.info.min);
        if (!under.length) break;
        for (const item of under) { item.extent = item.info.min; pool -= item.info.min; }
        open = open.filter(item => !under.includes(item));
      }
      const weight = open.reduce((sum, item) => sum + item.info.flex, 0);
      let given = 0;
      open.forEach((item, at) => {
        const share = at === open.length - 1 ? Math.max(0, pool - given) : Math.round(Math.max(0, pool) * item.info.flex / weight);
        item.extent = share;
        given += share;
      });
    } else if (rest > 0 && items.length) {
      // Nothing flexible: the last group that is not a strip takes what is left.
      const taker = [...items].reverse().find(item => !item.info.strip) ?? items.at(-1);
      taker.extent += rest;
    }
    const used = items.reduce((sum, item) => sum + item.extent, 0);
    if (used > available + 0.5) {
      placed.overflow[axis] = true;
      // What cannot fit comes off the flexible children (the stage), never past the window.
      let excess = used - available;
      for (const item of [...flex].reverse()) {
        const give = Math.min(excess, item.extent);
        item.extent -= give;
        excess -= give;
      }
    }
    return items;
  }

  let placed;
  function place() {
    placed = {groups: new Map(), stage: null, dividers: [], overflow: {row: false, column: false}};
    memo = new Map();
    const visit = (node, box, path, axis = null) => {
      if (node.type === STAGE) { placed.stage = box; return; }
      if (node.type === 'group') { placed.groups.set(node.id, {node, box, axis}); return; }
      const items = distribute(node, node.axis === 'row' ? box.width : box.height);
      const gap = node.axis === 'row' ? gapX : gapY;
      let offset = node.axis === 'row' ? box.x : box.y;
      items.forEach((item, at) => {
        const child = node.axis === 'row' ? rect(offset, box.y, item.extent, box.height) : rect(box.x, offset, box.width, item.extent);
        item.box = child;
        visit(item.child, child, [...path, item.index], node.axis);
        offset += item.extent + gap;
        const next = items[at + 1];
        if (next && !item.info.strip && !next.info.strip) {
          const position = offset - gap;
          placed.dividers.push({path, a: item.index, b: next.index, axis: node.axis, at: position, gap, box, items: [item, next]});
        }
      });
    };
    visit(layout.root, inner, []);
  }

  const sideOf = box => {
    const s = placed.stage;
    if (!s || !box) return 'right';
    if (box.x + box.width <= s.x + 1) return 'left';
    if (box.x >= s.x + s.width - 1) return 'right';
    if (box.y >= s.y + s.height - 1) return 'bottom';
    return 'top';
  };

  const stageHolders = new Set();
  (function mark(node) {
    if (node.type === STAGE) return true;
    if (node.type !== 'split') return false;
    let holds = false;
    for (const child of node.children) if (mark(child)) holds = true;
    if (holds) stageHolders.add(node);
    return holds;
  })(layout.root);
  const holdsStage = node => node.type === STAGE || stageHolders.has(node);
  place();
  // Tier and touch folds, decided on the unfolded arrangement so a fold never moves another group's side.
  const tierFold = {...(across.fold ?? {}), ...(down.fold ?? {}), ...(touch?.fold ?? {})};
  const sides = new Map(groups.map(group => [group.id, sideOf(placed.groups.get(group.id)?.box)]));
  for (const group of groups) {
    const side = sides.get(group.id);
    const to = side === 'top' ? tierFold.bottom : tierFold[side];
    // A phone's timeline stays docked (its profile sizes it); the low tier folds it to its header.
    if (isTimeline(group) && (portrait || landscape)) continue;
    if (to === 'sheet' && (side === 'left' || side === 'right')) fold.set(group.id, 'sheet');
    else if (to === 'strip' && !fold.has(group.id)) fold.set(group.id, 'strip');
  }
  place();
  const reasons = new Map();
  for (const group of groups) if (fold.has(group.id) && !group.collapsed) reasons.set(group.id, 'tier');
  // Shortfall: fold in today's order until the stage holds its minimum.
  const short = () => placed.overflow.column || (placed.stage && placed.stage.height - head < stageMin.height);
  const widthShort = () => placed.overflow.row || (placed.stage && placed.stage.width < stageMin.width);
  const order = side => groups.filter(group => sides.get(group.id) === side)
    .sort((a, b) => distance(placed.groups.get(b.id)?.box) - distance(placed.groups.get(a.id)?.box));
  const distance = box => (box && placed.stage ? Math.abs((box.x + box.width / 2) - (placed.stage.x + placed.stage.width / 2)) + Math.abs((box.y + box.height / 2) - (placed.stage.y + placed.stage.height / 2)) : 0);
  // Narrowing happens as fixed groups give way (distribute); the steps are the folds.
  const steps = (touch?.collapse ?? metrics.collapse?.width ?? []).filter(([, to]) => to === 'strip' || to === 'sheet');
  for (const [side, to] of steps) {
    for (const group of order(side)) {
      if (!widthShort()) break;
      const now = fold.get(group.id);
      if (to === 'strip' && now) continue;
      if (to === 'sheet' && now === 'sheet') continue;
      fold.set(group.id, to);
      reasons.set(group.id, 'stage');
      place();
    }
  }
  for (const side of ['bottom', 'top']) {
    for (const group of order(side)) {
      if (!short()) break;
      if (fold.get(group.id)) continue;
      fold.set(group.id, 'strip');
      reasons.set(group.id, 'stage');
      place();
    }
  }

  // ---- The stage, the tool bar and the chrome ----
  const stage = placed.stage ?? inner;
  const stageHead = Math.min(head, stage.height);
  const viewport = rect(stage.x, stage.y + stageHead, stage.width, stage.height - stageHead);
  const railCompact = !touch && Boolean(across.compactRail || down.compactRail || chrome.name === 'compact');
  const railColumns = env.railColumns === 2 ? 2 : 1, railBase = touch ? touch.rail : railCompact ? metrics.rail.compact : metrics.rail.width;
  const railWidth = Math.min(railColumns === 2 ? 2 * railBase - 8 : railBase, width);
  const railLeft = layout.tools !== 'right';
  const railMargin = touch?.railMargin ?? metrics.rail.margin ?? 0;
  const railHorizontal = Boolean(touch && env.touch.orient === 'portrait' && touch.portraitRail === 'horizontal');
  const railRect = railHorizontal
    ? rect(viewport.x + railMargin, viewport.y + viewport.height - railMargin - railBase, Math.max(0, viewport.width - 2 * railMargin), railBase)
    : rect(railLeft ? viewport.x + railMargin : viewport.x + viewport.width - railMargin - railWidth, viewport.y + railMargin, railWidth, Math.max(0, viewport.height - 2 * railMargin));
  const stageInsets = stageInsetsFor(width, height, {tier, metrics});
  const railSide = railHorizontal ? 'bottom' : railLeft ? 'left' : 'right';
  stageInsets[railSide] = Math.max(stageInsets[railSide], (railHorizontal ? railBase : railWidth) + railMargin + 8);
  const message = metrics.message, endWidth = env.endWidth ?? message.end;
  const messageSlot = {width: Math.max(0, across.message === 'inset' ? stage.width - 2 * message.inset : stage.width - 2 * (endWidth + message.gap))};

  // ---- Groups, dividers, floats and the sheet ----
  const outGroups = [];
  const sheet = [];
  const panels = {};
  for (const panel of catalog) panels[panel.id] = {presentation: 'unavailable', group: null, active: false, visible: false};
  const present = (ids, presentation, group, active) => {
    for (const id of ids) panels[id] = {presentation, group, active: id === active, visible: presentation === 'docked' || presentation === 'float' ? id === active : false};
  };
  for (const group of groups) {
    const ids = shown(group);
    const active = ids.includes(group.active) ? group.active : ids[0];
    const state = fold.get(group.id);
    if (state === 'sheet') { sheet.push(...ids); present(ids, 'sheet', group.id, active); continue; }
    const {box} = placed.groups.get(group.id) ?? {};
    if (!box) continue;
    const parent = placed.groups.get(group.id)?.axis ?? null;
    const strip = state === 'strip';
    const shape = strip ? (box.width <= STRIP + 0.5 && parent === 'row' ? 'strip' : 'header') : 'docked';
    outGroups.push({id: group.id, state: shape, rect: box, tabs: ids, active, axis: parent, side: sides.get(group.id),
      timeline: isTimeline(group), collapsed: Boolean(group.collapsed), reason: reasons.get(group.id) ?? null});
    present(ids, strip ? 'strip' : 'docked', group.id, active);
  }
  const dividers = placed.dividers.map(divider => {
    const [a, b] = divider.items;
    const extent = item => (divider.axis === 'row' ? item.box.width : item.box.height);
    const kind = item => (item.info.flex ? 'flex' : 'fixed');
    // The divider resizes the fixed side (the one without the stage when both are fixed), or both flexible sides.
    const aStage = holdsStage(a.child), bStage = holdsStage(b.child);
    const control = kind(a) === 'fixed' && (kind(b) === 'flex' || bStage || !aStage) ? 'a' : kind(b) === 'fixed' ? 'b' : 'a';
    const mine = control === 'a' ? a : b, other = control === 'a' ? b : a;
    const now = extent(mine);
    const min = Math.round(mine.info.min);
    const max = Math.round(Math.max(min, Math.min(mine.info.max, now + extent(other) - other.info.min)));
    const thickness = Math.max(8, divider.gap + 4);
    const box = divider.axis === 'row'
      ? rect(divider.at + divider.gap / 2 - thickness / 2, divider.box.y, thickness, divider.box.height)
      : rect(divider.box.x, divider.at + divider.gap / 2 - thickness / 2, divider.box.width, thickness);
    return {key: `${divider.path.join('.')}:${divider.a}`, path: divider.path, a: divider.a, b: divider.b, axis: divider.axis, rect: box,
      control, now: Math.round(now), min, max: Math.max(min, max), kinds: [kind(a), kind(b)], extents: [Math.round(extent(a)), Math.round(extent(b))],
      tabs: [...collectTabs(a.child), ...collectTabs(b.child)].filter(id => known.has(id)),
      controlTabs: collectTabs(mine.child).filter(id => known.has(id)), controlGroup: firstGroup(mine.child)};
  });
  const floatSheet = (touch?.fold ?? across.fold ?? {}).float === 'sheet';
  const floats = [];
  const top = band;
  for (const float of layout.floats ?? []) {
    const ids = shown(float.group);
    if (!ids.length) continue;
    const active = ids.includes(float.group.active) ? float.group.active : ids[0];
    if (floatSheet) { sheet.push(...ids); present(ids, 'sheet', float.group.id, active); continue; }
    const collapsed = Boolean(float.group.collapsed);
    const w = clamp(float.rect.w, Math.min(FLOAT_MIN.w, width), Math.max(FLOAT_MIN.w, width - 2 * padEnd));
    const fullHeight = clamp(float.rect.h, Math.min(FLOAT_MIN.h, workspaceHeight), Math.max(FLOAT_MIN.h, workspaceHeight - 2 * padTop));
    const h = collapsed ? HEADER : fullHeight;
    const x = clamp(float.rect.x, Math.min(0, FLOAT_KEEP - w), width - FLOAT_KEEP);
    const y = clamp(top + float.rect.y, top, top + workspaceHeight - HEADER);
    floats.push({id: float.id, group: float.group.id, rect: rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)), collapsed, tabs: ids, active});
    present(ids, 'float', float.group.id, active);
    if (collapsed) for (const id of ids) panels[id].visible = false;
  }
  for (const item of layout.closed ?? []) if (known.has(item.id)) panels[item.id] = {presentation: 'hidden', group: null, active: false, visible: false};

  const timelineGroup = outGroups.find(group => group.tabs.includes('timeline') && group.state === 'docked' && group.active === 'timeline');
  const timelineFloat = floats.find(float => float.active === 'timeline' && !float.collapsed);
  const timelineBox = timelineGroup ? {height: timelineGroup.rect.height - (timelineGroup.timeline ? 0 : 40)} : timelineFloat ? {height: timelineFloat.rect.height - 40} : null;
  const bodyRows = size => {
    const rows = down.timeline ?? metrics.height.tall.timeline;
    const body = size - t.header - rows.ruler;
    const pinned = clamp(Math.floor(body / t.pinnedRow), 0, t.pinned);
    return {pinned, content: Math.max(0, Math.floor((body - pinned * t.pinnedRow) / rows.row * 2) / 2)};
  };
  const solution = {
    mode: env.mode, tier, height: heightTier, chrome: chrome.name, padTop, band: bandFolds, touch: touch ? env.touch.form : null,
    rail: {side: railLeft ? 'left' : 'right', orientation: railHorizontal ? 'horizontal' : 'vertical', compact: railCompact,
      columns: railHorizontal ? 1 : railColumns, width: railHorizontal ? railRect.width : railWidth, rect: railRect},
    inner, gaps: {x: gapX, y: gapY}, stage, stageHead, viewport, stageInsets,
    timelineRows: timelineBox ? bodyRows(timelineBox.height) : {pinned: 0, content: 0},
    messageSlot, groups: outGroups, dividers, floats, sheet, panels,
    rects: {band: rect(0, 0, width, band), workspace: rect(0, band, width, workspaceHeight), rail: railRect, stage, viewport},
  };
  if (env.artboard) solution.zoom = fitZoom(viewport, stageInsets, env.artboard);
  return solution;
}

function firstGroup(node) {
  let id = null;
  walk(node, child => { if (!id && child.type === 'group') id = child.id; });
  return id;
}

function collectTabs(node) {
  const ids = [];
  walk(node, child => { if (child.type === 'group') ids.push(...child.tabs); });
  return ids;
}


/** The divider's new sizes for its split's children when it is dragged to `value` px on its controlled side. */
export function dividerChanges(divider, value) {
  const size = Math.round(clamp(value, divider.min, divider.max));
  const [ka, kb] = divider.kinds;
  if (ka === 'flex' && kb === 'flex') {
    // Two flexible neighbours keep their combined weight; their extents set the shares.
    const total = divider.extents[0] + divider.extents[1];
    const a = divider.control === 'a' ? size : total - size;
    return {[divider.a]: {flex: Math.max(0.05, a / Math.max(1, total)) * 2}, [divider.b]: {flex: Math.max(0.05, (total - a) / Math.max(1, total)) * 2}};
  }
  if (ka === 'fixed' && kb === 'fixed') {
    const total = divider.extents[0] + divider.extents[1];
    const a = divider.control === 'a' ? size : total - size;
    return {[divider.a]: {size: a}, [divider.b]: {size: total - a}};
  }
  return {[divider.control === 'a' ? divider.a : divider.b]: {size}};
}

/** The divider's reset: the controlled side back to its default (fixed), or equal shares (flexible). */
export function dividerReset(divider) {
  const [ka, kb] = divider.kinds;
  if (ka === 'flex' && kb === 'flex') return {[divider.a]: {flex: 1}, [divider.b]: {flex: 1}};
  if (ka === 'fixed' && kb === 'fixed') return {[divider.a]: null, [divider.b]: null};
  return {[divider.control === 'a' ? divider.a : divider.b]: null};
}
