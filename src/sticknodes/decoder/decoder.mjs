/**
 * Stick Nodes laboratory: version-aware .nodes reader + container inspection.
 * Format research based on sticknodes-rs (MIT), copyright 2025 vinceTheProgrammer.
 * See THIRD_PARTY_NOTICES.md. No Stick Nodes application code is included.
 * All ranges use zero-based, half-open byte offsets in the decoded payload.
 */
export const DECODER_VERSION = '0.4.0';
// These newer definition profiles use the same record layout in 59 independent
// file payloads from the official library. They are corpus-backed, not branches
// recovered from the older supplied APK. Other profiles attempt the existing
// version-conditioned layout and are explicitly marked as best-effort imports.
export const CORPUS_NODE_PROFILES=Object.freeze({'432-119':40,'433-120':17,'434-121':2});
export function unverifiedLayoutIssue(format,version,build){
  return {severity:'warning',code:'UNVERIFIED_LAYOUT',format,profile:`${version}-${build}`,assumption:'existing-version-branches',message:`Untested ${format} layout ${version}/${build}: the existing version-based layout rules were used. Review the imported result; structural validity does not establish visual or behavioral accuracy.`};
}
export const LIMITS = Object.freeze({inputBytes:32*1024*1024, outputBytes:512*1024*1024,
  nodes:10000, depth:1024, polyfills:10000, connections:10000, traceFields:250000,
  archiveEntries:256, signatureScan:4096, candidateScan:4*1024*1024});
export const NODE_TYPES = Object.freeze({'-1':'root',0:'rounded-segment',1:'segment',2:'circle',
  3:'triangle',4:'filled-circle',5:'ellipse',6:'trapezoid',7:'polygon'});

export class DecodeError extends Error {
  constructor(code, message, offset=0, path='') {
    super(message); this.name='DecodeError'; Object.assign(this,{code,offset,path});
  }
}
export function asBytes(input) {
  if(input instanceof Uint8Array) return input;
  if(input instanceof ArrayBuffer) return new Uint8Array(input);
  if(ArrayBuffer.isView(input)) return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}
export function toBase64(input) {
  const b=asBytes(input);
  if(typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s=''; for(let i=0;i<b.length;i+=16384) s+=String.fromCharCode(...b.subarray(i,i+16384));
  return btoa(s);
}
export function fromBase64(s) {
  if(typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s,'base64'));
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}
export async function sha256(input) {
  const b=asBytes(input);
  if(globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(typeof process!=='undefined' && process.versions?.node) return (await import('node:crypto')).createHash('sha256').update(b).digest('hex');
  return sha256Portable(b);
}

/** Portable SHA-256 fallback for offline/opaque browser contexts. */
export function sha256Portable(input) {
  const bytes=asBytes(input),K=new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w=new Uint32Array(64),block=new Uint8Array(64),v=new DataView(block.buffer),rotr=(x,n)=>(x>>>n)|(x<<(32-n));
  const blocks=Math.ceil((bytes.length+9)/64);
  for(let i=0;i<blocks;i++){
    const start=i*64;block.fill(0);block.set(bytes.subarray(start,Math.min(bytes.length,start+64)));
    if(bytes.length>=start&&bytes.length<start+64)block[bytes.length-start]=0x80;
    if(i===blocks-1){v.setUint32(56,Math.floor(bytes.length/0x20000000));v.setUint32(60,(bytes.length*8)>>>0);}
    for(let t=0;t<16;t++)w[t]=v.getUint32(t*4);
    for(let t=16;t<64;t++){const a=w[t-15],b=w[t-2];w[t]=(w[t-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[t-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=H;
    for(let t=0;t<64;t++){const p=(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[t]+w[t])>>>0,q=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+p)>>>0;d=c;c=b;b=a;a=(p+q)>>>0;}
    [a,b,c,d,e,f,g,h].forEach((x,j)=>H[j]=(H[j]+x)>>>0);
  }
  return [...H].map(x=>x.toString(16).padStart(8,'0')).join('');
}

class Reader {
  constructor(bytes, littleEndian=false, options={}) {
    this.b=asBytes(bytes); this.v=new DataView(this.b.buffer,this.b.byteOffset,this.b.length);
    this.o=options.offset??0; this.le=littleEndian; this.trace=[]; this.diagnostics=[];
    this.tracing=options.trace!==false;
  }
  need(n,path) {
    if(!Number.isSafeInteger(n)||n<0||this.o+n>this.b.length)
      throw new DecodeError('TRUNCATED',`Servono ${n} byte; ne restano ${this.b.length-this.o}.`,this.o,path);
  }
  field(type,path) {
    const sizes={u8:1,i8:1,i16:2,u16:2,i32:4,u32:4,f32:4}; const n=sizes[type]; this.need(n,path);
    const start=this.o; const methods={u8:'getUint8',i8:'getInt8',i16:'getInt16',u16:'getUint16',i32:'getInt32',u32:'getUint32',f32:'getFloat32'};
    const value=this.v[methods[type]](this.o,this.le); this.o+=n;
    if(type==='f32'&&!Number.isFinite(value)) throw new DecodeError('NON_FINITE',`Float non finito in ${path}.`,start,path);
    this.record(start,n,type,path,value); return value;
  }
  record(offset,length,type,path,value,rawValue) {
    if(this.tracing) {
      if(this.trace.length>=LIMITS.traceFields) throw new DecodeError('TRACE_LIMIT','Troppi campi da ispezionare.',offset,path);
      this.trace.push({offset,length,type,path,value,...(rawValue===undefined?{}:{rawValue})});
    }
  }
  flag(path) {
    const start=this.o; this.need(1,path); const raw=this.b[this.o++];
    if(raw>1) this.diagnostics.push({severity:'warning',code:'NON_CANONICAL_BOOL',offset:start,path,message:`Flag non canonico (${raw}); interpretato come vero.`});
    this.record(start,1,'bool',path,raw!==0,raw); return raw!==0;
  }
  color(path) {
    const start=this.o;this.need(4,path); const [a,b,g,r]=this.b.subarray(this.o,this.o+4);this.o+=4;
    const value={r,g,b,a,hex:'#'+[r,g,b,a].map(x=>x.toString(16).padStart(2,'0')).join('')};
    this.record(start,4,'color/ABGR',path,value);return value;
  }
  count(path,max,min=0) {
    const value=this.field('i32',path);
    if(value<min||value>max) throw new DecodeError('COUNT_LIMIT',`Conteggio ${value} fuori intervallo ${min}–${max}.`,this.o-4,path);
    return value;
  }
}

/** Only byte layout, not a promise of semantic or pixel-perfect compatibility. */
export function parseNodes(input, options={}) {
  const bytes=asBytes(input); if(bytes.length>LIMITS.outputBytes)throw new DecodeError('SIZE_LIMIT','Payload troppo grande.');
  const r=new Reader(bytes,options.littleEndian??false,options),start=r.o;
  const version=r.field('i32','header.version');
  if(version<1) throw new DecodeError('INVALID_VERSION',`Figure format version must be positive; got ${version}.`,start,'header.version');
  if(!options.embedded&&!r.le&&version<160) throw new DecodeError('LEGACY_ENDIAN','Versione legacy: attesa decompressione e lettura little-endian.',start);
  const build=version>=403?r.field('i32','header.build'):0;
  const corpusProfile=CORPUS_NODE_PROFILES[`${version}-${build}`];
  if(build<0) throw new DecodeError('INVALID_BUILD',`Figure build must be nonnegative; got ${build}.`,start+4,'header.build');
  if(!(version<=431&&build<=117)&&!corpusProfile)r.diagnostics.push(unverifiedLayoutIssue('nodes',version,build));
  if(corpusProfile)r.diagnostics.push({severity:'info',code:'CORPUS_VERIFIED_LAYOUT',message:`Figure layout ${version}/${build} verified against ${corpusProfile} library files; supplied native loader stops at 431/117.`});
  const scale=r.field('f32','header.scale'),color=r.color('header.color');
  const modern=(b)=>version>=403&&build>=b;
  const nodes=[],polyfills=[],connections=[];
  function readNode(parent,connectorFlag,depth) {
    if(nodes.length>=LIMITS.nodes)throw new DecodeError('NODE_LIMIT','Limite nodi raggiunto.',r.o);
    if(depth>LIMITS.depth)throw new DecodeError('DEPTH_LIMIT','Gerarchia troppo profonda.',r.o);
    const sequenceIndex=nodes.length,n={sequenceIndex,parentId:parent?.id??null,depth,children:[],range:{start:r.o,end:null}};
    const p=`nodes[${sequenceIndex}]`,f=(name,type='f32')=>(n[name]=r.field(type,`${p}.${name}`)),flag=name=>(n[name]=r.flag(`${p}.${name}`));
    if(connectorFlag) {
      const c={},cp=`${p}.connector`,cf=(name,type='f32')=>(c[name]=r.field(type,`${cp}.${name}`));
      cf('local_x');cf('local_y');cf('percent');if(build>=44)cf('percent_default');cf('value');cf('method','i32');
      c.reversed=r.flag(`${cp}.reversed`);if(build>=65)cf('smart_stretch_ancestral_value');n.connector=c;
    }
    const t=f('node_type','i8');
    if(NODE_TYPES[t]===undefined)throw new DecodeError('UNKNOWN_NODE_TYPE',`Tipo nodo sconosciuto: ${t}.`,r.o-1,`${p}.node_type`);
    n.kind=NODE_TYPES[t];n.id=f('draw_order_index','i32');
    if(n.id<0||n.id>1000000)throw new DecodeError('BAD_NODE_ID','Indice nodo non valido.',r.o-4,`${p}.draw_order_index`);
    if(sequenceIndex===0&&t!==-1)throw new DecodeError('ROOT_EXPECTED','Il primo record non è un nodo radice.',n.range.start,`${p}.node_type`);
    if(sequenceIndex>0&&t===-1)throw new DecodeError('MULTIPLE_ROOTS','Radice aggiuntiva nella gerarchia.',n.range.start);
    flag('is_static');flag('is_stretchy');if(modern(48))flag('is_floaty');
    if(version>=248)flag('is_smart_stretch');if(version>=252)flag('do_not_apply_smart_stretch');
    if(modern(50))flag('smart_stretch_reset_impulse');flag('use_segment_color');
    if(version>=256)flag('use_circle_outline');if(modern(21))flag('circle_is_hollow');
    if(version>=176){flag('use_gradient');flag('reverse_gradient');}if(modern(20))f('gradient_mode','i16');flag('use_segment_scale');
    f('local_x');f('local_y');f('scale');f('default_length');f('length');f('default_thickness','i32');f('thickness','i32');
    if(version>=320)f('segment_curve_radius_and_default_curve_radius','i32');
    if(modern(20))flag('curve_circulization');if(modern(21))f('segment_curve_polyfill_precision','i16');
    if(version>=256){flag('half_arc');f('right_triangle_direction','i16');}if(version>=300)flag('triangle_upside_down');
    if(modern(36)){f('trapezoid_thickness_start',build<64?'i32':'f32');f('trapezoid_thickness_end',build<64?'i32':'f32');}
    if(modern(36)&&build===36){f('reserved_build36_a','i32');f('reserved_build36_b','i32');flag('use_trapezoid_thickness_start');flag('use_trapezoid_thickness_end');}
    if(version>=256&&build!==36)f('trapezoid_top_thickness_ratio');
    if(modern(36)){flag('trapezoid_is_rounded_start');flag('trapezoid_is_rounded_end');}
    if(version>=256)f('num_polygon_vertices','i16');
    if(version>=248)f('default_local_angle');f('local_angle');if(version>=248)f('default_angle');
    n.color=r.color(`${p}.color`);if(version>=176)n.gradient_color=r.color(`${p}.gradient_color`);
    if(version>=256)n.circle_outline_color=r.color(`${p}.circle_outline_color`);
    if(modern(39))flag('is_angle_locked');
    if(modern(39)&&build<=50)f('reserved_angle_lock_39_50');
    if(modern(51))flag('angle_lock_is_main_node');
    if(modern(51)&&build<=56){f('angle_lock_offset_minuend');f('angle_lock_offset_subtrahend');}
    if(modern(57))f('angle_lock_offset');if(modern(63))f('angle_lock_relative_start');if(modern(67))f('angle_lock_stickfigure_start');
    if(modern(63))f('angle_lock_relative_multiplier','i8');
    if(modern(39)) {
      if(build<=40){n.is_drag_locked=r.field('i16',`${p}.is_drag_locked`)!==0;}else flag('is_drag_locked');
    }
    if(modern(41)&&build<=45)f('reserved_drag_lock_41_45','i16');
    if(modern(46))f('drag_lock_angle');if(modern(41))f('smart_stretch_multiplier');
    if(modern(41)&&build<=45)f('reserved_smart_stretch_41_45','u8');
    n.child_count=r.count(`${p}.child_count`,LIMITS.nodes);
    n.child_connector_flags=[];
    if(modern(38))for(let j=0;j<n.child_count;j++)n.child_connector_flags.push(r.field('i32',`${p}.child_connector_flags[${j}]`));
    n.range.end=r.o;nodes.push(n);if(parent)parent.children.push(n.id);return n;
  }
  const root=readNode(null,false,0),stack=[{node:root,next:0}];
  while(stack.length) {
    const s=stack[stack.length-1];
    if(s.next>=s.node.child_count){stack.pop();continue;}
    const flag=s.node.child_connector_flags[s.next++]??0;
    const child=readNode(s.node,flag!==0,s.node.depth+1);stack.push({node:child,next:0});
  }
  const ids=new Set();for(const n of nodes){if(ids.has(n.id))throw new DecodeError('DUPLICATE_ID',`Indice duplicato: ${n.id}.`,n.range.start);ids.add(n.id);}
  // Pre-1.6 compressed files do not have these later-version footers.
  if(version>=230) {
    const count=r.count('polyfills.count',LIMITS.polyfills);
    for(let i=0;i<count;i++) {
      const p=`polyfills[${i}]`,pf={range:{start:r.o}};
      pf.anchorId=r.field('i32',`${p}.anchorId`);pf.color=r.color(`${p}.color`);pf.use_polyfill_color=r.flag(`${p}.use_polyfill_color`);
      const size=r.count(`${p}.attached_count`,LIMITS.nodes);pf.attachedIds=[];
      for(let j=0;j<size;j++)pf.attachedIds.push(r.field('i32',`${p}.attachedIds[${j}]`));
      pf.range.end=r.o;polyfills.push(pf);
    }
  }
  if(modern(38)) {
    const count=r.count('connections.count',LIMITS.connections);
    for(let i=0;i<count;i++)connections.push({sourceId:r.field('i32',`connections[${i}].sourceId`),targetId:r.field('i32',`connections[${i}].targetId`)});
  }
  const diagnostics=r.diagnostics;
  // A connection source must be a connector and have one unambiguous target.
  const nodeMap=new Map(nodes.map(n=>[n.id,n])),connectionMap=new Map();
  for(const c of connections){if(!nodeMap.get(c.sourceId)?.connector||connectionMap.has(c.sourceId))diagnostics.push({severity:'error',code:'INVALID_CONNECTOR_SOURCE',message:`Invalid or repeated connector source ${c.sourceId}.`});connectionMap.set(c.sourceId,c.targetId);}
  const completed=new Set(),visiting=new Set();
  for(const first of nodes){const work=[{id:first.id,leave:false}];while(work.length){const {id,leave}=work.pop();if(leave){visiting.delete(id);completed.add(id);continue;}if(completed.has(id))continue;if(visiting.has(id))throw new DecodeError('CYCLIC_CONNECTORS','Connector and parent dependencies form a cycle.',r.o);const node=nodeMap.get(id);if(!node)continue;visiting.add(id);work.push({id,leave:true});for(const dependency of [node.parentId,connectionMap.get(id)])if(dependency!=null&&!completed.has(dependency))work.push({id:dependency,leave:false});}}
  for(const pf of polyfills)for(const id of [pf.anchorId,...pf.attachedIds])if(!ids.has(id))diagnostics.push({severity:'error',code:'DANGLING_POLYFILL',message:`Polyfill riferito al nodo assente ${id}.`,offset:pf.range.start});
  for(const c of connections)for(const id of [c.sourceId,c.targetId])if(!ids.has(id))diagnostics.push({severity:'error',code:'DANGLING_CONNECTION',message:`Connettore riferito al nodo assente ${id}.`});
  if(!options.embedded&&r.o!==bytes.length)diagnostics.push({severity:'warning',code:'TRAILING_BYTES',offset:r.o,message:`${bytes.length-r.o} byte finali non interpretati e conservati.`});
  const features=[...new Set(nodes.map(n=>n.kind).filter(k=>k!=='root'))];
  for(const [f,k] of [['use_gradient','gradients'],['is_smart_stretch','smart-stretch'],['is_floaty','floaty'],['is_angle_locked','angle-lock'],['is_drag_locked','drag-lock'],['circle_is_hollow','hollow-circle'],['half_arc','half-arc'],['segment_curve_radius_and_default_curve_radius','curves'],['connector','connectors']])if(nodes.some(n=>n[f]))features.push(k);
  if(polyfills.length)features.push('polyfills');
  const unknownFields=r.trace.filter(x=>x.path.includes('.reserved_')).map(x=>({offset:x.offset,length:x.length,path:x.path}));
  return {format:'nodes',version,build,scale,color,nodes,polyfills,connections,features,
    endian:r.le?'little':'big',range:{start,end:r.o},bytesRead:r.o-start,trace:r.trace,diagnostics,unknownFields,
    structuralStatus:diagnostics.some(x=>x.severity==='error')?'invalid-references':(!options.embedded&&r.o<bytes.length?'partial':'parsed'),
    rendererStatus:'approximate',sourceBasis:'sticknodes-rs@e946a8f28dce8367125664da61041619a3dd67bc'};
}

function zlibHeader(b,i) {return i+2<=b.length&&(b[i]&15)===8&&(b[i]>>4)<=7&&((b[i]<<8)+b[i+1])%31===0&&(b[i+1]&32)===0;}
function signatureAt(b,i) {
  if(b[i]===0x1f&&b[i+1]===0x8b&&b[i+2]===8)return 'gzip';
  return zlibHeader(b,i)?'deflate':null;
}
/** Bounded decompression: never materializes an unbounded Blob/Response. */
export async function inflateBytes(input, format='deflate', maxBytes=LIMITS.outputBytes) {
  const b=asBytes(input);
  if(typeof process!=='undefined'&&process.versions?.node) {
    const z=await import('node:zlib');const fn=format==='gzip'?z.gunzipSync:format==='deflate-raw'?z.inflateRawSync:z.inflateSync;
    try{return new Uint8Array(fn(b,{maxOutputLength:maxBytes}));}catch(e){throw new DecodeError('DECOMPRESSION_FAILED',e.message);}
  }
  if(typeof DecompressionStream==='undefined')throw new DecodeError('NO_DECOMPRESSION','Questo browser non dispone di DecompressionStream.');
  const stream=new Blob([b]).stream().pipeThrough(new DecompressionStream(format));
  const reader=stream.getReader();let size=0;const chunks=[];
  try {
    while(true) {const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>maxBytes)throw new DecodeError('OUTPUT_LIMIT','Limite del payload decompresso superato.');chunks.push(value);}
  }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const out=new Uint8Array(size);let o=0;for(const c of chunks){out.set(c,o);o+=c.length;}return out;
}

export async function unwrapContainer(input, options={}) {
  const bytes=asBytes(input);if(bytes.length>LIMITS.inputBytes)throw new DecodeError('INPUT_LIMIT','File oltre il limite di 32 MiB.');
  const scan=Math.min(bytes.length-2,options.scanBytes??LIMITS.signatureScan);const attempts=[];
  // Raw recognizable figure first: random byte patterns inside a figure are NOT compression headers.
  if(bytes.length>=16) {
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length).getInt32(0,false);
    const rootOffset=v>=403?16:12;
    if(v>=160&&!signatureAt(bytes,0)&&bytes[rootOffset]===255&&options.preferRawNodes) return {payload:bytes,wrapper:'none',prefixLength:0,prefix:new Uint8Array(),attempts};
  }
  let tried=0;
  for(let i=0;i<=scan;i++) {
    const format=signatureAt(bytes,i);if(!format)continue;
    if(++tried>32)break;
    try {const payload=await inflateBytes(bytes.subarray(i),format,options.maxOutputBytes??LIMITS.outputBytes);
      return {payload,wrapper:format==='deflate'?'zlib':'gzip',prefixLength:i,prefix:bytes.slice(0,i),attempts};
    }catch(e){attempts.push({offset:i,format,error:e.code??'DECOMPRESSION_FAILED'});}
  }
  return {payload:bytes,wrapper:'none',prefixLength:0,prefix:new Uint8Array(),attempts};
}

export function inspectStrings(input, options={}) {
  const b=asBytes(input),min=options.minLength??5,max=options.maxStrings??120,strings=[];let start=-1;
  for(let i=0;i<=b.length&&strings.length<max;i++) {
    const c=b[i];if(c>=32&&c<127){if(start<0)start=i;}
    else if(start>=0){if(i-start>=min)strings.push({offset:start,length:i-start,text:new TextDecoder().decode(b.subarray(start,Math.min(i,start+256))),truncated:i-start>256});start=-1;}
  }
  return strings;
}
/** Heuristic carving only. It is NOT a movieclip/project parser. */
export function findEmbeddedNodes(input, options={}) {
  const b=asBytes(input),view=new DataView(b.buffer,b.byteOffset,b.length),found=[];
  const scan=Math.min(b.length-16,options.scanBytes??LIMITS.candidateScan);let attempts=0;
  for(let o=0;o<=scan;o++) {
    if(b[o]!==0||b[o+1]!==0)continue;
    const version=view.getInt32(o,false);if(version<160)continue;
    const rootOffset=o+(version>=403?16:12);
    if(rootOffset>=b.length||b[rootOffset]!==255)continue;
    if(++attempts>256)break;
    try {
      const fig=parseNodes(b,{offset:o,embedded:true,trace:options.trace??false});
      if(fig.nodes.length<2||fig.diagnostics.some(x=>x.severity==='error'))continue;
      found.push({...fig,candidate:true,confidence:'structurally-valid-unverified-context'});o=fig.range.end-1;
      if(found.length>=32)break;
    }catch{/* A signature is not evidence of a valid embedded figure. */}
  }
  return found;
}
export function inspectMagic(input) {
  const b=asBytes(input),sig=[...b.subarray(0,16)].map(v=>v.toString(16).padStart(2,'0')).join(' ');
  let recognized='opaque';
  if(b[0]===0x50&&b[1]===0x4b)recognized='zip';
  else if(b[0]===0xac&&b[1]===0xed&&b[2]===0&&b[3]===5)recognized='java-object-stream';
  else if(b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71)recognized='png';
  return {recognized,first16:sig};
}

/** Public entry point. Unknown blocks are retained, never guessed into a timeline. */
export async function decodeFile(input, filename='input.nodes', options={}) {
  const original=asBytes(input);if(original.length>LIMITS.inputBytes)throw new DecodeError('INPUT_LIMIT','File oltre il limite di 32 MiB.');
  const ext=filename.toLowerCase().split('.').pop();
  const container=await unwrapContainer(original,{...options,preferRawNodes:ext==='nodes'}),payload=container.payload;
  const report={schema:'sticknodes-lab/report@1',decoderVersion:DECODER_VERSION,filename,
    kind:ext==='nodes'?'figure':ext==='nodemc'?'movieclip':ext==='stknds'?'project':'unknown',
    originalBytes:original.length,payloadBytes:payload.length,sha256:await sha256(original),
    container:{wrapper:container.wrapper,prefixLength:container.prefixLength,prefixBase64:toBase64(container.prefix),attempts:container.attempts},
    status:'uninterpreted',figures:[],diagnostics:[],strings:[],magic:inspectMagic(payload),
    timeline:null,coverage:{structuredPayloadBytes:0,payloadBytes:payload.length,claim:'byte-layout-only; not feature completeness'},
    _original:original,_payload:payload};
  if(ext==='nodes'||options.forceNodes) {
    const endianCandidates=container.wrapper!=='none'?[false,true]:[false,true];const errors=[];
    for(const littleEndian of endianCandidates) {
      try {
        const fig=parseNodes(payload,{littleEndian,trace:options.trace??true});report.figures=[fig];report.status=fig.structuralStatus;
        report.diagnostics.push(...fig.diagnostics);report.coverage.structuredPayloadBytes=fig.bytesRead;break;
      }catch(e){errors.push(e);}
    }
    if(!report.figures.length) {
      const e=errors.find(x=>x.code!=='INVALID_VERSION'&&x.code!=='LEGACY_ENDIAN')??errors[0];
      report.status='unsupported-or-invalid';report.diagnostics.push({severity:'error',code:e.code??'PARSE_ERROR',message:e.message,offset:e.offset,path:e.path});
    }
  }else {
    report.strings=inspectStrings(payload);report.figures=findEmbeddedNodes(payload,{trace:options.trace??true});
    report.status='container-only';
    report.diagnostics.push({severity:'warning',code:'SEMANTIC_FORMAT_NOT_IMPLEMENTED',message:'Contenitore ispezionato. Scene, fotogrammi, trasformazioni, audio e filtri di .stknds/.nodemc NON sono ancora decodificati.'});
    if(report.figures.length)report.diagnostics.push({severity:'warning',code:'HEURISTIC_CANDIDATES',message:`${report.figures.length} candidati .nodes strutturalmente validi; posizione e ruolo nella scena non verificati.`});
  }
  return report;
}

export function toInterchange(report,{includeOriginal=true,includeTrace=false}={}) {
  const {_original,_payload,...rest}=report;
  const figures=report.figures.map(f=>{const {trace,...fig}=f;return includeTrace?f:fig;});
  return {...rest,schema:'sticknodes-lab/interchange@1',figures,
    integration:{coordinates:'source-fields-preserved',angleUnit:'degrees',colors:'RGBA-0..255',
      ids:'source-draw-order-indices',animationSupported:false,behaviorSolverIncluded:false,
      note:'Non è il formato nativo di StykAnimate. Serve un adattatore esplicito; non scartare i campi sorgente.'},
    ...(includeOriginal?{source:{encoding:'base64',originalBase64:toBase64(_original),payloadBase64:toBase64(_payload)}}:{})};
}

/** Position-based byte comparison, useful for controlled exports. Not semantic alignment. */
export function diffBytes(a,b,maxRanges=200) {
  a=asBytes(a);b=asBytes(b);const ranges=[];let start=-1,differentBytes=0;
  for(let i=0;i<=Math.max(a.length,b.length);i++) {
    const different=i<Math.max(a.length,b.length)&&a[i]!==b[i];if(different){differentBytes++;if(start<0)start=i;}
    else if(start>=0){if(ranges.length<maxRanges)ranges.push({start,end:i,length:i-start});start=-1;}
  }
  return {mode:'positional-not-semantic',aBytes:a.length,bBytes:b.length,differentBytes,ranges,truncated:ranges.reduce((s,r)=>s+r.length,0)<differentBytes};
}

export function hexDump(input,start=0,length=512) {
  const b=asBytes(input);start=Math.max(0,start);const end=Math.min(b.length,start+length),lines=[];
  for(let i=start;i<end;i+=16){const row=b.subarray(i,Math.min(i+16,end));
    lines.push(i.toString(16).padStart(8,'0')+'  '+[...row].map(x=>x.toString(16).padStart(2,'0')).join(' ').padEnd(47)+'  '+[...row].map(x=>x>=32&&x<127?String.fromCharCode(x):'.').join(''));}
  return lines.join('\n');
}
