import {buildGeometry, drawGeometry} from './pivot/geometry.mjs';
import {objectBounds} from './renderer-geometry.mjs';
import {PlaybackResources} from './playback-resources.mjs';

self.onmessage = async ({data: {report, baseURL}}) => {
  const resources = new PlaybackResources({baseURL, maxBytes: 192 * 1024 * 1024});
  try {
    const geometry = buildGeometry(report, report.keyframes[0]);
    await resources.preload(geometry.drawables);
    const bounds = objectBounds(geometry.drawables, resources), size = 320;
    const canvas = new OffscreenCanvas(size, size), context = canvas.getContext('2d');
    const scale = (size - 48) / Math.max(1, bounds.width, bounds.height);
    context.translate(size / 2, size / 2); context.scale(scale, scale);
    context.translate(-bounds.x - bounds.width / 2, -bounds.y - bounds.height / 2);
    drawGeometry(context, geometry, resources);
    const blob = await canvas.convertToBlob({type:'image/png'});
    self.postMessage({blob});
  } catch (error) { self.postMessage({error: error.message}); }
  finally { resources.dispose(); }
};
