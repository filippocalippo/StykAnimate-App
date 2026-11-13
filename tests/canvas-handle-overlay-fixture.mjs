import {CanvasHandleOverlay} from '../src/canvas-handle-overlay.mjs';
import {HandleSprites, paintCanvasHandle, STEPS} from '../src/canvas-handle-sprites.mjs';

/** What a full repaint paints for each `[handle, point]` of `list`, in order: a stamp of each from `sprites`. A full repaint
 * of the overlay is compared with its own pictures: a picture painted elsewhere in an atlas can antialias a level apart
 * (the shape's points round differently in floating point), as a path painted elsewhere on the canvas does. */
function stamps(context, list, dpr, outline, sprites) {
  sprites.paint(context, list.map(([handle]) => handle), list.map(([, point]) => point.x), list.map(([, point]) => point.y), list.length, {dpr, outline});
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
      const list = [];
      for (const group of groups) if (!translations?.has(group.uid)) for (const item of group.handles) list.push([item, transform(item.point)]);
      if (translations) for (const group of groups) for (const item of group.handles) {
        const delta = translations.get(item.uid); if (!delta) continue;
        list.push([item, transform({x: item.point.x + delta.x, y: item.point.y + delta.y})]);
      }
      stamps(expected, list, dpr, outline, overlay.sprites);
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
  return checks;
}

/** A canvas read back often. Every canvas the pan checks compare is one, so all paint the same way: a browser may paint a
 * canvas it does not read on the GPU, which blends some pixels apart from the CPU (Electron does, by up to a whole channel). */
function readable(width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d', {willReadFrequently: true});
  return canvas;
}

/** A pan moves the retained pixels and paints the strips that came into view: the picture must be the full repaint's, pixel
 * for pixel, at the translation the overlay says it painted at (the one asked for, after an exact pan or once the view rests). */
export function verifyCanvasHandlePans() {
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
      const shown = [];
      for (const group of list) for (const handle of group.handles) {
        const p = handle.point;
        const px = linear[0] * p.x + linear[2] * p.y + at.x, py = linear[1] * p.x + linear[3] * p.y + at.y, radius = handle.screenRadius + 1;
        if (px + radius > 0 && px - radius < width && py + radius > 0 && py - radius < height) shown.push([handle, {x: px, y: py}]);
      }
      stamps(expected, shown, dpr, outline, overlay.sprites);
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

/** The stamps against the paths the overlay painted before them, on canvases read back (CPU) and not (GPU, where the
 * browser has one): sizes, colours and device-pixel ratios, outlines on and off, connectors and IK markers. A handle whose
 * centre is on a quarter of a backing pixel is stamped from a picture of the path at that place; anywhere else it is placed
 * at most an eighth of a backing pixel from it, which changes the antialiasing of its edge pixels and nothing else.
 * Answers, for each case, the largest difference of a channel and how many pixels differ. */
export function verifyCanvasHandleStamps() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const checks = [];
  let seed = 3;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const colors = ['#ff0000', '#ff8800', '#0000ff', '#0080ff', '#ffffff', '#d3d3d3', '#808080', '#b04040'];
  for (const cpu of [true, false]) for (const dpr of [1, 1.25, 1.5, 2]) for (const outline of [false, true]) for (const quarters of [true, false]) {
    // Handles on a grid, apart (where two overlap, a moved edge mixes one colour for another): every size the settings allow.
    const width = 320, height = 240, list = [];
    for (let y = 12; y < height - 12; y += 24) for (let x = 12; x < width - 12; x += 24) {
      const handle = {screenRadius: 2 + random() * 8, color: colors[Math.floor(random() * colors.length)], connector: random() < .15, ik: random() < .15};
      const point = quarters ? {x: Math.round((x + random()) * dpr * STEPS) / STEPS / dpr, y: Math.round((y + random()) * dpr * STEPS) / STEPS / dpr}
        : {x: x + random(), y: y + random()};
      list.push([handle, point]);
    }
    // Backing pixels apart: the paths are also painted this far right and down, to see how far a path differs from itself
    // moved by whole backing pixels (the rasteriser rounds a shape's points differently in another place).
    const shift = 37, w = Math.round(width * dpr), h = Math.round(height * dpr);
    const make = (extra = 0) => { const canvas = new OffscreenCanvas(w + extra, h + extra); canvas.getContext('2d', {willReadFrequently: cpu}); return canvas; };
    const stamped = make(), painted = make(), moved = make(shift), a = stamped.getContext('2d'), b = painted.getContext('2d'), c = moved.getContext('2d');
    stamps(a, list, dpr, outline, new HandleSprites((width, height) => {
      const canvas = new OffscreenCanvas(width, height); canvas.getContext('2d', {willReadFrequently: cpu}); return canvas;
    }));
    b.setTransform(dpr, 0, 0, dpr, 0, 0); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const [handle, point] of list) {
      paintCanvasHandle(b, handle, point, outline);
      paintCanvasHandle(c, handle, {x: point.x + shift / dpr, y: point.y + shift / dpr}, outline);
    }
    const paths = b.getImageData(0, 0, w, h).data;
    const compare = (pixels, stride, offset) => {
      let covered = 0, apart = 0, far = 0, coverage = 0, pathCoverage = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = 4 * (y * w + x), j = 4 * ((y + offset) * stride + x + offset);
        // Premultiplied, as the canvas holds them: unpremultiplied, a pixel of alpha 1 has only 0 or 255 for a colour.
        let most = Math.abs(pixels[j + 3] - paths[i + 3]);
        for (let k = 0; k < 3; k++) most = Math.max(most, Math.round(Math.abs(pixels[j + k] * pixels[j + 3] - paths[i + k] * paths[i + 3]) / 255));
        if (pixels[j + 3] || paths[i + 3]) covered++;
        if (most > 2) apart++;
        if (most > 48) far++;
        coverage += pixels[j + 3]; pathCoverage += paths[i + 3];
      }
      return {covered, apart, far, coverage: coverage / pathCoverage};
    };
    const result = compare(a.getImageData(0, 0, w, h).data, w, 0), control = compare(c.getImageData(0, 0, w + shift, h + shift).data, w + shift, shift);
    checks.push({name: `${cpu ? 'CPU' : 'GPU'}, DPR ${dpr}, outline ${outline}, ${quarters ? 'centres on quarters' : 'centres anywhere'}`, quarters, ...result, control});
  }
  // On a quarter, a stamp is the path but for edge pixels where the shape's points round differently: no more of them than a
  // path moved by whole backing pixels has (and a little slack). Anywhere, an edge moves by up to an eighth of a backing
  // pixel, which changes its pixels a little and seldom much. Never does a stamp cover more or less than the path: it is not
  // resampled, so not softer.
  const failures = checks.filter(({quarters, covered, apart, far, coverage, control}) =>
    (quarters ? apart > 1.5 * control.apart + .005 * covered || far > 1.5 * control.far + .001 * covered : apart > .5 * covered || far > .03 * covered) ||
    Math.abs(coverage - 1) > .01);
  check(!failures.length, `Stamps against paths, pixels that differ by more than two and more than 48 levels (a path moved by whole pixels):\n${
    failures.map(({name, covered, apart, far, coverage, control}) =>
      `${name}: ${apart} and ${far} of ${covered} (${control.apart} and ${control.far}), coverage ${coverage.toFixed(4)}`).join('\n')}`);
  return checks;
}
