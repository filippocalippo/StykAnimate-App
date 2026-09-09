/** Edit portable native text without substituting an unavailable font. */
import {
  textOptionsWithDefaults,
  pathBounds,
  textBounds,
  svgPath,
} from "./text-authoring.mjs";
const clone = (value) => structuredClone(value),
  f32 = Math.fround;
const normalized = (text) => String(text ?? "").replace(/\r\n?/g, "\n");
const assetId = (asset) => Number(asset.asset_index ?? asset.table_index ?? 0);
const metadataFor = (figure, index) => {
  const metadata = figure?._styk?.textAuthoring;
  return metadata && (metadata.assetIndex ?? 0) === index ? metadata : {};
};
const textSegments = (figure, index) =>
  figure.segments.filter(
    (segment) =>
      (segment.primitive_code === 5 || segment.segment_type === "text") &&
      Number(segment.extra_u16 ?? segment.extra?.[0] ?? 0) === index,
  );
export function textAssetFor(figure, index) {
  const wanted = index ?? figure?._styk?.textAuthoring?.assetIndex;
  return wanted === undefined
    ? figure?.text_assets?.[0]
    : figure?.text_assets?.find((asset) => assetId(asset) === Number(wanted));
}
export const canEditTextFigure = (figure) =>
  Boolean(textAssetFor(figure)?.glyphs?.length);
export class MissingTextGlyphsError extends Error {
  constructor(missing, family) {
    super(
      `Choose a font to add ${missing.map((char) => `“${char}”`).join(", ")}. The file only includes the characters used by ${family}.`,
    );
    this.name = "MissingTextGlyphsError";
    this.missing = missing;
  }
}
function sourceMetrics(asset, metadata = {}) {
  const advances = { ...metadata.glyphAdvances },
    pairs = new Map(),
    values = new Map();
  for (let i = 0; i < asset.placements.length - 1; i++) {
    const a = asset.placements[i],
      b = asset.placements[i + 1],
      dx = b.x - a.x;
    if (a.visible && b.visible && Math.abs(a.y - b.y) < 0.01 && dx > 0) {
      pairs.set(`${a.utf16_code_unit}:${b.utf16_code_unit}`, dx);
      const pool = values.get(a.utf16_code_unit) ?? [];
      pool.push(dx);
      values.set(a.utf16_code_unit, pool);
    }
  }
  const height = Math.max(
    1,
    ...asset.glyphs.map((g) => (g.bounds ? g.bounds.bottom - g.bounds.top : 0)),
  );
  for (const glyph of asset.glyphs) {
    const unit = glyph.utf16_code_unit,
      pool = values.get(unit)?.sort((a, b) => a - b);
    advances[unit] ??=
      pool?.[Math.floor(pool.length / 2)] ??
      (glyph.bounds
        ? Math.max(1, glyph.bounds.right - glyph.bounds.left + height * 0.1)
        : height * 0.35);
  }
  const rows = [
      ...new Set(asset.placements.filter((p) => p.visible).map((p) => p.y)),
    ].sort((a, b) => a - b),
    gaps = rows
      .slice(1)
      .map((y, i) => y - rows[i])
      .filter((y) => y > 0.01);
  return {
    advances,
    pairs,
    height,
    space: metadata.spaceAdvance ?? advances[32] ?? height * 0.35,
    lineGap: gaps.length
      ? Math.min(...gaps)
      : (metadata.fontSize ?? height) * (metadata.lineHeight ?? 1.4),
  };
}
export function readTextFigureOptions(figure, { assetIndex } = {}) {
  const asset = textAssetFor(figure, assetIndex);
  if (!asset) throw new Error("Select a text figure.");
  const index = assetId(asset),
    segment = textSegments(figure, index)[0] ?? figure.segments[0],
    style = figure.segment_decode?.global_style ?? {},
    meta = metadataFor(figure, index);
  const fontSize = meta.fontSize ?? asset.font_size;
  return {
    text: normalized(asset.text),
    name: figure.name || "Text",
    fontFamily: asset.font_name || meta.fontFamily || "Embedded font",
    fontSize: fontSize ?? 48,
    fontSizeKnown: Number.isFinite(fontSize),
    embeddedScale: 100,
    fontOrigin: meta.fontOrigin ?? "embedded",
    bold: Boolean(asset.font_style & 1),
    italic: Boolean(asset.font_style & 2),
    alignment:
      { 0: "center", 1: "left", 2: "right" }[asset.alignment] ?? "left",
    lineHeight: meta.lineHeight ?? 1.2,
    color: clone(segment.color_rgb ?? [43, 43, 43]),
    opacity: 1 - (segment.transparency ?? 0) / 255,
    ...(segment.paint ? {paint:clone(segment.paint)} : {}),
    gradientColor: segment.secondary ? clone(segment.secondary.rgb) : null,
    outlineWidth: style.outline_thickness ?? 0,
    outlineColor: clone(style.rgb ?? [0, 0, 0]),
    figureTypeId: figure.figure_type_id,
    assetIndex: index,
  };
}
function updatePaint(figure, options, index, widthRatio) {
  for (const segment of textSegments(figure, index)) {
    segment.length = f32(segment.length * widthRatio);
    if (options.paint) segment.paint = clone(options.paint);
    segment.color_rgb = clone(options.color);
    segment.transparency = Math.round((1 - options.opacity) * 255);
    segment.color_alpha = 1 - segment.transparency / 255;
    segment.secondary = options.gradientColor
      ? { rgb: clone(options.gradientColor), a: options.paint ? Math.round((1-options.paint.stops.at(-1).opacity)*255) : segment.transparency }
      : null;
  }
  figure.segment_decode ??= {};
  const style = (figure.segment_decode.global_style ??= {
    u28: 0,
    rgb: [0, 0, 0],
    u30: 0,
  });
  style.outline_thickness = f32(options.outlineWidth);
  style.rgb = clone(options.outlineColor);
  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, options.outlineWidth, true);
  style.u28 = bits.getUint32(0, true);
}
function installAsset(figure, asset, index) {
  figure.text_assets = figure.text_assets.map((value) =>
    assetId(value) === index ? asset : value,
  );
  if (figure.side_tables)
    figure.side_tables = figure.side_tables.map((value) =>
      value.kind === "text" && assetId(value) === index ? asset : value,
    );
}

export function compileEmbeddedTextFigure(options, sourceFigure) {
  const initial = readTextFigureOptions(sourceFigure, {
      assetIndex: options?.assetIndex,
    }),
    o = textOptionsWithDefaults(
      { ...initial, ...options },
      { normalizeText: false },
    ),
    original = textAssetFor(sourceFigure, initial.assetIndex);
  if (o.bold !== initial.bold || o.italic !== initial.italic)
    throw new Error(
      "Choose a font face to change bold or italic. Embedded glyph outlines retain their original style.",
    );
  const factor = initial.fontSizeKnown
    ? o.fontSize / initial.fontSize
    : Number(options?.embeddedScale ?? 100) / 100;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 40)
    throw new Error(
      "Embedded text scale must be greater than zero and at most 4,000%.",
    );
  const source = new Map(original.glyphs.map((g) => [g.utf16_code_unit, g])),
    missing = [...new Set(o.text)].filter(
      (char) =>
        !source.has(char.charCodeAt(0)) && ![" ", "\t", "\n"].includes(char),
    );
  if (missing.length)
    throw new MissingTextGlyphsError(missing, initial.fontFamily);
  const figure = clone(sourceFigure),
    asset = clone(original),
    sameText = normalized(original.text) === o.text,
    sameLayout =
      sameText &&
      o.alignment === initial.alignment &&
      o.lineHeight === initial.lineHeight;
  let approximate = false;
  if (!sameLayout || factor !== 1) {
    const text = sameLayout ? original.text : o.text,
      unique = [...new Set(text.split("").map((char) => char.charCodeAt(0)))],
      byUnit = new Map(unique.map((unit, i) => [unit, i]));
    asset.text = text;
    asset.glyphs = unique.map((unit) => {
      const glyph = clone(
        source.get(unit) ?? {
          utf16_code_unit: unit,
          commands: [],
          node_count: 0,
          bounds: null,
          svg_path: "",
        },
      );
      glyph.commands = glyph.commands.map((command) => ({
        ...command,
        values: command.values.map((value) => f32(value * factor)),
      }));
      glyph.bounds = pathBounds(glyph.commands);
      glyph.svg_path = svgPath(glyph.commands);
      return glyph;
    });
    if (sameLayout)
      asset.placements = original.placements.map((p) => ({
        ...p,
        glyph_index: byUnit.get(p.utf16_code_unit),
        x: p.visible ? f32(p.x * factor) : 0,
        y: p.visible ? f32(p.y * factor) : 0,
      }));
    else {
      const metrics = sourceMetrics(
          original,
          metadataFor(sourceFigure, initial.assetIndex),
        ),
        lines = o.text.split("\n").map((line) => {
          const offsets = [];
          let width = 0;
          for (let i = 0; i < line.length; i++) {
            offsets.push(width);
            const unit = line.charCodeAt(i),
              next = line.charCodeAt(i + 1),
              pair = metrics.pairs.get(`${unit}:${next}`);
            let advance = pair ?? metrics.advances[unit];
            if (advance === undefined) {
              advance = line[i] === "\t" ? metrics.space * 4 : metrics.space;
              approximate = true;
            } else if (
              pair === undefined &&
              !metadataFor(sourceFigure, initial.assetIndex).glyphAdvances?.[
                unit
              ]
            )
              approximate = true;
            width += advance * factor;
          }
          return { line, offsets, width };
        });
      const width = Math.max(...lines.map((line) => line.width)),
        placements = [],
        lineGap =
          metrics.lineGap * (o.lineHeight / initial.lineHeight) * factor;
      const place = (unit, x, y) => {
        const glyph_index = byUnit.get(unit),
          visible = asset.glyphs[glyph_index].commands.length > 0;
        placements.push({
          character_index: placements.length,
          utf16_code_unit: unit,
          glyph_index,
          visible,
          x: visible ? f32(x) : 0,
          y: visible ? f32(y) : 0,
        });
      };
      lines.forEach(({ line, offsets, width: lineWidth }, row) => {
        const dx =
          o.alignment === "right"
            ? width - lineWidth
            : o.alignment === "center"
              ? (width - lineWidth) / 2
              : 0;
        for (let i = 0; i < line.length; i++)
          place(line.charCodeAt(i), offsets[i] + dx, row * lineGap);
        if (row < lines.length - 1) place(10, 0, 0);
      });
      asset.placements = placements;
    }
    asset.bounds = textBounds(asset.glyphs, asset.placements);
    asset.svg_path = asset.placements
      .filter((p) => p.visible)
      .map((p) => svgPath(asset.glyphs[p.glyph_index].commands, p.x, p.y))
      .join(" ");
    asset.normalized_svg_path = asset.placements
      .filter((p) => p.visible)
      .map((p) =>
        svgPath(
          asset.glyphs[p.glyph_index].commands,
          p.x - asset.bounds.left,
          p.y - asset.bounds.bottom,
        ),
      )
      .join(" ");
    asset.alignment = { left: 1, center: 0, right: 2 }[o.alignment];
    delete asset.source_start;
    delete asset.source_end;
  }
  if (initial.fontSizeKnown) asset.font_size = o.fontSize;
  updatePaint(
    figure,
    o,
    initial.assetIndex,
    asset.bounds.width / original.bounds.width,
  );
  installAsset(figure, asset, initial.assetIndex);
  figure.name = o.name;
  figure.figure_type_id = o.figureTypeId;
  figure._styk = {
    ...figure._styk,
    textAuthoring: {
      ...metadataFor(sourceFigure, initial.assetIndex),
      ...o,
      fontFamily: initial.fontFamily,
      fontOrigin: "embedded",
      assetIndex: initial.assetIndex,
      fontSizeKnown: initial.fontSizeKnown,
      embeddedScale: 100,
      spacingEstimated: approximate,
    },
  };
  if (!initial.fontSizeKnown) delete figure._styk.textAuthoring.fontSize;
  if (factor !== 1) {
    const metadata = figure._styk.textAuthoring;
    if (metadata.glyphAdvances)
      metadata.glyphAdvances = Object.fromEntries(
        Object.entries(metadata.glyphAdvances).map(([unit, value]) => [
          unit,
          value * factor,
        ]),
      );
    if (metadata.spaceAdvance !== undefined) metadata.spaceAdvance *= factor;
  }
  return figure;
}

/** Apply explicitly chosen font outlines while retaining non-text parts of a native rig. */
export function replaceTextAssetFigure(
  sourceFigure,
  compiled,
  { assetIndex } = {},
) {
  const initial = readTextFigureOptions(sourceFigure, { assetIndex }),
    figure = clone(sourceFigure),
    original = textAssetFor(sourceFigure, initial.assetIndex),
    asset = clone(compiled.text_assets[0]),
    o = compiled._styk.textAuthoring;
  asset.asset_index = initial.assetIndex;
  asset.table_index = initial.assetIndex;
  updatePaint(
    figure,
    o,
    initial.assetIndex,
    asset.bounds.width / original.bounds.width,
  );
  installAsset(figure, asset, initial.assetIndex);
  figure.name = compiled.name;
  figure._styk = {
    ...figure._styk,
    textAuthoring: {
      ...o,
      fontOrigin: "custom",
      assetIndex: initial.assetIndex,
    },
  };
  return figure;
}
