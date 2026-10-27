import {messageError} from '../localized-error.mjs';
// What the interface reads about a document's backgrounds and camera; the engine paints them (docs/engine/rendering.md).

/** UI angle in normalized background coordinates, matching the fill editor. */
export function gradientAngleFromBackground(background, fallback = 90) {
  if (background?.kind !== 3) return fallback;
  const {x1, y1, x2, y2} = background;
  if (![x1, y1, x2, y2].every(value => typeof value === 'number' && Number.isFinite(value))) return fallback;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return fallback;
  return (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
}

/** A hidden Camera track uses the untransformed animation viewport everywhere. The frame's camera is the shot: with the
 * camera motion the engine works out for its tick (`engine-shown.mjs`, `shot`), which the app puts on the frames it plays. */
export function effectiveCamera(report, frame, cameraEnabled = true) {
  return cameraEnabled && report?._styk?.layers?.fixed?.camera?.visible !== false ? frame?.camera : null;
}

// Native rendering decides identity from the camera values after loading.
// Its scale/angle tolerances differ from its relative comparison to zero.
export function cameraIsIdentity(camera) {
  if (!camera || camera.is_default) return true;
  const zero = (value) => {
    const magnitude = Math.abs(Number(value ?? 0));
    const epsilon = Math.fround(magnitude * Math.fround(1.25e-6));
    return magnitude <= (epsilon || Math.fround(6.25e-37));
  };
  return (
    zero(camera.x) &&
    zero(camera.y) &&
    Math.abs(Number(camera.angle_rad ?? 0)) <= 1e-12 &&
    Math.abs(Number(camera.scale ?? 1) - 1) <= Math.fround(1e-4)
  );
}

export function inverseCameraScale(camera) {
  const inverse = Math.fround(1 / Math.fround(Number(camera?.scale ?? 1)));
  if (!Number.isFinite(inverse) || inverse <= 0)
    throw messageError(new Error(''), "errors.background.cameraScaleExceedsTheNativeRenderingRange", {});
  return inverse;
}

