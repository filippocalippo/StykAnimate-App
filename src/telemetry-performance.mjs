import { emptyPerformance,recordPerformance,coverage,addIncident,performanceContext,provenance,trimPerformance } from './telemetry-performance-schema.mjs';

// Long-frame script attribution (the module basename of a script that ran in a long animation frame): the engine's
// stage, playback and picture modules are the renderer; its other modules (the owner of the document, its editing
// reads, workers' clients) are the editor.
const STAGE_MODULE = /^engine-(stage|playback|composite|pictures|thumbnails|previews|shown|live-cels)\.mjs$/;
const ENGINE_MODULE = /^engine(-[a-z-]+)?\.mjs$/;

// No timers, document traversal, frame retention or clock conversion across workers.
export class PerformanceMeasurements {
  constructor(collector,{getContext=()=>({}),random=Math.random,now=()=>performance.now()}={}){
    this.collector=collector;this.getContext=getContext;this.random=random;this.now=now;this.reset();
  }
  reset(){this.generation=(this.generation||0)+1;this.data=emptyPerformance();this.recent=[];this.pending=[];this.recoveries=new Map();this.lastQuality=null;this.closedAt=null;this.resourcePhase='unknown';this.cachePrevious=null;}
  finish(){for(const kind of this.recoveries.keys())this.recovery(kind,'unresolved');}
  get enabled(){return this.collector.consent.diagnostics===true;}
  context(extra={}){return performanceContext({...this.getContext().performance,...extra});}
  record(metric,value,extra={},eligible=1,missed=0){if(this.enabled)recordPerformance(this.data,metric,value,this.context(extra),{},eligible,missed);}
  supported(kind,enabled){if(this.enabled)coverage(this.data,`${kind}_${enabled?'supported':'unsupported'}`);}
  sampleFrame(){if(!this.enabled)return false;coverage(this.data,'frame_candidates');if(this.random()>=1/30)return false;coverage(this.data,'frame_sampled');return true;}
  frame(duration,stages={},sampled=false){
    if(!this.enabled)return;
    const now=this.now();
    // End-of-render is a submission proxy, not a measurement of monitor scanout.
    for(const token of this.pending){
      if(now-token.at<=60000)recordPerformance(this.data,'action_'+token.action,now-token.at,token.context,{},0);
      else coverage(this.data,'action_unpresented');
    }
    this.pending.length=0;
    if(!sampled&&duration<100)return;
    const context=this.context();
    if(sampled){recordPerformance(this.data,'frame',duration,context);for(const [key,n] of Object.entries(stages))recordPerformance(this.data,key,n,context);}
    if(duration>=100)this.incident('stall',duration,stages,context);
    const gauges=this.getContext().gauges||{};
    this.recent.push([Math.min(1e9,duration),Math.min(1e9,Math.max(0,this.getContext().pending||0)),Math.min(1e9,Math.max(0,gauges.gpu_memory_mb||0))]);
    if(this.recent.length>4)this.recent.shift();
  }
  action(name){
    if(!this.enabled)return;
    this.closedAt=null;this.resourcePhase=this.context().phase;
    const action=['edit','seek','pan','zoom','undo','redo'].includes(name)?name:'command',context=this.context();
    coverage(this.data,'action_candidates');recordPerformance(this.data,'action_'+action,null,context);
    if(this.random()>=1/8)return;
    coverage(this.data,'action_sampled');
    if(this.pending.length>=8){this.pending.shift();coverage(this.data,'action_unpresented');}
    this.pending.push({action,at:this.now(),context});
  }
  boundary(){if(!this.enabled)return;coverage(this.data,'action_unpresented',this.pending.length);coverage(this.data,'background_excluded');this.pending=[];this.recent=[];this.lastQuality=null;}
  incident(kind,duration=0,stages={},context=this.context()){
    if(!this.enabled)return;
    addIncident(this.data,{kind,duration:Math.min(3600000,Math.max(0,duration)),context,provenance:provenance(),stages:Object.fromEntries(Object.entries(stages).filter(([,n])=>Number.isFinite(n)&&n>=0).slice(0,12)),recent:this.recent.map(row=>[...row])});
  }
  recovery(kind,state){
    if(!this.enabled)return;
    const now=this.now();
    if(state==='started'){if(this.recoveries.has(kind))return;this.recoveries.set(kind,now);this.record('recovery_'+kind,0,{outcome:'started'});return;}
    const started=this.recoveries.get(kind);if(started===undefined)return;
    this.record('recovery_'+kind,Math.min(3600000,now-started),{outcome:state});this.recoveries.delete(kind);
  }
  resources(phase){
    if(!this.enabled)return;
    const context=this.getContext(),extra=phase?{phase}:this.closedAt!==null&&this.now()-this.closedAt>=15000&&!context.playing?{phase:'idle'}:{};
    this.resourcePhase=this.context(extra).phase;
    this.record('memory_heap',globalThis.performance?.memory?.usedJSHeapSize/1048576,extra);
    this.record('memory_gpu',context.gauges?.gpu_memory_mb,extra);
    this.record('memory_cache',context.cacheBytes/1048576,extra);
    this.record('cache_pending',context.pending,extra);
    const now=this.now(),quality=context.performance?.quality;
    if(this.lastQuality&&quality==='reduced'&&this.lastQuality.quality==='reduced')this.record('quality_reduced',Math.min(15000,now-this.lastQuality.at));
    this.lastQuality={quality,at:now};
    for(const key of ['hits','misses','evictions']){
      const value=context.cache?.[key];
      if(Number.isFinite(value)&&Number.isFinite(this.cachePrevious?.[key])&&value>=this.cachePrevious[key])this.record('cache_'+key,value-this.cachePrevious[key]);
    }
    this.cachePrevious=context.cache?{hits:context.cache.hits,misses:context.cache.misses,evictions:context.cache.evictions}:null;
  }
  loaf(entries){
    if(!this.enabled)return;
    for(const entry of entries.slice(0,20)){
      this.record('loaf',entry.duration);
      if(entry.styleAndLayoutStart>0)this.record('loaf_layout',Math.max(0,entry.startTime+entry.duration-entry.styleAndLayoutStart));
      let scripts=0;for(const script of (entry.scripts||[]).slice(0,20)){
        scripts+=Math.max(0,script.duration||0);
        const module=String(script.sourceURL||'').split(/[\\/]/).at(-1)?.split('?')[0];
        const source=module==='app.mjs'?'app':STAGE_MODULE.test(module)?'renderer':['layer-timeline.mjs','sheet-filmstrip.mjs'].includes(module)?'timeline':module==='editor.mjs'||ENGINE_MODULE.test(module)?'editor':module==='camera-monitor.mjs'?'camera':/^vfx-[a-z-]+\.mjs$/.test(module)?'vfx':'other';
        this.record('loaf_script',script.duration,{source});
      }
      // Browser attribution URLs/invokers can contain user content. Only numeric totals survive.
      if(entry.duration>=100)this.incident('stall',entry.duration,{loaf:entry.duration,loaf_script:scripts});
    }
  }
  drain(){const now=this.now();this.pending=this.pending.filter(token=>{if(now-token.at<=60000)return true;coverage(this.data,'action_unpresented');return false;});const data=trimPerformance(this.data);this.data=emptyPerformance();return data;}
}
