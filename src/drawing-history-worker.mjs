import {errorMessageData, messageError} from './localized-error.mjs';

import {DrawingHistoryDatabase} from './drawing-history-database.mjs';
import {historyCodec,loadDrawingEngine} from './engine/engine-drawing.mjs';
// Undo chunks are encoded by the drawing raster engine (Rust).
const codec=loadDrawingEngine().then(()=>historyCodec);
let disk,queue=Promise.resolve();
// IDB commits and compression must finish in message order, including close.
self.onmessage=({data})=>{queue=queue.then(async()=>{
  try{
    disk??=new DrawingHistoryDatabase({session:data.session,externalLease:true,codec:await codec});
    let result;
    if(data.kind==='begin')await disk.begin(data.record);
    else if(data.kind==='append')await disk.append(data.record,data.tiles);
    else if(data.kind==='finish')result=await disk.finish(data.record);
    else if(data.kind==='info')result=await disk.info(data.record);
    else if(data.kind==='read'){const tiles=await disk.read(data.record,data.part);self.postMessage({id:data.id,tiles},tiles.flatMap(t=>[t.before?.buffer,t.after?.buffer].filter(Boolean)));return;}
    else if(data.kind==='remove')await disk.remove(data.record);
    else if(data.kind==='close'){await disk.open();await disk.close();}
    else throw messageError(new Error(''), "errors.drawingHistoryWorker.unknownDrawingHistoryOperation", {});
    self.postMessage({id:data.id,result});
  }catch(error){self.postMessage({id:data.id,error:{name:error.name,message:error.message, ...errorMessageData(error)}});}
});};
