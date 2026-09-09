import { cameraValues } from "./editor-camera.mjs";

/** Native camera controls live in document space, independently of its view. */
export function cameraViewport(report, frame, view = {}) {
  const camera = cameraValues(frame?.camera),
    w = report.canvas_width,
    h = report.canvas_height;
  const center = { x: w / 2 + camera.x, y: h / 2 + camera.y },
    cos = Math.cos(camera.angle_rad),
    sin = Math.sin(camera.angle_rad);
  const point = (x, y) => ({
    x: center.x + camera.scale * (x * cos - y * sin),
    y: center.y + camera.scale * (x * sin + y * cos),
  });
  const inset = 3 / ((view.scale || 1) * camera.scale);
  const corners = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => point(x, y));
  const handles = [
    ["position", -1, -1],
    ["scale", 1, -1],
    ["rotation", 1, 1],
    ["scale", -1, 1],
  ].map(([kind, x, y], index) => ({
    kind,
    index,
    point: point(x * (w / 2 - inset), y * (h / 2 - inset)),
  }));
  return {
    camera,
    center,
    corners,
    handles,
    width: w,
    height: h,
    zoom: view.scale || 1,
    cross: [
      point(-w / 20, 0),
      point(w / 20, 0),
      point(0, -h / 20),
      point(0, h / 20),
    ],
  };
}

export function pickCameraHandle(viewport, point, view = {}) {
  const radius = 3 / (view.scale || 1);
  for (const index of [0, 2, 1, 3]) {
    const handle = viewport.handles[index];
    if (
      Math.abs(handle.point.x - point.x) <= radius &&
      Math.abs(handle.point.y - point.y) <= radius
    )
      return handle;
  }
  return null;
}

export function cameraDragDelta(drag, point) {
  if (drag.handle.kind === "position") {
    const dx = point.x - drag.start.x,
      dy = point.y - drag.start.y;
    if (drag.constrain && !drag.axis && (dx || dy))
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    return { x: drag.axis === "y" ? 0 : dx, y: drag.axis === "x" ? 0 : dy };
  }
  const { center, camera, width, height, zoom } = drag.viewport;
  if (drag.handle.kind === "rotation") {
    const angle =
      Math.atan2(point.y - center.y, point.x - center.x) -
      Math.atan2(height, width);
    return {
      angle_rad:
        Math.atan2(Math.sin(angle), Math.cos(angle)) - camera.angle_rad,
    };
  }
  const scale = Math.max(
    1e-4,
    (2 * Math.hypot(point.x - center.x, point.y - center.y)) /
      (Math.hypot(width, height) - (6 * Math.SQRT2) / zoom),
  );
  return { scale: scale / camera.scale };
}

/** Native arrow input resets its mouse anchor with a view-only inset. */
export function cameraKeyboardDelta(viewport, handle, dx, dy) {
  const { camera, zoom } = viewport,
    corner = viewport.corners[handle.index],
    inset = (3 / zoom) * camera.scale;
  const sx = [1, -1, -1, 1][handle.index],
    sy = [1, 1, -1, -1][handle.index],
    cos = Math.cos(camera.angle_rad),
    sin = Math.sin(camera.angle_rad);
  const start = {
    x: corner.x + inset * (sx * cos - sy * sin),
    y: corner.y + inset * (sx * sin + sy * cos),
  };
  return cameraDragDelta(
    { viewport, handle, start },
    { x: start.x + dx / zoom, y: start.y + dy / zoom },
  );
}

export function drawCameraViewport(
  context,
  viewport,
  project,
  { active = true, onion = false } = {},
) {
  const points = viewport.corners.map(project);
  context.save();
  const opacity = onion ? 0.14 : active ? 1 : 0.4;
  context.globalAlpha = opacity;
  context.strokeStyle = onion ? "#808080" : "#ff0000a0";
  context.lineWidth = 1;
  context.beginPath();
  points.forEach((p, index) =>
    index ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
  );
  context.closePath();
  context.stroke();
  const cross = viewport.cross.map(project);
  context.beginPath();
  context.moveTo(cross[0].x, cross[0].y);
  context.lineTo(cross[1].x, cross[1].y);
  context.moveTo(cross[2].x, cross[2].y);
  context.lineTo(cross[3].x, cross[3].y);
  context.stroke();
  for (const index of [0, 2, 1, 3]) {
    const handle = viewport.handles[index];
    const p = project(handle.point);
    context.save();
    context.translate(p.x, p.y);
    context.rotate(viewport.camera.angle_rad);
    context.fillStyle = onion
      ? "#808080"
      : handle.kind === "position"
        ? "#ff8000"
        : "#ff0000a0";
    if (handle.kind !== "scale") context.fillRect(-3, -3, 6, 6);
    context.globalAlpha = opacity * 0.5;
    context.strokeStyle = onion ? "#808080" : "#000000";
    const size = handle.kind === "scale" ? 6 : 6.5;
    context.strokeRect(-3, -3, size, size);
    context.restore();
  }
  context.restore();
}
