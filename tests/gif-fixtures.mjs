/** Deterministic color-rich fixtures used by independent GIF decoder checks. */
export function gifFixture(
  kind = "gradient",
  width = 384,
  height = 128,
  frame = 0,
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        u = x / (width - 1),
        v = y / (height - 1);
      if (kind === "grayscale")
        data.set(
          [Math.round(u * 255), Math.round(u * 255), Math.round(u * 255), 255],
          i,
        );
      else if (kind === "sprite") {
        const dx = (u - 0.5) * 2,
          dy = (v - 0.5) * 2,
          r = dx * dx + dy * dy,
          light = Math.sqrt(Math.max(0, 1 - r));
        data.set(
          [
            Math.round(
              32 + 180 * light + 25 * Math.sin(x * 0.29) * Math.cos(y * 0.13),
            ),
            Math.round(30 + 120 * u + 70 * light),
            Math.round(36 + 150 * v + 55 * light),
            r < 0.91 ? 255 : 0,
          ],
          i,
        );
      } else
        data.set(
          [
            Math.round(14 + 226 * u),
            Math.round(22 + 212 * v),
            Math.round(20 + 214 * (u * 0.63 + v * 0.37)),
            255,
          ],
          i,
        );
    }
  if (frame) {
    for (let y = 37; y < 49; y++)
      for (let x = 101; x < 115; x++)
        data.set([240, 35, 160, 255], (y * width + x) * 4);
  }
  return data;
}
