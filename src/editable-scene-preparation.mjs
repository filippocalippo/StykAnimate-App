/** Coordinates one cancellable return to the editable canvas. Preparation never
 * records an edit, moves the playhead, or publishes a superseded scene. */
export class EditableScenePreparation {
  constructor(editor,{onPending=()=>{},onReady=()=>{},onError=()=>{}}={}){
    Object.assign(this,{editor,onPending,onReady,onError});this.job=null;this.stats=null;
  }
  get pending(){return Boolean(this.job);}
  cancel(){
    const job=this.job;if(!job)return;
    this.job=null;job.controller.abort();job.prepared?.dispose();
    this.stats={...job.timings,cancelled:true,elapsedMs:performance.now()-job.started};this.onPending(false);
  }
  start(renderer,getOptions){
    this.cancel();const editor=this.editor,report=editor.report,tick=editor.tick,revision=editor.revision,draftRevision=editor.frameDraftRevision;
    const job={controller:new AbortController(),started:performance.now(),timings:{}};this.job=job;this.onPending(true);
    const checkCurrent=()=>this.job===job&&editor.report===report&&editor.tick===tick&&editor.revision===revision&&editor.frameDraftRevision===draftRevision;
    job.promise=(async()=>{
      // Let the transport state and its last presented frame paint first.
      await new Promise(resolve=>requestAnimationFrame(resolve));
      if(!checkCurrent())throw new DOMException('Editable preparation was cancelled.', 'AbortError');
      const geometry=await editor.prepareGeometry({signal:job.controller.signal,checkCurrent,onTiming:value=>{job.timings.geometry=value;}});
      if(!checkCurrent())throw new DOMException('Editable preparation was superseded.', 'AbortError');
      const options=getOptions(geometry);
      job.prepared=await renderer.prepareSceneUpdate({...options,report,geometry,signal:job.controller.signal,checkCurrent});
      if(!checkCurrent())throw new DOMException('Editable preparation was superseded.', 'AbortError');
      job.prepared.activate();job.timings.gpu=job.prepared.timings;
      this.stats={...job.timings,completed:true,elapsedMs:performance.now()-job.started};
      this.job=null;this.onPending(false);this.onReady();return true;
    })().catch(error=>{
      job.prepared?.dispose();
      if(this.job===job){
        this.job=null;this.stats={...job.timings,cancelled:error.name==='AbortError',error:error.name==='AbortError'?undefined:error.message,elapsedMs:performance.now()-job.started};
        this.onPending(false);this.onReady();
        if(error.name!=='AbortError')this.onError(error);
      }
      return false;
    });
    return job.promise;
  }
}
