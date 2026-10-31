import {errorMessageData} from './localized-error.mjs';
import {loadDrawingEngine,drawingEngineMemory,drawingEngineGeneration} from './engine/engine-drawing.mjs';

// The drawing raster engine (Rust, src/engine/engine-drawing.mjs) answers every request.
const engine=loadDrawingEngine();
let operations=null;

// The operations load on the first request, in the same bounded worker.
self.onmessage=async({data})=>{
  // The module's memory and instance (diagnostics and tests).
  if(data.kind==='engine'){
    try{await engine;}catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error),fatal:true});return;}
    self.postMessage({id:data.id,memory:drawingEngineMemory(),generation:drawingEngineGeneration()});return;
  }
  try{await engine;operations??=await import('./engine/engine-drawing-worker.mjs');}
  catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error),fatal:true});return;}
  await operations.drawingEngineOperation(data);
};
