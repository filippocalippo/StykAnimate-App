import {normalizePaint} from './paint.mjs';
/** Portable Pivot text: every visible character is stored as embedded vector paths. */
import { parse } from "../vendor/text/opentype.mjs";
import { applyWindowsSymbolMapping } from "./text-font-compat.mjs";

export const TEXT_FONT_FAMILY = "Noto Sans";
export const MAX_TEXT_LENGTH = 16384;
const FONT_FILES = ["Regular", "Bold", "Italic", "BoldItalic"];
const fontCache = new Map();
const f32 = Math.fround;
export const MAX_FONT_BYTES = 32 * 1024 * 1024;
const localizedName = (value) =>
  typeof value === "string"
    ? value
    : value?.en ||
      Object.values(value || {}).find((v) => typeof v === "string");
export const textFontFamily = (font) =>
  localizedName(font?.names?.preferredFamily) ||
  localizedName(font?.names?.fontFamily) ||
  "Custom font";

/** Font bytes stay in the authoring session. Export stores outlines, not font dependencies. */
export function parseTextFont(bytes, { name = "Font file" } = {}) {
  const data =
    bytes instanceof ArrayBuffer
      ? bytes
      : ArrayBuffer.isView(bytes)
        ? bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          )
        : null;
  if (!data || !data.byteLength || data.byteLength > MAX_FONT_BYTES)
    throw new Error("Choose a TTF or OTF font smaller than 32 MB.");
  let font;
  try {
    font = applyWindowsSymbolMapping(parse(data), data);
  } catch (error) {
    throw new Error(
      `Could not read ${name}. Choose a TrueType (.ttf) or OpenType (.otf) outline font.`,
      { cause: error },
    );
  }
  if (!font.unitsPerEm || typeof font.charToGlyph !== "function")
    throw new Error("The font has no usable outlines.");
  const flags = font.tables?.os2?.fsSelection ?? 0;
  return {
    font,
    family: textFontFamily(font),
    style:
      localizedName(font.names?.preferredSubfamily) ||
      localizedName(font.names?.fontSubfamily) ||
      "Regular",
    bold: Boolean(flags & 32),
    italic: Boolean(flags & 1),
    name,
  };
}
export async function loadTextFontFile(file) {
  if (!file || typeof file.arrayBuffer !== "function")
    throw new Error("Choose a TTF or OTF font file.");
  if (file.size > MAX_FONT_BYTES)
    throw new Error("Choose a font smaller than 32 MB.");
  return parseTextFont(await file.arrayBuffer(), {
    name: file.name || "Font file",
  });
}

/** Loads a bundled OFL font once. No installed fonts, network service, or Canvas text API. */
export async function loadTextFont({ bold = false, italic = false } = {}) {
  const style = Number(!!bold) | (Number(!!italic) << 1);
  if (!fontCache.has(style)) {
    const pending = fetch(
      new URL(
        `../vendor/text/NotoSans-${FONT_FILES[style]}.ttf`,
        import.meta.url,
      ),
    )
      .then((response) => {
        if (!response.ok)
          throw new Error(
            `Could not load the bundled ${TEXT_FONT_FAMILY} font (${response.status}).`,
          );
        return response.arrayBuffer();
      })
      .then((buffer) => parse(buffer));
    fontCache.set(style, pending);
    pending.catch(() => fontCache.delete(style));
  }
  return fontCache.get(style);
}

const number = (value, label, min, max) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
};
const rgb = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    throw new Error(`${label} must contain three RGB bytes.`);
  return [...value];
};
const label = (value) =>
  String(value || "Text")
    .replace(
      /[\x00-\x1f\x7f]|[^\u0020-\u007e\u00a0-\u00ff\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]/g,
      "_",
    )
    .trim()
    .slice(0, 180) || "Text";

export function textOptionsWithDefaults(
  options,
  { normalizeText = true } = {},
) {
  const {
    text,
    name = "Text",
    fontSize = 48,
    bold = false,
    italic = false,
    alignment = "left",
    lineHeight = 1.2,
    color = [43, 43, 43],
    opacity = 1,
    gradientColor = null,
    outlineWidth = 0,
    outlineColor = [0, 0, 0],
    figureTypeId = 1,
    fontFamily,
  } = options || {};
  if (typeof text !== "string" || !text.trim())
    throw new Error("Enter visible text.");
  if (text.length > MAX_TEXT_LENGTH)
    throw new Error(
      `Text must contain at most ${MAX_TEXT_LENGTH.toLocaleString()} characters.`,
    );
  if (!["left", "center", "right"].includes(alignment))
    throw new Error("Text alignment must be left, center, or right.");
  if (typeof bold !== "boolean" || typeof italic !== "boolean")
    throw new Error("Bold and italic must be true or false.");
  if (
    !Number.isInteger(figureTypeId) ||
    figureTypeId < 1 ||
    figureTypeId > 65535
  )
    throw new Error("Figure ID must be between 1 and 65535.");
  // Canonical composition avoids treating common accented letters as positioned marks.
  const lineNormalized = text.replace(/\r\n?/g, "\n");
  const normalized = normalizeText
    ? lineNormalized.normalize("NFC")
    : lineNormalized;
  const unique = new Set(normalized.split(""));
  if (unique.size > 255)
    throw new Error(
      "Pivot text supports at most 255 distinct UTF-16 characters in one figure.",
    );
  if (/[\ud800-\udfff]/.test(normalized))
    throw new Error(
      "This text contains characters outside the supported Unicode BMP range.",
    );
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(normalized))
    throw new Error("Text contains unsupported control characters.");
  return {
    text: normalized,
    ...(options.paint ? {paint:normalizePaint(options.paint)} : {}),
    name: String(name),
    ...(fontFamily ? { fontFamily: String(fontFamily) } : {}),
    fontSize: number(fontSize, "Font size", 1, 2048),
    bold,
    italic,
    alignment,
    lineHeight: number(lineHeight, "Line height", 0.5, 5),
    color: rgb(color, "Text color"),
    opacity: number(opacity, "Opacity", 0, 1),
    gradientColor:
      gradientColor == null ? null : rgb(gradientColor, "Gradient color"),
    outlineWidth: number(outlineWidth, "Outline width", 0, 128),
    outlineColor: rgb(outlineColor, "Outline color"),
    figureTypeId,
  };
}

// Pivot's FMX path records contain cubic curves, not TrueType quadratic curves.
function pathCommands(path) {
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  const commands = [];
  for (const command of path.commands) {
    let values;
    switch (command.type) {
      case "M":
        startX = command.x;
        startY = command.y;
        values = [command.x, command.y];
        break;
      case "L":
        values = [command.x, command.y];
        break;
      case "Q":
        values = [
          x + ((command.x1 - x) * 2) / 3,
          y + ((command.y1 - y) * 2) / 3,
          command.x + ((command.x1 - command.x) * 2) / 3,
          command.y + ((command.y1 - command.y) * 2) / 3,
          command.x,
          command.y,
        ];
        break;
      case "C":
        values = [
          command.x1,
          command.y1,
          command.x2,
          command.y2,
          command.x,
          command.y,
        ];
        break;
      case "Z":
        values = [];
        x = startX;
        y = startY;
        break;
      default:
        throw new Error(`Unsupported font outline command ${command.type}.`);
    }
    if (command.type !== "Z") {
      x = command.x;
      y = command.y;
    }
    commands.push({
      op: command.type === "Q" ? "C" : command.type,
      values: values.map(f32),
    });
  }
  return commands;
}

// Match the interchange decoder: bounds include cubic control points.
export function pathBounds(commands) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  const point = (px, py) => {
    left = Math.min(left, px);
    right = Math.max(right, px);
    top = Math.min(top, py);
    bottom = Math.max(bottom, py);
  };
  for (const { op, values } of commands) {
    if (op === "H") {
      x = values[0];
      point(x, y);
    } else if (op === "V") {
      y = values[0];
      point(x, y);
    } else if (op === "Z") {
      x = startX;
      y = startY;
    } else {
      for (let i = 0; i < values.length; i += 2)
        point(values[i], values[i + 1]);
      x = values.at(-2);
      y = values.at(-1);
      if (op === "M") {
        startX = x;
        startY = y;
      }
    }
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

export function svgPath(commands, dx = 0, dy = 0) {
  return commands
    .map(
      ({ op, values }) =>
        `${op}${values
          .map((n, i) => {
            const v = n + (op === "V" || (op !== "H" && i % 2) ? dy : dx);
            return Object.is(v, -0) ? 0 : v;
          })
          .join(" ")}`,
    )
    .join(" ");
}

export function textBounds(glyphs, placements) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of placements) {
    const bounds = glyphs[p.glyph_index].bounds;
    if (!bounds) continue;
    left = Math.min(left, f32(bounds.left + p.x));
    right = Math.max(right, f32(bounds.right + p.x));
    top = Math.min(top, f32(bounds.top + p.y));
    bottom = Math.max(bottom, f32(bounds.bottom + p.y));
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top)
    throw new Error("Text has no visible glyph outlines.");
  return {
    left,
    top,
    right,
    bottom,
    width: f32(right - left),
    height: f32(bottom - top),
  };
}

/** Pure compiler for callers that already hold an opentype.js parsed font. */
export function compileTextFigure(options, font) {
  const o = textOptionsWithDefaults(options);
  if (!font || typeof font.charToGlyph !== "function" || !font.unitsPerEm)
    throw new Error("A parsed outline font is required.");
  const family = o.fontFamily || textFontFamily(font);
  const scale = o.fontSize / font.unitsPerEm;
  const glyphs = [],
    byUnit = new Map(),
    fontGlyphs = new Map();
  for (const char of o.text) {
    const unit = char.charCodeAt(0);
    if (byUnit.has(unit)) continue;
    const invisible = char === "\n" || char === "\t";
    const source = invisible ? null : font.charToGlyph(char);
    if (source && source.index === 0)
      throw new Error(
        `${family} does not contain ${char} (U+${unit.toString(16).toUpperCase().padStart(4, "0")}).`,
      );
    const commands = source
      ? pathCommands(source.getPath(0, 0, o.fontSize))
      : [];
    byUnit.set(unit, glyphs.length);
    fontGlyphs.set(unit, source);
    glyphs.push({
      utf16_code_unit: unit,
      commands,
      node_count: commands.reduce((n, c) => n + (c.op === "C" ? 3 : 1), 0),
      bounds: pathBounds(commands),
      svg_path: svgPath(commands),
    });
  }
  const spaceAdvance =
    (font.charToGlyph(" ").advanceWidth || font.unitsPerEm / 4) * scale;
  const lines = o.text.split("\n").map((line) => {
    let width = 0;
    const offsets = [];
    for (let i = 0; i < line.length; i++) {
      offsets.push(width);
      const current = fontGlyphs.get(line.charCodeAt(i)),
        next = fontGlyphs.get(line.charCodeAt(i + 1));
      width +=
        line[i] === "\t"
          ? spaceAdvance * 4
          : (current?.advanceWidth || 0) * scale;
      if (current && next) width += font.getKerningValue(current, next) * scale;
    }
    return { line, offsets, width };
  });
  const layoutWidth = Math.max(...lines.map((line) => line.width)),
    placements = [];
  const place = (unit, x, y) => {
    const glyph_index = byUnit.get(unit),
      visible = !!glyphs[glyph_index].commands.length;
    placements.push({
      character_index: placements.length,
      utf16_code_unit: unit,
      glyph_index,
      visible,
      x: visible ? f32(x) : 0,
      y: visible ? f32(y) : 0,
    });
  };
  lines.forEach(({ line, offsets, width }, row) => {
    const dx =
      o.alignment === "right"
        ? layoutWidth - width
        : o.alignment === "center"
          ? (layoutWidth - width) / 2
          : 0;
    for (let i = 0; i < line.length; i++)
      place(
        line.charCodeAt(i),
        offsets[i] + dx,
        row * o.fontSize * o.lineHeight,
      );
    if (row < lines.length - 1) place(10, 0, 0);
  });
  const bounds = textBounds(glyphs, placements);
  const asset = {
    kind: "text",
    asset_index: 0,
    table_index: 0,
    font_name: family,
    font_style: Number(o.bold) | (Number(o.italic) << 1),
    bold: o.bold,
    italic: o.italic,
    underline: false,
    strikeout: false,
    // FMX TTextAlign values are Center=0, Leading=1, Trailing=2. Paths also store explicit positions.
    alignment: { left: 1, center: 0, right: 2 }[o.alignment],
    text: o.text,
    font_size: o.fontSize,
    glyphs,
    placements,
    bounds,
    normalized_origin: "lower_left",
    svg_path: placements
      .filter((p) => p.visible)
      .map((p) => svgPath(glyphs[p.glyph_index].commands, p.x, p.y))
      .join(" "),
    normalized_svg_path: placements
      .filter((p) => p.visible)
      .map((p) =>
        svgPath(
          glyphs[p.glyph_index].commands,
          p.x - bounds.left,
          p.y - bounds.bottom,
        ),
      )
      .join(" "),
  };
  const transparency = Math.round((1 - o.opacity) * 255);
  const styleBytes = new ArrayBuffer(4),
    styleView = new DataView(styleBytes);
  styleView.setFloat32(0, o.outlineWidth, true);
  return {
    figure_type_id: o.figureTypeId,
    name: label(o.name),
    segment_count: 1,
    segments: [
      {
        segment_id: 1,
        parent_id: 0,
        length: bounds.width,
        angle_rad: 0,
        thickness: 0,
        bend_rad: 0,
        primitive_code: 5,
        aux_code: 0,
        flags: 2,
        segment_type: "text",
        segment_kind: "text",
        ...(o.paint ? {paint:o.paint} : {}),
        color_rgb: o.color,
        transparency,
        secondary: o.gradientColor
          ? { rgb: o.gradientColor, a: o.paint ? Math.round((1-o.paint.stops.at(-1).opacity)*255) : transparency }
          : null,
        extra_u16: 0,
        extra_u8_a: 0,
        extra_u8_b: 0,
        extra: [0, 0, 0],
        visible: true,
        z_order: 1,
      },
    ],
    segment_decode: {
      global_style: {
        u28: styleView.getUint32(0, true),
        outline_thickness: f32(o.outlineWidth),
        rgb: o.outlineColor,
        u30: 0,
        outline_transparency: 0,
      },
    },
    polyfills: [],
    image_assets: [],
    text_assets: [asset],
    _styk: {
      sourceName: o.name,
      textAuthoring: {
        version: 1,
        ...o,
        fontFamily: family,
        glyphAdvances: Object.fromEntries(
          [...fontGlyphs].map(([unit, glyph]) => [
            unit,
            glyph
              ? (glyph.advanceWidth || 0) * scale
              : unit === 9
                ? spaceAdvance * 4
                : 0,
          ]),
        ),
        spaceAdvance,
      },
    },
  };
}

/** Returns a complete figure definition ready for Editor.importFigure(). */
export async function createTextFigure(options, { font } = {}) {
  const validated = textOptionsWithDefaults(options);
  return compileTextFigure(validated, font || (await loadTextFont(validated)));
}
