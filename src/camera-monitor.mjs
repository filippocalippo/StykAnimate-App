import {cameraValues} from './editor-camera.mjs';
import {cameraMatrix} from './renderer-geometry.mjs';
import {drawBackground, backgroundBounds} from './pivot/background.mjs';
import {buildGeometry,drawGeometry} from './pivot/geometry.mjs';
import {composeSceneGroups} from './scene-order.mjs';
import {formatPropertyValue} from './property-controls.mjs';
const playbackGeometry=new WeakMap();

/** Update only camera readouts, preserving focused inputs and their transaction. */
export function syncCameraControls(root, frame, {activeKey=null, guides=true}={}) {
  const c=cameraValues(frame?.camera);
  const values={camera_x:c.x,camera_y:c.y,camera_scale:c.scale*100,camera_angle:c.angle_rad*180/Math.PI};
  for(const [key,value] of Object.entries(values)) {
    const input=root.querySelector(`[data-property="${key}"]`);
    if(!input || key===activeKey) continue;
    input.value=formatPropertyValue(value,2);
    input.dataset.propertyValue=String(value);
  }
  const scale=root.querySelector('[data-camera-magnification]');
  if(scale) scale.textContent=`${formatPropertyValue(100/c.scale,1)}% zoom`;
  root.querySelector('[data-action="camera-guides"]')?.setAttribute('aria-pressed',String(guides));
}

/** Draw on the app's animation frame, reusing evaluated geometry and media. */
export function drawCameraMonitor(canvas, {report,frame,geometry,resources,hiddenUids}) {
  if(!canvas || !canvas.clientWidth) return;
  if(!geometry) {
    let cached=playbackGeometry.get(canvas);
    if(cached?.frame!==frame || cached?.report!==report) {
      cached={frame,report,geometry:buildGeometry(report,frame)};playbackGeometry.set(canvas,cached);
    }
    geometry=cached.geometry;
  } else playbackGeometry.delete(canvas);
  const width=canvas.clientWidth, height=canvas.clientHeight, dpr=Math.min(globalThis.devicePixelRatio || 1,2);
  if(canvas.width!==Math.round(width*dpr) || canvas.height!==Math.round(height*dpr)) {
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  }
  const ctx=canvas.getContext('2d'), scale=Math.min(width/report.canvas_width,height/report.canvas_height);
  const view={scale,x:(width-report.canvas_width*scale)/2,y:(height-report.canvas_height*scale)/2};
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  ctx.save();ctx.beginPath();ctx.rect(view.x,view.y,report.canvas_width*scale,report.canvas_height*scale);ctx.clip();
  ctx.transform(...cameraMatrix({report,frame,view,cameraEnabled:true}));
  drawBackground(ctx,report,frame,report.canvas_width,report.canvas_height,
    {...resources,bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report)});
  for(const group of composeSceneGroups(geometry,[],frame)) {
    if(hiddenUids?.has(group.g.obj.unique_id)) continue;
    ctx.save();ctx.globalAlpha=group.opacity;drawGeometry(ctx,{drawables:group.items},resources);ctx.restore();
  }
  ctx.restore();
}
