/** Native VFW's RGB24 DIB uses BGR channels, bottom-up rows and DWORD padding. */
export function rgbaToVfwBgr24(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16777216) throw new Error('Invalid Windows video dimensions.');
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.byteLength !== width * height * 4) throw new Error('Windows video needs one exact RGBA frame.');
  const stride = Math.ceil(width * 3 / 4) * 4, bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    let source = y * width * 4, target = (height - y - 1) * stride;
    for (let x = 0; x < width; x++, source += 4, target += 3) {
      const alpha = rgba[source + 3] / 255;
      bytes[target] = Math.round(rgba[source + 2] * alpha); bytes[target + 1] = Math.round(rgba[source + 1] * alpha); bytes[target + 2] = Math.round(rgba[source] * alpha);
    }
  }
  return {bytes, stride};
}
