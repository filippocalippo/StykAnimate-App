import {messageError} from './localized-error.mjs';
import {localizedText} from './localization-bindings.mjs';
import {cameraValues} from './pivot/model.mjs';
import {formatPropertyValue} from './property-controls.mjs';
const monitorStates=new WeakMap();

export function cameraMonitorVisible(canvas) {
  return Boolean(canvas && canvas.checkVisibility?.({contentVisibilityAuto:true,visibilityProperty:true}) !== false && canvas.clientWidth && canvas.clientHeight);
}

function monitorState(canvas, options) {
  let state=monitorStates.get(canvas);
  if(!state){
    state={retryAt:0};monitorStates.set(canvas,state);
    canvas.addEventListener?.('contextlost',()=>{state.lost=true;state.painted=false;state.options.onRecovery?.('camera','started');});
    canvas.addEventListener?.('contextrestored',()=>{
      state.lost=false;state.retryAt=0;state.painted=false;
      state.options.onRecovery?.('camera','recovered');
      state.options.onInvalidate?.();
    });
  }
  if(state.options?.report!==options.report)state.retryAt=0;
  state.options=options;return state;
}
function reportMonitorError(error, options) {
  if(!error||typeof error!=='object')error=messageError(new Error(''), "errors.cameraMonitor.theCameraPreviewFailed", {});
  error.telemetryStage??='prepare';
  if(options.onError)options.onError(error);
  else globalThis.reportError?.(error);
}

/** Update only camera readouts, preserving focused inputs and their transaction. */
export function syncCameraControls(root, frame, {activeKey=null, guides=true}={}) {
  if(!root)return;
  const c=cameraValues(frame?.camera);
  const values={camera_x:c.x,camera_y:c.y,camera_scale:c.scale*100,camera_angle:c.angle_rad*180/Math.PI};
  for(const [key,value] of Object.entries(values)) {
    const input=root.querySelector(`[data-property="${key}"]`);
    if(!input || key===activeKey) continue;
    input.value=formatPropertyValue(value,Number(input.dataset.propertyDisplayPrecision??2));
    input.dataset.propertyValue=String(value);
  }
  const scale=root.querySelector('[data-camera-magnification]');
  if(scale) localizedText(scale, "cameraMonitor.zoom", {value: formatPropertyValue(100/c.scale,1)});
  root.querySelector('[data-action="camera-guides"]')?.setAttribute('aria-pressed',String(guides));
}

/** Draw on the app's animation frame. The engine draws the frame it drew on the stage, through the
 * scene camera (`options.stage.drawCameraMonitor`, engine-stage.mjs and engine-previews.mjs); the
 * monitor keeps its last picture while a new one is drawn. False when nothing was drawn: the stage
 * shows no engine frame yet, or the monitor is hidden or lost. */
export function drawCameraMonitor(canvas, options) {
  const {report,frame}=options;
  if(!cameraMonitorVisible(canvas) || !report || !frame) return false;
  const state=monitorState(canvas,options);
  if(state.lost || performance.now()<state.retryAt)return false;
  try {
  const width=canvas.clientWidth, height=canvas.clientHeight, dpr=Math.min(globalThis.devicePixelRatio || 1,2);
  if(canvas.width!==Math.round(width*dpr) || canvas.height!==Math.round(height*dpr)) {
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  }
  const ctx=canvas.getContext('2d',{willReadFrequently:true}), scale=Math.min(width/report.canvas_width,height/report.canvas_height);
  if(!ctx || ctx.isContextLost?.())throw Object.assign(messageError(new Error(''), "errors.cameraMonitor.theCameraPreviewCanvasIsUnavailable", {}),{telemetryCode:'device_lost'});
  const view={scale,x:(width-report.canvas_width*scale)/2,y:(height-report.canvas_height*scale)/2};
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  if(!options.stage?.drawCameraMonitor?.(ctx,{width:canvas.width,height:canvas.height,zoom:scale*dpr,panX:view.x*dpr,panY:view.y*dpr,dpr},gpuSource=>{
    // Only a GPU foreground that is this destination's first actual paint
    // needs the startup settle. Preserve prior direct/empty presentation.
    const first=!state.painted;state.painted=true;
    if(first&&gpuSource)options.onInvalidate?.();
  }))return false;
  if(state.retryAt)options.onRecovery?.('camera','recovered');state.retryAt=0;return true;
  } catch(error) {
    // The monitor is auxiliary. A failure must not abort the editor's frame or
    // ask the engine for the same picture again on every animation frame.
    state.retryAt=performance.now()+1500;
    options.onRecovery?.('camera','started');
    reportMonitorError(error,options);return false;
  }
}
