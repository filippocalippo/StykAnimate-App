import {releaseGeometryResources} from './pivot/geometry.mjs';

/** One reusable Canvas2D context for serial object rasterization. Captured
 * ImageBitmaps own their pixels independently; no packet owns this scratch canvas. */
export class RasterSurfacePool {
  constructor() { this.surface = null; this.context = null; this.busy = false; }
  acquire(width, height) {
    if (this.busy) throw new Error('A raster scratch surface cannot be used concurrently.');
    if (!this.surface) {
      this.surface = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      this.surface.width = width; this.surface.height = height;
      this.context = this.surface.getContext('2d');
    } else {
      if (this.surface.width !== width) this.surface.width = width;
      if (this.surface.height !== height) this.surface.height = height;
      // A fresh object must begin with the same Canvas state as a new context.
      if (this.context.reset) this.context.reset();
      else this.surface.width = width;
    }
    this.busy = true;
    return {surface: this.surface, context: this.context};
  }
  release() {
    if (!this.surface) return;
    // Keep context identities alive while releasing their large pixel storage.
    // Recreating thousands of contexts causes GPU shared-image pool destruction
    // to accumulate into a later garbage-collection/compositor pause.
    releaseGeometryResources(this.context, {retainCanvases: true});
    this.surface.width = 1; this.surface.height = 1; this.busy = false;
  }
  dispose() {
    if (!this.surface) return;
    releaseGeometryResources(this.context);
    this.surface.width = 1; this.surface.height = 1;
    this.surface = null; this.context = null; this.busy = false;
  }
}
