/**
 * The backdrop a library card shows behind transparent artwork: the light, neutral or dark
 * matte that contrasts most with the artwork's colours. Used for saved PNG previews and for
 * the hover animation (the JavaScript worker and the engine's preview worker alike), so it
 * has no dependencies.
 */
// Neutral mattes are presentation only. Saved PNGs and artwork stay transparent.
export const LIBRARY_MATTES = {light: '#edf0f4', neutral: '#858b94', dark: '#343b47'};
const linear = n => (n /= 255) <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
const luminance = (r, g, b) => .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
const candidates = Object.entries(LIBRARY_MATTES).map(([name, hex]) => ({name,
  light: luminance(...hex.slice(1).match(/../g).map(n => parseInt(n, 16)))}));

export function libraryPreviewMatte(pixels) {
  const scores = candidates.map(() => 0);
  let weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < .08) continue;
    const light = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    weight += alpha;
    candidates.forEach((candidate, index) => {
      const composite = light * alpha + candidate.light * (1 - alpha);
      const contrast = (Math.max(composite, candidate.light) + .05) / (Math.min(composite, candidate.light) + .05);
      scores[index] += alpha * Math.log(Math.min(7, contrast));
    });
  }
  return weight ? candidates[scores.indexOf(Math.max(...scores))].name : 'neutral';
}
