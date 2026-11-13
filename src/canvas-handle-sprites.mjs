const TAU = Math.PI * 2;
/** Parts of a backing pixel a handle's centre is placed to, along each axis: a stamp sits within an eighth of a backing
 * pixel of where its path would be, and every handle look has at most `STEPS²` pictures. */
export const STEPS = 4;
const SHIFT = Math.log2(STEPS);
/** The atlas's side in backing pixels (4 MB): a busy frame needs a few hundred cells, a zoom as many again each frame. It
 * doubles once (16 MB) when one pass needs more (many sizes of joint, large handles at a high device-pixel ratio). */
const ATLAS_SIZE = 1024, ATLAS_LIMIT = 2048;

/** The colour a handle's outline is stroked in, or `null` when it has none. */
export const handleStroke = (handle, outline) => handle.ik ? '#0d99ff' : outline ? '#000000' : null;

/** Adds a handle's shape to the path: a circle, or a diamond for a connector. */
function trace(context, connector, x, y, radius) {
  if (connector) {
    context.moveTo(x, y - radius); context.lineTo(x + radius, y);
    context.lineTo(x, y + radius); context.lineTo(x - radius, y); context.closePath();
  } else { context.moveTo(x + radius, y); context.arc(x, y, radius, 0, TAU); }
}

/** Paints one handle at `point` (canvas units) as a path: the shape every stamp is a picture of. */
export function paintCanvasHandle(context, handle, point, outline = false) {
  context.beginPath();
  trace(context, handle.connector, point.x, point.y, handle.screenRadius);
  context.fillStyle = handle.color;
  context.lineWidth = 1;
  context.fill();
  const stroke = handleStroke(handle, outline);
  if (stroke) { context.strokeStyle = stroke; context.stroke(); }
}

/**
 * The handles' pictures, painted once and stamped. Two paths a joint (fill, outline) cost the graphics process far more
 * than copying a small picture: 3,200 joints held a busy scene at 30 frames a second. Each look (shape, size, fill,
 * outline) is painted at each `STEPS`-th of a backing pixel into one atlas, and a handle is stamped at whole backing pixels
 * from the picture of its centre's fraction, so a stamp is the path's own pixels within an eighth of a backing pixel of
 * where the path was, never resampled. Stamps from one atlas batch into a few draws; source-over over the picture is the
 * fill and then the outline over it, as before.
 *
 * Bounded: one atlas of `size²` backing pixels, emptied when full (a zoom makes new sizes every frame) or when the
 * device-pixel ratio changes, and made larger once, up to `limit²`, when one pass needs more. A pass that needs more cells
 * than that holds paints the rest as paths.
 */
export class HandleSprites {
  /** `make(width, height)`: a canvas made like the surfaces stamped on (a browser paints a canvas it reads back on the CPU). */
  constructor(make, {size = ATLAS_SIZE, limit = Math.max(size, ATLAS_LIMIT)} = {}) {
    this.make = make; this.size = size; this.limit = limit; this.atlas = null; this.context = null; this.dpr = 0;
    this.looks = new Map(); this.count = 0; this.shelves = []; this.bottom = 0; this.resets = 0;
    this.cellOf = this.dx = this.dy = new Int32Array(0); this.missing = [];
  }
  /** Forgets every picture (keeps the atlas). */
  reset(dpr = this.dpr) {
    this.dpr = dpr; this.looks.clear(); this.count = 0; this.shelves = []; this.bottom = 0; this.resets++;
    if (this.context) { this.context.setTransform(1, 0, 0, 1, 0, 0); this.context.clearRect(0, 0, this.size, this.size); }
  }
  /** The look of `handle`: found by its size, then its colour, then its shape and outline, with no key to build (a
   * pass asks once per handle, thousands of times). */
  look(handle, outline) {
    const radius = handle.screenRadius, connector = Boolean(handle.connector), stroke = handleStroke(handle, outline);
    let colors = this.looks.get(radius);
    if (!colors) this.looks.set(radius, colors = new Map());
    let kinds = colors.get(handle.color);
    if (!kinds) colors.set(handle.color, kinds = new Array(6));
    const kind = (connector ? 3 : 0) + (stroke === null ? 0 : stroke === '#000000' ? 1 : 2);
    let look = kinds[kind];
    if (!look) {
      // Coverage reaches the shape's edge, half the outline (a diamond's miter √2 times more) and a pixel of antialiasing.
      const extent = radius * this.dpr + (stroke ? this.dpr : 0) + 1, pad = Math.ceil(extent);
      kinds[kind] = look = {connector, radius, fill: handle.color, stroke, pad, size: 2 * pad + 1, cells: new Int32Array(STEPS * STEPS).fill(-1)};
      this.count++;
    }
    return look;
  }
  /** Every look with pictures. */
  *allLooks() { for (const colors of this.looks.values()) for (const kinds of colors.values()) for (const look of kinds) if (look) yield look; }
  /** A free cell of `size` backing pixels as `y·size + x` of its corner, or -1 when the atlas is full. */
  allocate(size) {
    const cell = size + 1;
    for (const shelf of this.shelves)
      if (shelf.height === cell && shelf.x + cell <= this.size) { const x = shelf.x; shelf.x += cell; return shelf.y * this.size + x; }
    if (this.bottom + cell > this.size || cell > this.size) return -1;
    const shelf = {y: this.bottom, height: cell, x: cell};
    this.shelves.push(shelf); this.bottom += cell;
    return shelf.y * this.size;
  }
  /** The look whose picture holds atlas pixel `x, y`, or undefined (for tests). */
  lookAt(x, y) {
    for (const look of this.allLooks()) for (const cell of look.cells) {
      const sx = cell % this.size, sy = (cell - sx) / this.size;
      if (cell >= 0 && x >= sx && x < sx + look.size && y >= sy && y < sy + look.size) return look;
    }
    return undefined;
  }
  /**
   * Paints `count` handles, `handles[i]` centred at canvas units `xs[i], ys[i]`, in order, on `context` (its transform
   * and styles are restored). `dpr` is the context's backing pixels per canvas unit. With `crop` (`{x, y, width, height}`
   * in whole backing pixels) only those pixels are painted: each stamp is cut to them, so they are a full repaint's exactly
   * (a clip, even on whole pixels, blends through its coverage and moves some pixels a level).
   */
  paint(context, handles, xs, ys, count, {dpr, outline = false, crop = null}) {
    if (!count) return;
    if (dpr !== this.dpr) this.reset(dpr);
    if (!this.atlas) {
      this.atlas = this.make(this.size, this.size);
      this.context = this.atlas.getContext('2d');
    }
    if (this.cellOf.length < count) {
      const length = Math.max(count, 2 * this.cellOf.length);
      this.cellOf = new Int32Array(length); this.dx = new Int32Array(length); this.dy = new Int32Array(length);
    }
    // Every picture this pass needs is painted before the first stamp: painting the atlas between stamps from it would
    // have the graphics process copy it.
    // A full atlas starts again once a pass (a zoom makes new sizes every frame); what one pass alone cannot fit is a path.
    const held = this.shelves.length > 0;
    let fits = this.resolve(handles, xs, ys, count, outline);
    if (!fits && held) { this.reset(); fits = this.resolve(handles, xs, ys, count, outline); }
    if (!fits && this.size < this.limit) {
      // Resizing a canvas empties it.
      this.size = Math.min(this.limit, 2 * this.size); this.atlas.width = this.atlas.height = this.size;
      this.reset(); this.resolve(handles, xs, ys, count, outline);
    }
    this.render();
    const atlas = this.atlas, size = this.size, cellOf = this.cellOf, looks = this.lastLooks, dxs = this.dx, dys = this.dy;
    const left = crop ? crop.x : -Infinity, top = crop ? crop.y : -Infinity,
      right = crop ? crop.x + crop.width : Infinity, bottom = crop ? crop.y + crop.height : Infinity;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < count; i++) {
      const cell = cellOf[i];
      if (cell < 0) {
        // The atlas cannot hold this pass's pictures: the path, as the stamp would have been.
        context.save();
        if (crop) { context.beginPath(); context.rect(crop.x, crop.y, crop.width, crop.height); context.clip(); }
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintCanvasHandle(context, handles[i], {x: xs[i], y: ys[i]}, outline);
        context.restore();
        continue;
      }
      const look = looks[i], s = look.size, sx = cell % size, sy = (cell - sx) / size, dx = dxs[i] - look.pad, dy = dys[i] - look.pad;
      if (!crop) { context.drawImage(atlas, sx, sy, s, s, dx, dy, s, s); continue; }
      const x0 = Math.max(dx, left), y0 = Math.max(dy, top), x1 = Math.min(dx + s, right), y1 = Math.min(dy + s, bottom);
      if (x1 > x0 && y1 > y0) context.drawImage(atlas, sx + x0 - dx, sy + y0 - dy, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    context.restore();
  }
  /** Finds or allocates each handle's cell; false when the atlas ran out (those handles have -1). */
  resolve(handles, xs, ys, count, outline) {
    const dpr = this.dpr, cellOf = this.cellOf, dxs = this.dx, dys = this.dy, looks = this.lastLooks = this.lastLooks?.length >= count ? this.lastLooks : new Array(count);
    let fits = true;
    this.missing.length = 0;
    for (let i = 0; i < count; i++) {
      const look = this.look(handles[i], outline);
      looks[i] = look;
      // The centre in quarters of a backing pixel, rounded: its whole pixel places the stamp, its fraction picks the picture.
      const X = Math.floor(xs[i] * dpr * STEPS + .5), Y = Math.floor(ys[i] * dpr * STEPS + .5);
      const variant = (Y & (STEPS - 1)) * STEPS + (X & (STEPS - 1));
      dxs[i] = X >> SHIFT; dys[i] = Y >> SHIFT;
      let cell = look.cells[variant];
      if (cell === -1) {
        cell = this.allocate(look.size);
        if (cell < 0) { fits = false; cellOf[i] = -1; continue; }
        look.cells[variant] = cell;
        this.missing.push(look, variant, cell);
      }
      cellOf[i] = cell;
    }
    return fits;
  }
  /** Paints the pictures `resolve` allocated, each its own path as a handle was: a path of several shapes antialiases a
   * level or two apart, so a picture would depend on what was painted with it. */
  render() {
    const missing = this.missing;
    if (!missing.length) return;
    const context = this.context, size = this.size, dpr = this.dpr;
    context.lineWidth = 1;
    let fill = null, stroke = null;
    for (let i = 0; i < missing.length; i += 3) {
      const look = missing[i], variant = missing[i + 1], cell = missing[i + 2], sx = cell % size, sy = (cell - sx) / size;
      // In canvas units, scaled to backing pixels, as the overlay painted a handle: the path antialiases the same way.
      context.setTransform(dpr, 0, 0, dpr, sx + look.pad + (variant % STEPS) / STEPS, sy + look.pad + Math.floor(variant / STEPS) / STEPS);
      context.beginPath();
      trace(context, look.connector, 0, 0, look.radius);
      // A style is set only when it changes: the context parses a colour on every set.
      if (fill !== look.fill) context.fillStyle = fill = look.fill;
      context.fill();
      if (look.stroke) {
        if (stroke !== look.stroke) context.strokeStyle = stroke = look.stroke;
        context.stroke();
      }
    }
    missing.length = 0;
  }
}
