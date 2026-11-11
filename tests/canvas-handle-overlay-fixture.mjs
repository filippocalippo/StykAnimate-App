import {CanvasHandleOverlay, paintCanvasHandle} from '../src/canvas-handle-overlay.mjs';

/** A canvas read back often. Every canvas compared is one, so all paint the same way: a browser may paint a canvas it
 * does not read on the GPU, which blends some pixels apart from the CPU (Electron does, by up to a whole channel). */
function readable(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d', {willReadFrequently: true});
  return canvas;
}

/** Browser-callable exact-pixel comparison of local damage against the former
 * full handle pass. No renderer, document caches or application UI required.
 */
export function verifyCanvasHandleOverlay() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const checks = [];
  const handle = (uid, x, y, color, extra = {}) => ({uid, point: {x, y}, screenRadius: 5, color, ...extra});
  const grouped = groups => {
    const handles = groups.flatMap(group => group.handles);
    Object.defineProperty(handles, 'groups', {value: groups}); return handles;
  };
  for (const dpr of [1, 1.5, 2]) for (const outline of [false, true]) {
    const width = 240, height = 140, surface = readable(width * dpr, height * dpr);
    const overlay = new CanvasHandleOverlay(readable(1, 1)), context = surface.getContext('2d');
    const reference = readable(width * dpr, height * dpr), expected = reference.getContext('2d');
    let projected = 0, transform = point => point;
    const project = point => { projected++; return transform(point); };
    const draw = (groups, name, {projectionKey = 'view', translations} = {}) => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const stats = overlay.draw(context, grouped(groups), {project, projectionKey, width, height, dpr, outline, translations});
      expected.setTransform(dpr, 0, 0, dpr, 0, 0); expected.clearRect(0, 0, width, height);
      for (const group of groups) if (!translations?.has(group.uid))
        for (const item of group.handles) paintCanvasHandle(expected, item, transform(item.point), outline);
      if (translations) for (const group of groups) for (const item of group.handles) {
        const delta = translations.get(item.uid); if (!delta) continue;
        paintCanvasHandle(expected, item, transform({x: item.point.x + delta.x, y: item.point.y + delta.y}), outline);
      }
      const actualPixels = context.getImageData(0, 0, surface.width, surface.height).data,
        expectedPixels = expected.getImageData(0, 0, reference.width, reference.height).data;
      for (let i = 0; i < actualPixels.length; i++)
        check(actualPixels[i] === expectedPixels[i], `${name}, DPR ${dpr}, outline ${outline}: pixel byte ${i} differs (${actualPixels[i]} vs ${expectedPixels[i]})`);
      checks.push({name, dpr, outline, ...stats}); return stats;
    };
    const bottom = {uid: 1, handles: [handle(1, 35, 35, '#ff0000'), handle(1, 100, 90, '#ff8800')]},
      top = {uid: 2, handles: [handle(2, 37, 36, '#0000ff'), handle(2, -4, 70, '#12b886', {connector: true, ik: true})]},
      outside = {uid: 3, handles: [handle(3, -100, -100, '#7048e8'), handle(3, 500, 500, '#7048e8')]};
    draw([bottom, top, outside], 'initial native painter order and clipped edge handles');
    projected = 0;
    const unchanged = draw([bottom, top, outside], 'unchanged groups reuse all projected handles');
    check(unchanged.regions === 0 && projected === 0, 'Unchanged handles must not repaint/project');
    const changed = {uid: 1, handles: [handle(1, 36, 36, '#e64980'), bottom.handles[1]]};
    projected = 0;
    const sparse = draw([changed, top, outside], 'sparse lower-group edit restores overlapping upper artwork');
    check(!sparse.full && projected === changed.handles.length, 'Sparse poses must only project the changed group');
    const small = {uid: 1, handles: [handle(1, 40, 42, '#ff0000')]};
    draw([small, top, outside], 'removed handle clears its old pixels');
    const removed = {uid: 1, handles: [handle(1, 600, 400, '#ff0000')]};
    draw([removed, top, outside], 'moving a group outside clears its old pixels');
    draw([top, outside, small], 'native group reordering');
    draw([small, top], 'native group removal');
    const translations = new Map([[1, {x: 30, y: 10}]]);
    draw([small, top], 'translation excludes selected group from retained layer', {translations});
    translations.set(1, {x: 60, y: 20});
    draw([small, top], 'translation-only update');
    draw([small, top], 'translation release restores native order');
    transform = point => ({x: 150 - point.y, y: point.x});
    check(draw([small, top], 'rotated view invalidates the projected layer', {projectionKey: 'rotation'}).full,
      'A changed view must repaint the layer');
    overlay.clear(); check(draw([small, top], 'document/style invalidation releases retained groups').full,
      'An invalidated overlay must rebuild');
  }
  checks.push(...verifyPans());
  return {checks};
}

/** A pan moves the retained pixels and paints the strips that came into view: the picture must be the full repaint's, pixel
 * for pixel, at the translation the overlay says it painted at (the one asked for, after an exact pan or once the view rests). */
function verifyPans() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const checks = [];
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const colors = ['#ff0000', '#ff8800', '#0000ff', '#0080ff', '#ffffff', '#808080'];
  // Handles inside, across and well outside the view, overlapping in native order; connectors and IK among them.
  // Figures: clusters of joints, some across the view's edges or outside it.
  const groups = Array.from({length: 24}, (_, g) => {
    const cx = random() * 420 - 90, cy = random() * 300 - 80;
    const handles = Array.from({length: 14}, () => ({uid: g + 1, point: {x: cx + random() * 50 - 25, y: cy + random() * 50 - 25},
      screenRadius: 2 + random() * 4, color: colors[Math.floor(random() * colors.length)], connector: random() < .1, ik: random() < .1}));
    return {uid: g + 1, handles};
  });
  const grouped = list => { const handles = list.flatMap(group => group.handles); Object.defineProperty(handles, 'groups', {value: list}); return handles; };
  for (const dpr of [1, 1.25, 1.5, 2]) for (const outline of [false, true]) for (const linear of [[1, 0, 0, 1], [.8, .3, -.3, .8]]) {
    const width = 240, height = 140, surface = readable(width * dpr, height * dpr), context = surface.getContext('2d');
    const reference = readable(width * dpr, height * dpr), expected = reference.getContext('2d');
    const overlay = new CanvasHandleOverlay(readable(1, 1));
    // What a full repaint at translation `at` paints, as backing pixels.
    const fresh = (list, at) => {
      expected.setTransform(dpr, 0, 0, dpr, 0, 0); expected.clearRect(0, 0, width, height);
      for (const group of list) for (const handle of group.handles) {
        const p = handle.point;
        const px = linear[0] * p.x + linear[2] * p.y + at.x, py = linear[1] * p.x + linear[3] * p.y + at.y, radius = handle.screenRadius + 1;
        if (px + radius > 0 && px - radius < width && py + radius > 0 && py - radius < height) paintCanvasHandle(expected, handle, {x: px, y: py}, outline);
      }
      return expected.getImageData(0, 0, reference.width, reference.height).data;
    };
    let before = null;
    /** `moved`: the pixels outside the strips a pan of whole backing pixels brought in must be the picture before, moved. */
    const draw = (list, x, y, name, {moved = false, rest = false} = {}) => {
      const from = overlay.at;
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const stats = overlay.draw(context, grouped(list), {matrix: [...linear, x, y], projectionKey: 'view', width, height, dpr, outline, rest});
      const at = overlay.at, actual = context.getImageData(0, 0, surface.width, surface.height).data, full = fresh(list, at);
      check(Math.abs(at.x - x) * dpr <= .5 + 1e-9 && Math.abs(at.y - y) * dpr <= .5 + 1e-9, `${name}: painted within half a backing pixel of where asked`);
      check(stats.settle || at.x === x && at.y === y, `${name}: a draw that does not ask to settle paints exactly where asked`);
      const kx = moved ? Math.round((at.x - from.x) * dpr) : 0, ky = moved ? Math.round((at.y - from.y) * dpr) : 0, w = surface.width, h = surface.height;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const strip = moved && (kx > 0 ? px < kx : px >= w + kx) || moved && (ky > 0 ? py < ky : py >= h + ky);
        const i = 4 * (py * w + px), source = !moved || strip ? full : before, j = !moved || strip ? i : 4 * ((py - ky) * w + px - kx);
        for (let k = 0; k < 4; k++) check(actual[i + k] === source[j + k],
          `${name}, DPR ${dpr}, outline ${outline}, linear ${linear}: pixel ${px},${py} channel ${k} differs from the ${!moved ? 'full repaint' : strip ? 'full repaint in the new strip' : 'picture before, moved'} (${actual[i + k]} vs ${source[j + k]})`);
      }
      before = actual;
      checks.push({name, dpr, outline, linear, ...stats});
      return stats;
    };
    let x = 3, y = 2;
    draw(groups, x, y, 'pan start');
    // Whole backing pixels each way, then parts of one, each moved by the nearest whole backing pixel.
    for (const [dx, dy, name] of [[4 / dpr, 0, 'one-way pan'], [-6 / dpr, 5 / dpr, 'diagonal pan'], [0, -9 / dpr, 'vertical pan'],
      [7, -3, 'CSS-pixel pan'], [2.3, 1.7, 'fractional pan'], [-5.1, .4, 'fractional pan back']]) {
      x += dx; y += dy;
      const stats = draw(groups, x, y, name, {moved: true});
      check(!stats.full && stats.shifted && stats.settle, `${name}: a pan moves the retained pixels instead of repainting`);
    }
    check(!draw(groups, x, y, 'the same translation again, not yet resting', {moved: true}).full, 'Only a rest repaints in full');
    const resting = draw(groups, x, y, 'the view rests', {rest: true});
    check(resting.full && !resting.settle && overlay.at.x === x && overlay.at.y === y, 'Once the view rests the joints are a full repaint, exactly where asked');
    // A pan with a pose change: the moved group's damage and the strips both repaint.
    const moved = groups.map((group, index) => index === 3 ? {uid: group.uid, handles: group.handles.map(handle => ({...handle, point: {x: handle.point.x + 6, y: handle.point.y - 4}}))} : group);
    x += 5; y -= 4;
    const changed = overlay.draw(context, grouped(moved), {matrix: [...linear, x, y], projectionKey: 'view', width, height, dpr, outline});
    check(changed.shifted && !changed.full, 'A pan with a pose change still moves the retained pixels');
    check(draw(moved, x, y, 'rest after a pan with a pose change', {rest: true}).full, 'Resting after a pan with a pose change repaints in full');
    x += width * 2;
    check(draw(moved, x, y, 'pan past the view').full, 'A pan past the whole view repaints');
  }
  return checks;
}
