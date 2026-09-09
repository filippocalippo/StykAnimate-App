/** Small native-compatible shapes with deliberately subpixel placement. */
import { emptyDocument, createFrame, createObject } from "../src/demo.mjs";
import { createLayerState } from "../src/layers.mjs";
const segment = (kind, extra = {}) => ({
  segment_id: 1,
  parent_id: 0,
  primitive_code: {
    line: 0,
    circle: 1,
    circleFill: 3,
    text: 5,
    image: 2,
    squareLine: 6,
  }[kind],
  segment_type: ["circle", "circleFill"].includes(kind)
    ? "circle"
    : ["text", "image"].includes(kind)
      ? kind
      : "line",
  segment_kind: kind,
  length: 49.3,
  angle_rad: 0.413,
  bend_rad: 0,
  thickness: 7.3,
  color_rgb: [20, 40, 180],
  visible: true,
  z_order: 1,
  transparency: 0,
  ...extra,
});
const figure = (id, kind, extra = {}, tables = {}) => ({
  figure_type_id: id,
  name: kind,
  segments: [segment(kind, extra)],
  polyfills: [],
  image_assets: [],
  text_assets: [],
  ...tables,
});
export function samplingFixture({
  kind = "line",
  opacity = 1,
  spriteURL,
  gradient = false,
} = {}) {
  const report = emptyDocument();
  report.canvas_width = 128;
  report.canvas_height = 96;
  report._styk.layers = createLayerState();
  report._styk.layers.fixed.scene.visible = false;
  let tables = {};
  if (kind === "image")
    tables = {
      image_assets: [
        {
          asset_index: 0,
          data_url: spriteURL,
          mime_type: "image/png",
          width: 8,
          height: 8,
          anchor_start: { x: 0, y: 0 },
          anchor_angle_rad: 0,
          anchor_length: 8,
        },
      ],
    };
  if (kind === "text")
    tables = {
      text_assets: [
        {
          asset_index: 0,
          normalized_svg_path: "M0 40 L20 0 L40 40 Z M15 28 L25 28 L20 16 Z",
          bounds: { left: 0, top: 0, bottom: 40, width: 40, height: 40 },
          placements: [{ visible: true, glyph_index: 0, x: 0, y: 0 }],
          glyphs: [
            {
              svg_path: "M0 40 L20 0 L40 40 Z M15 28 L25 28 L20 16 Z",
              bounds: { top: 0, bottom: 40 },
            },
          ],
        },
      ],
    };
  report.figure_types = [
    figure(
      1,
      ["poly", "curve", "outline"].includes(kind) ? "line" : kind,
      {
        transparency: Math.round((1 - opacity) * 255),
        extra_u16: 0,
        ...(gradient ? { secondary: { rgb: [220, 40, 20], a: 80 } } : {}),
      },
      tables,
    ),
  ];
  if (kind === "curve") report.figure_types[0].segments[0].bend_rad = 1.6;
  if (kind === "outline")
    report.figure_types[0].segment_decode = {
      global_style: {
        u28: new Uint32Array(new Float32Array([3]).buffer)[0],
        rgb: [220, 40, 20],
        u30: 0,
      },
    };
  if (kind === "poly") {
    const first = report.figure_types[0].segments[0];
    first.visible = false;
    first.thickness = 0;
    report.figure_types[0].segments.push({
      ...first,
      segment_id: 2,
      parent_id: 1,
      angle_rad: 2.3,
    });
    report.figure_types[0].polyfills = [
      {
        segment_ids: [0, 1, 2],
        color_rgb: [20, 40, 180],
        alpha_raw: Math.round((1 - opacity) * 255),
      },
    ];
  }
  report.keyframes = [0, 1, 2].map((i) =>
    createFrame(
      [createObject(report.figure_types[0], 1, 30.3 + i * 4, 30.7)],
      1,
    ),
  );
  return report;
}
