/** Deterministic aliased SVG rasterization in the export worker. */
let initialized;
async function engine() {
  const module = await import("../vendor/resvg/index.mjs");
  initialized ??= module.initWasm(
    fetch(new URL("../vendor/resvg/index_bg.wasm", import.meta.url)),
  );
  await initialized;
  return module;
}
export async function rasterizeCrispSVG(svg, canvas) {
  const { Resvg } = await engine();
  const tree = new Resvg(typeof svg === "string" ? svg : await svg.text(), {
    font: { loadSystemFonts: false },
    shapeRendering: 1,
    imageRendering: 1,
  });
  let rendered;
  try {
    rendered = tree.render();
    if (rendered.width !== canvas.width || rendered.height !== canvas.height)
      throw new Error(
        "Crisp export dimensions do not match the requested frame.",
      );
    // tiny-skia exposes premultiplied RGBA. Canvas ImageData takes straight RGBA;
    // convert once in this worker, preserving every alpha value and group overlap.
    const pixels = rendered.pixels;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (alpha > 0 && alpha < 255) {
        const scale = 255 / alpha;
        pixels[i] = Math.min(255, Math.round(pixels[i] * scale));
        pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1] * scale));
        pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2] * scale));
      }
    }
    const data = new ImageData(
      new Uint8ClampedArray(
        pixels.buffer,
        pixels.byteOffset,
        pixels.byteLength,
      ),
      rendered.width,
      rendered.height,
    );
    canvas.getContext("2d").putImageData(data, 0, 0);
  } finally {
    rendered?.free();
    tree.free();
  }
  return canvas;
}
