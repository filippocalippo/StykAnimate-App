import {messageError} from './localized-error.mjs';
import {figureRows} from './figure-types.mjs';
/** Native GIF defaults are content-based, separate from edge smoothing. */
export function normalizeGIFDither(value = false) {
  if (typeof value !== "boolean")
    throw messageError(new TypeError(''), "errors.gifOptions.gifDitheringMustBeEnabledOrDisabled", {});
  return value;
}
export function defaultGIFDither(report) {
  if (!report) return false;
  for (const background of report.backgrounds ?? []) {
    if (background.kind !== 2) return true;
  }
  return figureRows(report.figure_types).some((row) => row.pictures);
}
