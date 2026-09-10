/** Pivot's three pixel-export sampling choices. */
export const EXPORT_SMOOTHING = Object.freeze([
  Object.freeze({
    value: "edges",
    label: "Smooth edges",
    description:
      "Smooth figure edges while keeping sharp sprite pixels.",
  }),
  Object.freeze({
    value: "none",
    label: "No smoothing",
    description: "Aliased figure edges and unfiltered sprite pixels.",
  }),
  Object.freeze({
    value: "sprites",
    label: "Smooth sprites",
    description:
      "Render at twice the size, then downsample for smoother sprites.",
  }),
]);
export function normalizeExportSmoothing(value = "edges") {
  if (!EXPORT_SMOOTHING.some((option) => option.value === value))
    throw new Error("Choose Smooth edges, No smoothing, or Smooth sprites.");
  return value;
}
export function exportSamplingSize(width, height, smoothing = "edges") {
  smoothing = normalizeExportSmoothing(smoothing);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    width * height > 16777216
  )
    throw new Error(
      "Export dimensions must be whole pixels, up to 16,384 per side and 16 million pixels per frame.",
    );
  const factor = smoothing === "sprites" ? 2 : 1;
  if (width * factor > 16384 || height * factor > 16384)
    throw new Error(
      "Smooth sprites supports output dimensions up to 8,192 pixels per side.",
    );
  return {
    width,
    height,
    smoothing,
    factor,
    renderWidth: width * factor,
    renderHeight: height * factor,
  };
}

