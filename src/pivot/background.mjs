import {canvasPaint} from '../paint.mjs';
// Backgrounds are native ARGB; figure COLORREF colors use a different byte order.
export function backgroundColor(raw) {
  const n = Number(raw) >>> 0;
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${(n >>> 24) / 255})`;
}

/** UI angle in normalized background coordinates, matching the fill editor. */
export function gradientAngleFromBackground(background, fallback = 90) {
  if (background?.kind !== 3) return fallback;
  const {x1, y1, x2, y2} = background;
  if (![x1, y1, x2, y2].every(value => typeof value === 'number' && Number.isFinite(value))) return fallback;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return fallback;
  return (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
}

/** Scene color keys replace the native fill; hiding Scene makes it transparent. */
export function sceneBackgroundColor(report, frame) {
  if (report?._styk?.layers?.fixed?.scene?.visible === false) return 0;
  return frame?._stykBackgroundColor;
}

/** A hidden Camera track uses the untransformed animation viewport everywhere. */
export function effectiveCamera(report, frame, cameraEnabled = true) {
  return cameraEnabled && report?._styk?.layers?.fixed?.camera?.visible !== false ? frame?.camera : null;
}

const imageTransparency = new WeakMap();

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
    throw new Error("Camera scale exceeds the native rendering range.");
  return inverse;
}

function hasTransparency(context, image, asset, resources) {
  if (resources.hasTransparency) return resources.hasTransparency(image, asset);
  if (asset.mime_type === "image/jpeg") return false;
  if (imageTransparency.has(image)) return imageTransparency.get(image);
  const width = image.naturalWidth,
    height = image.naturalHeight;
  if (width * height > 64 * 1024 * 1024)
    throw new Error("Background alpha inspection is limited to 64 megapixels.");
  const surface =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : context.canvas.ownerDocument.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const target = surface.getContext("2d", { willReadFrequently: true });
  target.drawImage(image, 0, 0);
  const data = target.getImageData(0, 0, width, height).data;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      transparent = true;
      break;
    }
  imageTransparency.set(image, transparent);
  return transparent;
}

// Solids and gradients are world-aligned infinite backgrounds. Their brush
// coordinates stay fixed while their painted bounds cover the camera viewport.
export function backgroundBounds(frame, width, height, cameraEnabled = true, report) {
  const camera = effectiveCamera(report, frame, cameraEnabled);
  if (cameraIsIdentity(camera))
    return { x: 0, y: 0, width, height, clearRaster: false };
  const s = Number(camera.scale ?? 1),
    a = Number(camera.angle_rad ?? 0),
    cos = Math.cos(a),
    sin = Math.sin(a);
  const points = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => {
    const dx = (x - width / 2) * s,
      dy = (y - height / 2) * s;
    return {
      x: Math.fround(dx * cos - dy * sin + width / 2 + Number(camera.x ?? 0)),
      y: Math.fround(dx * sin + dy * cos + height / 2 + Number(camera.y ?? 0)),
    };
  });
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y),
    padding = 2 * s;
  return {
    x: Math.min(...xs) - padding,
    y: Math.min(...ys) - padding,
    width: Math.max(...xs) - Math.min(...xs) + 2 * padding,
    height: Math.max(...ys) - Math.min(...ys) + 2 * padding,
    // The native image clear is conditional on viewport containment, before
    // adding the paint padding. A contained zoom keeps the previous layer.
    clearRaster:
      Math.min(...xs) < 0 ||
      Math.min(...ys) < 0 ||
      Math.max(...xs) > width ||
      Math.max(...ys) > height,
  };
}

export function tweenBackground(start, end, t) {
  let a = start.background_id ?? 0,
    b = start.background_id_b || 0,
    m = start.background_mix || 0;
  const c = end.background_id ?? 0,
    d = end.background_id_b || 0,
    n = end.background_mix || 0;
  const result = () => ({
    background_id: a,
    background_id_b: b,
    background_mix: m,
  });
  if (a === c && b === d && m === n) return result();
  const duration = start.duration_raw || 1;
  let j = t * duration;
  if (Math.abs(j - Math.round(j)) < 1e-9) j = Math.round(j);
  const lerp = (x, y) => x + Math.trunc((j * (y - x)) / duration);
  let fallback = false;
  if (m && n) {
    if (a === c && b === d) m = lerp(m, n);
    else if (a === d && b === c) m = lerp(m, 255 - n);
    else fallback = true;
  } else if (m) {
    if (c === a) m = lerp(m, 0);
    else if (c === b) m = lerp(m, 255);
    else fallback = true;
  } else if (n) {
    if (a === c) {
      b = d;
      m = lerp(0, n);
    } else if (a === d) {
      a = c;
      b = d;
      m = lerp(255, n);
    } else fallback = true;
  } else {
    b = c;
    m = Math.floor((255 * j) / duration);
  }
  if (fallback) {
    a =
      start.background_mix >= 128 ? start.background_id_b : start.background_id;
    b = end.background_mix >= 128 ? end.background_id_b : end.background_id;
    if (a === b) {
      b = 0;
      m = 0;
    } else m = Math.floor((255 * j) / duration);
  }
  if (m >= 254) {
    a = b;
    b = 0;
    m = 0;
  }
  return result();
}

export function drawBackground(
  context,
  report,
  frame,
  width,
  height,
  resources = {},
) {
  const bounds = resources.bounds || { x: 0, y: 0, width, height };
  const fill = () =>
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  const override = sceneBackgroundColor(report, frame);
  if (override !== undefined) {
    context.save(); context.fillStyle = backgroundColor(override); fill(); context.restore();
    return;
  }
  function layer(id, alpha = 1) {
    const bg = report.backgrounds?.find(
      (b) => Number(b.background_id) === Number(id),
    );
    context.save();
    context.globalAlpha = alpha;
    if (!bg) {
      context.fillStyle = "#fff";
      fill();
    } else if (bg.paint) {
      context.fillStyle=canvasPaint(context,bg.paint,{x:0,y:height/2},{x:width,y:height/2},c=>c,bounds);
      context.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);
    } else if (bg.kind === 3 || bg.kind === 4) {
      let gradient;
      if (bg.kind === 4) {
        const x = bg.x1 * width,
          y = bg.y1 * height,
          outer = bg.y2 * height;
        // Native FMX keeps at least a 1% transition band, even when the
        // stored inner radius equals or exceeds the outer radius.
        if (outer <= 0) {
          context.fillStyle = backgroundColor(bg.color_a);
          fill();
          context.restore();
          return;
        }
        gradient = context.createRadialGradient(
          x,
          y,
          Math.min(Math.max(0, bg.x2 * height), 0.99 * outer),
          x,
          y,
          outer,
        );
        gradient.addColorStop(0, backgroundColor(bg.color_b));
        gradient.addColorStop(1, backgroundColor(bg.color_a));
      } else {
        gradient = context.createLinearGradient(
          bg.x1 * width,
          bg.y1 * height,
          bg.x2 * width,
          bg.y2 * height,
        );
        gradient.addColorStop(0, backgroundColor(bg.color_a));
        gradient.addColorStop(1, backgroundColor(bg.color_b));
      }
      context.fillStyle = gradient;
      fill();
    } else if (bg.kind === 2 || bg.color !== undefined) {
      context.fillStyle = backgroundColor(bg.color);
      fill();
    } else {
      const img = resources.image?.(resources.url?.(bg));
      if (img?.complete && img.naturalWidth) {
        // Native raster backgrounds remain finite under the camera. Full-opacity
        // layers clear their surround; partial cross-fades keep the prior layer.
        if (alpha === 1 && bounds.clearRaster) {
          if (hasTransparency(context, img, bg, resources))
            context.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);
          else {
            context.fillStyle = "#000";
            fill();
          }
        }
        context.imageSmoothingEnabled = false;
        // Pivot fits uniformly from the top-left. Overflow stays in world space
        // and can become visible when the camera moves beyond the canvas.
        const scale = Math.max(
          width / img.naturalWidth,
          height / img.naturalHeight,
        );
        context.drawImage(
          img,
          0,
          0,
          img.naturalWidth * scale,
          img.naturalHeight * scale,
        );
      }
    }
    context.restore();
  }
  layer(frame.background_id);
  if (frame.background_mix)
    layer(frame.background_id_b, frame.background_mix / 255);
}
