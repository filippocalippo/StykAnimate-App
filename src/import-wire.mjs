/** Lossless receiver for the backend-validated native v5 frame table. */
export const NATIVE_FRAME_CONTENT_TYPE = 'application/vnd.stykanimate.piv-frames-v1';
const MAX_BYTES = 256 * 1024 * 1024;
// A separate inventory limit prevents a tiny-number binary stream from expanding
// into an unbounded object graph. This is an estimate, not a JS heap measurement.
const MAX_POSE_BYTES = 2560 * 1024 * 1024;
export function unpackNativeFrameResponse(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16 || buffer.byteLength > MAX_BYTES)
    throw new Error('Invalid native frame response size.');
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 8)) !== 'STYKPIV1') throw new Error('Invalid native frame response signature.');
  const size = view.getUint32(8, true), offset = 12 + size;
  if (offset > buffer.byteLength) throw new Error('Truncated native frame response header.');
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, size)));
  if (!result.ok || result.document?.version !== 5 || result.nativeFrames?.version !== 1 ||
      result.nativeFrames.byteLength !== buffer.byteLength - offset || !Number.isSafeInteger(result.nativeFrames.sourceOffset))
    throw new Error('Invalid native frame response metadata.');
  return {result, buffer, offset};
}

function* frameSteps(report, bytes, byteOffset, sourceOffset, timeBudgetMs, stats) {
  const view = new DataView(bytes, byteOffset); let pos = 0;
  let poseBytes=0;
  const reserve=size=>{poseBytes+=size;if(poseBytes>MAX_POSE_BYTES) throw new Error(`Native scene exceeds the ${MAX_POSE_BYTES / (1024 * 1024)} MiB pose budget.`);};
  const ensure = size => {if (pos + size > view.byteLength) throw new Error('Truncated native frame table.');};
  const u8 = () => {ensure(1); return view.getUint8(pos++);};
  const u16 = () => {ensure(2); const v=view.getUint16(pos,true); pos+=2; return v;};
  const u32 = () => {ensure(4); const v=view.getUint32(pos,true); pos+=4; return v;};
  const floating = (size) => {ensure(size); const v=size===8?view.getFloat64(pos,true):view.getFloat32(pos,true); pos+=size;
    if (!Number.isFinite(v)) throw new Error('Nonfinite native pose value.'); return v;};
  const array = (size,count) => {ensure(size*count); const values=new Array(count);
    for(let i=0;i<count;i++) values[i]=floating(size); return values;};
  function* largeArray(size,count) {
    ensure(size*count); const values=new Array(count);
    for(let i=0;i<count;i++) {
      values[i]=floating(size);
      if((i&4095)===4095&&performance.now()-taskStarted>=timeBudgetMs) {
        stats.maxTaskMs=Math.max(stats.maxTaskMs,performance.now()-taskStarted); yield; taskStarted=performance.now();
      }
    }
    return values;
  }
  const types=new Map(report.figure_types.map(f=>[f.figure_type_id,f]));
  const count=u32(); if(count>1000000) throw new Error('Invalid native frame count.');
  reserve(512*count);
  const frames=new Array(count); let taskStarted=performance.now(), visited=0,visitedFloats=0;
  for(let fi=0;fi<count;fi++) {
    const start=pos+sourceOffset, duration=u16(), mix=u8(), background=u16(), backgroundB=mix?u16():null;
    const objectCount=u16(), objects=new Array(objectCount);
    for(let oi=0;oi<objectCount;oi++) {
      const objectStart=pos+sourceOffset, uid=u32(), tid=u16(), figure=types.get(tid);
      if(!figure) throw new Error('Unknown native figure type.');
      const segmentCount=figure.segment_count;
      if(!Number.isInteger(segmentCount)||segmentCount<0||segmentCount>30000) throw new Error('Invalid native segment count.');
      reserve(512+24*segmentCount);
      const scale=floating(4), color=u32(), field28=u8();
      const object={object_slot:oi,unique_id:uid,figure_type_id:tid,scale,color_override_raw:color,field28};
      if(figure.image_assets?.length||figure.text_assets?.length) object.image_text_flags=u8();
      object.angles=segmentCount>4096?yield* largeArray(8,segmentCount):array(8,segmentCount); object.root_x=floating(4); object.root_y=floating(4);
      object.color_override_rgb=[color&255,(color>>>8)&255,(color>>>16)&255];
      object.color_override_mix=color>>>24; object.transparency=field28; object.opacity=1-field28/255;
      object.len_flag=u16(); if(object.len_flag) reserve(24*segmentCount);
      object.lengths=object.len_flag?(segmentCount>4096?yield* largeArray(4,segmentCount):array(4,segmentCount)):[];
      object.bend_flag=u16(); if(object.bend_flag) reserve(24*segmentCount);
      object.bends=object.bend_flag?(segmentCount>4096?yield* largeArray(8,segmentCount):array(8,segmentCount)):[];
      object.join=u8()?{target_object_slot:u16(),target_handle_id:u16()}:null;
      if(object.join) reserve(64);
      object.record_offset=objectStart; object.record_end=pos+sourceOffset; objects[oi]=object;
      visited++; visitedFloats+=segmentCount*(1+Number(!!object.len_flag)+Number(!!object.bend_flag));
      if(visited>=32||visitedFloats>=4096) {
        visited=visitedFloats=0;
        if(performance.now()-taskStarted>=timeBudgetMs) {
          stats.maxTaskMs=Math.max(stats.maxTaskMs,performance.now()-taskStarted); yield; taskStarted=performance.now();
        }
      }
    }
    for(const object of objects) if(object.join) {
      const target=objects[object.join.target_object_slot];
      if(!target) throw new Error('Invalid native joined figure slot.'); object.join.target_unique_id=target.unique_id;
    }
    const order=new Array(objectCount); for(let i=0;i<objectCount;i++) {order[i]=u16(); if(order[i]>=objectCount) throw new Error('Invalid native draw order.');}
    const isDefault=!!u8(), camera={is_default:isDefault,x:0,y:0,angle_rad:0,scale:1};
    if(!isDefault) {camera.x=floating(4); camera.y=floating(4); camera.angle_rad=floating(8); camera.scale=floating(4);}
    frames[fi]={keyframe_index:fi,duration_raw:duration,inbetweens:duration-1,hidden:duration===0,
      background_mix:mix,background_id:background,background_id_b:backgroundB,objects,object_draw_order:order,
      object_draw_order_unique_ids:order.map(i=>objects[i].unique_id),camera,record_offset:start,record_end:pos+sourceOffset};
    if(performance.now()-taskStarted>=timeBudgetMs) {
      stats.maxTaskMs=Math.max(stats.maxTaskMs,performance.now()-taskStarted); yield; taskStarted=performance.now();
    }
  }
  if(pos!==view.byteLength) throw new Error('Unexpected bytes after the native frame table.');
  stats.maxTaskMs=Math.max(stats.maxTaskMs,performance.now()-taskStarted);
  return frames;
}

const yieldTask = globalThis.scheduler?.yield ? () => globalThis.scheduler.yield() : () => new Promise(resolve => {
  const channel=new MessageChannel(); channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);
});
export async function materializeNativeFrames(result, buffer, offset, {isCancelled=()=>false, timeBudgetMs=3, yieldControl=yieldTask}={}) {
  const started=performance.now(), stats={maxTaskMs:0,tasks:0}, meta=result.nativeFrames;
  if(!meta||meta.version!==1||!Number.isSafeInteger(meta.sourceOffset)||meta.sourceOffset<0||
    !(buffer instanceof ArrayBuffer)||!Number.isInteger(offset)||offset<0||buffer.byteLength-offset!==meta.byteLength)
    throw new Error('Invalid native frame transfer.');
  const iterator=frameSteps(result.document,buffer,offset,meta.sourceOffset,timeBudgetMs,stats);
  for(;;) {
    if(isCancelled()) throw new DOMException('Import cancelled.','AbortError');
    const step=iterator.next(); stats.tasks++;
    if(step.done) {result.document.keyframes=step.value; break;}
    await yieldControl();
  }
  result.timings={...result.timings,native_materialize_ms:+(performance.now()-started).toFixed(3),
    native_materialize_max_task_ms:+stats.maxTaskMs.toFixed(3),native_materialize_tasks:stats.tasks};
  delete result.nativeFrames; return result;
}
