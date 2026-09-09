import { buildGeometry, drawGeometry } from "./pivot/geometry.mjs";
import { drawBackground, backgroundBounds } from "./pivot/background.mjs";
import { cameraMatrix } from "./renderer-geometry.mjs";
import { layerVisible } from "./layers.mjs";

/** Shared portable renderer used only by export; editor GPU state is untouched. */
export function exportFrameGeometry(report, frame) {
  const geometry = buildGeometry(report, frame);
  return {
    ...geometry,
    drawables: geometry.drawables.filter((item) =>
      layerVisible(report, item.obj.unique_id),
    ),
  };
}
export function drawExportScene(context, report, frame, geometry, resources) {
  const width = report.canvas_width,
    height = report.canvas_height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.save();
  try {
    context.scale(context.canvas.width / width, context.canvas.height / height);
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();
    context.transform(...cameraMatrix({ report, frame }));
    drawBackground(context, report, frame, width, height, {
      ...resources,
      bounds: backgroundBounds(frame, width, height, true, report),
    });
    drawGeometry(context, geometry, resources);
  } finally {
    context.restore();
  }
}
