import {errorMessageData} from './localized-error.mjs';
import {StrokeEngine,loadDrawingEngine} from './engine/engine-drawing.mjs';

// The drawing raster engine (Rust) paints. Messages wait for it, in their order.
const ready=loadDrawingEngine().then(()=>new StrokeEngine());
let queue=Promise.resolve();

self.onmessage=({data})=>{queue=queue.then(()=>ready).then(engine=>handle(engine,data)).catch(error=>self.postMessage({kind:'error',stroke:data.stroke,message:error.message, ...errorMessageData(error)}));};

function handle(engine,data){
  const {kind,stroke:id}=data;
  try{
    if(kind==='begin')engine.begin(id,data.settings);
    else if(kind==='dabs'){
      const result=engine.dabs(id,data.seq,data.dabs,data.tiles,data.tail);
      if(result)self.postMessage({kind:'tiles',stroke:id,seq:data.seq,tiles:result.tiles,dirty:result.dirty},result.tiles.map(t=>t.pixels));
    }
    else if(kind==='end'){
      const changes=engine.end(id);
      self.postMessage({kind:'done',stroke:id,changes:changes??[]},(changes??[]).flatMap(c=>[c.before?.buffer,c.after?.buffer].filter(Boolean)));
    }
    else if(kind==='cancel')engine.cancel(id);
  }catch(error){engine.cancel(id);self.postMessage({kind:'error',stroke:id,message:error.message, ...errorMessageData(error)});}
}
