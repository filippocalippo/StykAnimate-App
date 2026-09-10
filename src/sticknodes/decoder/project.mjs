/** Version-aware .stknds decoder. See docs/COMPATIBILITY.md for evidence levels. */
import {decodeFile,parseNodes,asBytes,inflateBytes,sha256,DecodeError,toBase64,CORPUS_NODE_PROFILES,unverifiedLayoutIssue} from './decoder.mjs';
import {BinaryReader,hex,colorAt,f32At,i32At} from './binary.mjs';
import {KNOWN_PROJECT_LAYOUT,recordReader,compilePoseLayout,readPoseRecord,skipPoseRecords,readInstanceHeader,readProjectHeader,readMainSettings,readProjectText,readCamera,readProjectTrailer} from './project-layout.mjs';
export const PROJECT_SCHEMA='sticknodes-project-lab/3';
// Backwards-compatible reference sizes, NOT used as the parser's layout.
export const PROFILE=Object.freeze({id:'417-35',version:417,build:35,figureHeader:132,nodePose:63,movieclipInstance:140,spriteInstance:136,spriteGroupInstance:140,mainFrameHeader:54,mainFrameFooter:40});
export const PROJECT_LIMITS=Object.freeze({input:256*1024*1024,output:512*1024*1024,assets:20000,frames:100000,instances:20000,totalInstances:1000000,totalPoses:5000000,pixels:64000000});
const kindNames=['figure','movieclip','sprite','sprite-group'];
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function openProject(input,{filename='project.stknds',onProgress=()=>{},validatePoses=true,signal,maxInputBytes=PROJECT_LIMITS.input,maxOutputBytes=PROJECT_LIMITS.output}={}){
 signal?.throwIfAborted();const sourceBytes=asBytes(input);
 for(const [name,value,cap]of [['maxInputBytes',maxInputBytes,PROJECT_LIMITS.input],['maxOutputBytes',maxOutputBytes,PROJECT_LIMITS.output]])if(!Number.isSafeInteger(value)||value<1||value>cap)throw new RangeError(`${name} must be an integer in 1..${cap}.`);
 if(sourceBytes.length>maxInputBytes)throw new DecodeError('INPUT_LIMIT',`Input exceeds the ${maxInputBytes}-byte limit.`);
 const original=new Uint8Array(sourceBytes);
 onProgress({phase:'Decompressing container',progress:.02});
 let payload,wrapper,prefixLength=0;
 if(original.length>=12&&[1,2,3,4,5,6,7,8,9].every((v,i)=>original[i]===v)){prefixLength=9;if(original[9]!==31||original[10]!==139)throw new DecodeError('BAD_CONTAINER','The 9-byte project prefix must be followed by gzip.',9);payload=await inflateBytes(original.subarray(9),'gzip',maxOutputBytes);wrapper='sticknodes-prefix+gzip';}
 else if(original[0]===31&&original[1]===139){payload=await inflateBytes(original,'gzip',maxOutputBytes);wrapper='gzip';}
 else{payload=original.slice();wrapper='raw';}
 signal?.throwIfAborted();if(payload.length>maxOutputBytes)throw new DecodeError('OUTPUT_LIMIT',`Payload exceeds the ${maxOutputBytes}-byte limit.`);
 const parse=/\.nodemc$/i.test(filename)?parseMovieClipPayload:parseProjectPayload;
 const document=await parse(payload,{onProgress,validatePoses,signal,[ownedPayload]:true});
 document.source={filename,wrapper,prefixLength,inputBytes:original.length,payloadBytes:payload.length,sha256:await sha256(original),payloadSha256:await sha256(payload)};
 document.original=original;
 onProgress({phase:'Project indexed',progress:1});return document;
}
const ownedPayload=Symbol('owned payload');
export async function parseProjectPayload(input,options={}){
 const {onProgress=()=>{},validatePoses=true,signal}=options;signal?.throwIfAborted();const inputBytes=asBytes(input);if(inputBytes.length>PROJECT_LIMITS.output)throw new DecodeError('OUTPUT_LIMIT','Payload exceeds 512 MiB.');
 const payload=options[ownedPayload]?inputBytes:new Uint8Array(inputBytes);
 const r=new BinaryReader(payload),version=r.i32(),build=version>=401?r.i32():1;
 if(version<1||build<0)r.fail('INVALID_PROJECT_PROFILE',`Project version must be positive and build nonnegative; got ${version}/${build}.`,'header',0);
 const guessedLayout=version<KNOWN_PROJECT_LAYOUT.minVersion||version>KNOWN_PROJECT_LAYOUT.maxVersion||build>KNOWN_PROJECT_LAYOUT.maxBuild;
 if(guessedLayout)onProgress({phase:`Trying untested project layout ${version}/${build}`,progress:.03});
 const name=r.string('project.name'),header=readProjectHeader(r,version,build);
 const doc=new ProjectDocument(payload);Object.assign(doc,{format:'stknds',schema:PROJECT_SCHEMA,profile:`${version}-${build}`,version,build,name,header,figures:[],sounds:[],sprites:[],movieclips:[],frames:[],sections:[],issues:[]});
 if(guessedLayout)doc.issues.push(unverifiedLayoutIssue('stknds',version,build));
 doc.poseLayouts={normal:compilePoseLayout(version,build),connector:compilePoseLayout(version,build,true)};
 doc.sections.push({name:'Project header / variable editor metadata',start:0,end:r.offset,status:'typed'});
 let sectionStart=r.offset,count=r.count('figureLibrary',PROJECT_LIMITS.assets);
 for(let index=0;index<count;index++){
  const start=r.offset,figureName=r.string('figure.name'),dataStart=r.offset,f=parseNodes(payload,{offset:r.offset,embedded:true,trace:false});r.offset=f.range.end;
  if(f.diagnostics.some(x=>x.severity==='error'))r.fail('INVALID_FIGURE_REFERENCES',`Figure ${index} has invalid references.`,'figures',dataStart);
  doc.figures.push({index,name:figureName,range:{start,end:r.offset},dataRange:{start:dataStart,end:r.offset},nodeCount:f.nodes.length,nodeIds:f.nodes.map(n=>n.id),connectorIndices:f.nodes.flatMap((n,i)=>n.connector?[i]:[]),polyfillCount:f.polyfills.length,features:f.features,version:f.version,build:f.build});
  if(index%32===0){onProgress({phase:`Indexing figure ${index+1} / ${count}`,progress:.05+.3*index/Math.max(1,count)});await pause();signal?.throwIfAborted();}
 }
 doc.sections.push({name:'Independently versioned figure library',start:sectionStart,end:r.offset,status:'parsed'});
 sectionStart=r.offset;count=version>=160?r.count('soundLibrary',PROJECT_LIMITS.assets):0;
 for(let index=0;index<count;index++){const start=r.offset,name=r.string('sound.name');doc.sounds.push({index,name,range:{start,end:r.offset},availability:'external-reference-only'});}
 doc.sections.push({name:'Sound references',start:sectionStart,end:r.offset,status:'parsed'});
 sectionStart=r.offset;count=version>=400?r.count('spriteLibrary',PROJECT_LIMITS.assets):0;
 for(let index=0;index<count;index++){
  const start=r.offset,type=r.u8(),spriteName=r.string('sprite.name'),sprite={index,name:spriteName,type,kind:type===0?'image':'group',range:{start,end:0}};
  if(type===1){const n=r.count('spriteGroup.members',PROJECT_LIMITS.assets);sprite.members=Array.from({length:n},()=>r.i32());}
  else if(type===0){sprite.alpha=r.flag();sprite.flag1=r.flag();sprite.pivotX=r.f32();sprite.pivotY=r.f32();sprite.field2=r.f32();sprite.field3=r.f32();sprite.samplingFlag=build>=9?r.flag():true;
   sprite.width=r.count('sprite.width',32768);sprite.height=r.count('sprite.height',32768);if(sprite.width*sprite.height>PROJECT_LIMITS.pixels)r.fail('PIXEL_LIMIT','Sprite exceeds pixel limit.');sprite.channels=sprite.alpha?4:3;const n=r.count('sprite.pixelBytes',PROJECT_LIMITS.output);if(n!==sprite.width*sprite.height*sprite.channels)r.fail('BAD_IMAGE_LENGTH','Image byte count does not match dimensions/channels.');sprite.pixelRange=r.skip(n,'sprite.pixels');}
  else r.fail('UNSUPPORTED_SPRITE_TYPE',`Unknown sprite type ${type}.`,'sprites',start);
  sprite.range.end=r.offset;doc.sprites.push(sprite);
 }
 for(const s of doc.sprites)if(s.members)for(const id of s.members)if(!doc.sprites[id]||doc.sprites[id].kind!=='image')r.fail('BAD_SPRITE_GROUP_REFERENCE',`Group ${s.index} references non-image ${id}.`,'sprites',s.range.start);
 doc.sections.push({name:'Sprites / raw pixel buffers',start:sectionStart,end:r.offset,status:'parsed'});
 sectionStart=r.offset;count=version>=300?r.count('movieclipLibrary',PROJECT_LIMITS.assets):0;doc.expectedMovieclips=count;
 const state={totalInstances:0,totalPoses:0,totalFrames:0,validatePoses};
 for(let index=0;index<count;index++){
  const start=r.offset,clipName=r.string('movieclip.name'),frameCount=r.count('movieclip.frames',PROJECT_LIMITS.frames),fps=r.count('movieclip.fps',1000),tweenCount=r.count('movieclip.tween',10000),flags=[r.flag(),r.flag()],nextInstanceId=r.i32(),frames=[];
  for(let fi=0;fi<frameCount;fi++)frames.push(readClipFrame(r,doc,state,fi));
  const libraryId=r.i32();doc.movieclips.push({index,name:clipName,range:{start,end:r.offset},fps,tweenCount,autoTween:flags[0],flags,nextInstanceId,libraryId,frames});
  onProgress({phase:`Parsing movie clip ${index+1} / ${count}`,progress:.36+.48*(index+1)/Math.max(1,count)});await pause();signal?.throwIfAborted();
 }
 doc.sections.push({name:'Movie clips / versioned frame poses',start:sectionStart,end:r.offset,status:'parsed'});
 sectionStart=r.offset;count=r.count('mainTimeline.frames',PROJECT_LIMITS.frames);
 for(let fi=0;fi<count;fi++){doc.frames.push(readMainFrame(r,doc,state,fi));if(fi%128===127){await pause();signal?.throwIfAborted();}}
 doc.sections.push({name:'Main timeline / texts / camera bindings',start:sectionStart,end:r.offset,status:'parsed'});
 sectionStart=r.offset;doc.trailer=readProjectTrailer(r,version,build);
 if(r.offset!==payload.length)r.fail('TRAILING_PROJECT_BYTES',`${payload.length-r.offset} bytes remain after the version-conditioned trailer. Refusing a potentially misaligned parse.`,'trailer');
 doc.sections.push({name:'Tween links / viewport / palette / editor pairs',start:sectionStart,end:r.offset,status:'typed'});
 doc.stats={figures:doc.figures.length,definitionNodes:doc.figures.reduce((s,f)=>s+f.nodeCount,0),polyfills:doc.figures.reduce((s,f)=>s+f.polyfillCount,0),movieclips:doc.movieclips.length,clipFrames:doc.movieclips.reduce((s,c)=>s+c.frames.length,0),mainFrames:doc.frames.length,instances:state.totalInstances,posedNodes:state.totalPoses,images:doc.sprites.filter(s=>s.kind==='image').length,spriteGroups:doc.sprites.filter(s=>s.kind==='group').length,soundReferences:doc.sounds.length,texts:doc.frames.reduce((s,f)=>s+f.texts.length,0),payloadBytes:payload.length,unaccountedBytes:payload.length-r.offset};
 const semanticChecks=validateProjectSemantics(doc);
 doc.validation={sequentialParse:true,sourceEOF:r.offset,expectedEOF:payload.length,allPosesChecked:validatePoses,referenceErrors:0,semanticChecks,universalCompatibility:false,layoutEvidence:'Version branches recovered from supplied Android loader; independently downloaded projects cover 417/35, 425/100, 426/104 and 430/115.',rendering:'Geometry and editing implemented; native pixel equivalence and advanced solver behavior not certified.'};
 doc.issues.push({severity:'warning',code:'UNKNOWN_FIELD_SEMANTICS',message:'Some editor flags, camera-binding parameters and legacy settings are typed and preserved, but their behavioral meanings are not established.'},{severity:'warning',code:'NATIVE_BEHAVIOR_GAPS',message:'Source-frame preview does not reproduce native tween scheduling, advanced constraint solvers, all filters, or exact text fonts. See per-frame rendering warnings and docs/COMPATIBILITY.md.'},{severity:'info',code:'KNOWN_LAYOUT_BOUNDARY',message:'Loader-derived layouts through 431/117. Successful parsing is not proof of native rendering equivalence.'});
 doc.validation.layoutMode=guessedLayout?'best-effort':'known';
 if(guessedLayout)doc.validation.layoutEvidence='Untested profile attempted using existing version-conditioned field rules; exact EOF and reference validation passed.';
 else if(version!==417||build!==35)doc.issues.push({severity:'warning',code:'ADDITIONAL_PROFILE',message:'This profile has a loader-derived layout but is not part of the independently supplied full-project regression corpus.'});
 return doc;
}
function readInstance(r,doc,state,{clip=false}={}){
 const start=r.offset,v=doc.version,b=doc.build,type=(v>=(clip?400:300))?r.i32():0,assetIndex=r.i32();
 if(type<0||type>3||clip&&type===1)r.fail('UNSUPPORTED_INSTANCE_TYPE',`Unsupported instance type ${type} in ${clip?'movie clip':'main'} frame.`,'instance',start);
 const library=type===0?doc.figures:type===1?null:doc.sprites;
 if(assetIndex<0||(type===1?assetIndex>=doc.expectedMovieclips:!library[assetIndex]))r.fail('BAD_ASSET_REFERENCE',`Type ${type} asset ${assetIndex} does not exist.`,'instance',start);
 if(type===2&&doc.sprites[assetIndex].kind!=='image'||type===3&&doc.sprites[assetIndex].kind!=='group')r.fail('BAD_SPRITE_REFERENCE','Sprite instance type differs from its asset.','instance',start);
 const instance={type,kind:kindNames[type],assetIndex,...readInstanceHeader(r,v,b,type)};
 if(++state.totalInstances>PROJECT_LIMITS.totalInstances)r.fail('INSTANCE_LIMIT','Too many instances.');
 if(type===0){const meta=doc.figures[assetIndex];instance.nodeCount=meta.nodeCount;instance.poseRange=skipPoseRecords(r,meta,doc.poseLayouts,state.validatePoses);state.totalPoses+=meta.nodeCount;if(state.totalPoses>PROJECT_LIMITS.totalPoses)r.fail('POSE_LIMIT','Too many node poses.');}
 instance.range={start,end:r.offset};return instance;
}
function readJoins(r,doc,instances,present=true){
 const joins=[],n=present?r.count('joins',PROJECT_LIMITS.instances):0,byId=new Map(),children=new Set();
 instances.forEach((i,k)=>{if(i.id<0)r.fail('INVALID_INSTANCE_ID',`Negative instance ID ${i.id}.`,'instance.id',i.headerRange.start);if(byId.has(i.id))r.fail('DUPLICATE_INSTANCE_ID',`Instance ID ${i.id} appears twice in one frame.`,'instance.id',i.headerRange.start);byId.set(i.id,k);});
 for(let j=0;j<n;j++){
  const start=r.offset,child=r.i32(),parentId=r.i32(),nodeId=r.i32(),relativeRotation=doc.build>=53?r.f32():null,parentIndex=byId.get(parentId);
  if(!instances[child]||parentIndex==null)r.fail('BAD_JOIN_INSTANCE','Join has an absent child index or parent ID.','join',start);
  if(children.has(child))r.fail('DUPLICATE_JOIN_CHILD','An instance cannot have multiple join parents.','join',start);children.add(child);
  const pi=instances[parentIndex];if(pi.type===0&&!doc.figures[pi.assetIndex].nodeIds.includes(nodeId))r.fail('BAD_JOIN_NODE',`Join target node ${nodeId} is absent.`,'join',start);
  joins.push({child,parentId,parentIndex,nodeId,relativeRotation,range:{start,end:r.offset}});
 }
 // A cyclic parent chain is not a valid rig. Do not let it hang rendering or editing.
 const parents=new Map(joins.map(j=>[j.child,j.parentIndex])),finished=new Set();for(const k of parents.keys()){const visited=new Set();let x=k;while(parents.has(x)&&!finished.has(x)){if(visited.has(x))r.fail('CYCLIC_JOINS','Cycle in instance joins.');visited.add(x);x=parents.get(x);}for(const id of visited)finished.add(id);}
 return joins;
}
/** Cross-record validation runs after all asset tables and timelines exist. */
export function validateProjectSemantics(doc){
 let checkedFrames=0,checkedInstances=0,checkedCursors=0;
 const invalid=(code,message,field,path)=>{throw new DecodeError(code,message,field?.start,path);};
 const fps=(value,field,path)=>{if(!Number.isInteger(value)||value<1||value>1000)invalid('INVALID_FPS',`${path} must be in 1..1000; got ${value}.`,field,path);};
 fps(doc.header.settings.fps,doc.header.settings.fieldRanges?.fps,'project.fps');
 for(const clip of doc.movieclips)fps(clip.fps,null,`movieclips[${clip.index}].fps`);
 for(const frames of [doc.frames,...doc.movieclips.map(c=>c.frames)])for(const frame of frames){checkedFrames++;
  for(const inst of frame.instances){checkedInstances++;
   if(inst.type===1){const count=doc.movieclips[inst.assetIndex].frames.length;
    for(const key of ['currentFrameIndex','startFrameIndex']){checkedCursors++;const value=inst[key];if(!Number.isInteger(value)||value<0||value>=Math.max(1,count))invalid('BAD_CLIP_CURSOR',`${key} ${value} is outside the ${count}-frame movie clip.`,inst.fieldRanges?.[key],key);}
   }else if(inst.type===3){checkedCursors++;const count=doc.sprites[inst.assetIndex].members.length,value=inst.groupFrame;if(!Number.isInteger(value)||value<0||value>=Math.max(1,count))invalid('BAD_SPRITE_CURSOR',`Sprite group frame ${value} is outside its ${count} images.`,inst.fieldRanges?.groupFrame,'groupFrame');}
  }
 }
 return {checkedFrames,checkedInstances,checkedCursors,idUniqueness:true,joinGraph:true,fpsRanges:true};
}
/** Standalone movie-clip envelope, recovered from native O2.b.n0 and K2.d.s.
 * Its figure/sprite/sound tables precede a single clip timeline and have their
 * own local reference namespace. Thumbnail RGBA bytes are retained verbatim.
 */
export async function parseMovieClipPayload(input,options={}){
 const {onProgress=()=>{},validatePoses=true,signal}=options;signal?.throwIfAborted();const source=asBytes(input);if(source.length>PROJECT_LIMITS.output)throw new DecodeError('OUTPUT_LIMIT','Movie clip payload exceeds 512 MiB.');
 const payload=options[ownedPayload]?source:new Uint8Array(source),r=new BinaryReader(payload),version=r.i32(),build=version>=402?r.i32():1;
 if(version<1||build<0)r.fail('INVALID_MOVIECLIP_PROFILE',`Movie-clip version must be positive and build nonnegative; got ${version}/${build}.`,'header',0);
 const guessedLayout=!(version>=300&&version<=431&&build<=117||CORPUS_NODE_PROFILES[`${version}-${build}`]);
 if(guessedLayout)onProgress({phase:`Trying untested movie-clip layout ${version}/${build}`,progress:.03});
 const name=r.string('movieclip.name'),frameCount=r.count('movieclip.frames',PROJECT_LIMITS.frames),figureCount=r.count('figureLibrary',PROJECT_LIMITS.assets),spriteCount=version>=400?r.count('spriteLibrary',PROJECT_LIMITS.assets):0,soundCount=r.count('soundLibrary',PROJECT_LIMITS.assets);
 const thumbnailCount=r.count('thumbnails.count',PROJECT_LIMITS.frames),thumbnailWidth=r.count('thumbnails.width',32768),thumbnailHeight=r.count('thumbnails.height',32768),thumbnailBytes=thumbnailCount*thumbnailWidth*thumbnailHeight*4;
 if(!Number.isSafeInteger(thumbnailBytes)||thumbnailBytes>PROJECT_LIMITS.output)r.fail('THUMBNAIL_LIMIT','Movie-clip thumbnails exceed the byte budget.');
 const thumbnailRange=r.skip(thumbnailBytes,'thumbnails.RGBA'),settings={},field=recordReader(r,settings);
 field('fps','i32');field('tweenCount','i32');field('autoTween','flag');field('clipFlag','flag');field('nextInstanceId','i32');
 const d=new ProjectDocument(payload);Object.assign(d,{format:'nodemc',schema:PROJECT_SCHEMA,profile:`${version}-${build}`,version,build,name,header:{settings},figures:[],sounds:[],sprites:[],movieclips:[],frames:[],expectedMovieclips:0,sections:[{name:'Movie-clip header and thumbnails',start:0,end:r.offset,status:'parsed'}],issues:[],trailer:null,thumbnails:{count:thumbnailCount,width:thumbnailWidth,height:thumbnailHeight,channels:4,range:thumbnailRange}});
 if(guessedLayout)d.issues.push(unverifiedLayoutIssue('nodemc',version,build));
 d.poseLayouts={normal:compilePoseLayout(version,build),connector:compilePoseLayout(version,build,true)};
 let sectionStart=r.offset;
 for(let index=0;index<figureCount;index++){const start=r.offset,figureName=r.string('figure.name'),dataStart=r.offset,f=parseNodes(payload,{offset:r.offset,embedded:true,trace:false});r.offset=f.range.end;
  if(f.diagnostics.some(x=>x.severity==='error'))r.fail('INVALID_FIGURE_REFERENCES',`Figure ${index} has invalid references.`,'figures',dataStart);
  d.figures.push({index,name:figureName,range:{start,end:r.offset},dataRange:{start:dataStart,end:r.offset},nodeCount:f.nodes.length,nodeIds:f.nodes.map(n=>n.id),connectorIndices:f.nodes.flatMap((n,i)=>n.connector?[i]:[]),polyfillCount:f.polyfills.length,features:f.features,version:f.version,build:f.build});
  if(index%32===0){onProgress({phase:`Indexing movie-clip figure ${index+1} / ${figureCount}`,progress:.1+.3*index/Math.max(1,figureCount)});await pause();signal?.throwIfAborted();}
 }
 d.sections.push({name:'Movie-clip figure definitions',start:sectionStart,end:r.offset,status:'parsed'});sectionStart=r.offset;
 const spriteIds=new Map();
 for(let index=0;index<spriteCount;index++){
  const start=r.offset,type=r.u8();if(type!==0&&type!==1)r.fail('UNSUPPORTED_SPRITE_TYPE',`Unknown sprite type ${type}.`);
  const sprite={index,type,kind:type===1?'group':'image',name:r.string('sprite.name'),sourceLibraryId:r.i32(),range:{start,end:0}};
  if(spriteIds.has(sprite.sourceLibraryId))r.fail('DUPLICATE_SPRITE_ID','Duplicate movie-clip sprite library ID.');spriteIds.set(sprite.sourceLibraryId,index);
  if(type===1){const count=r.count('spriteGroup.members',PROJECT_LIMITS.assets);sprite.sourceMembers=Array.from({length:count},()=>r.i32());}
  else{sprite.alpha=r.flag();sprite.flag1=r.flag();sprite.pivotX=r.f32();sprite.pivotY=r.f32();sprite.field2=r.f32();sprite.field3=r.f32();sprite.samplingFlag=build>=9?r.flag():true;sprite.width=r.count('sprite.width',32768);sprite.height=r.count('sprite.height',32768);if(sprite.width*sprite.height>PROJECT_LIMITS.pixels)r.fail('PIXEL_LIMIT','Sprite exceeds pixel budget.');sprite.channels=sprite.alpha?4:3;const count=r.count('sprite.pixelBytes',PROJECT_LIMITS.output);if(count!==sprite.width*sprite.height*sprite.channels)r.fail('BAD_IMAGE_LENGTH','Sprite pixel count differs from its dimensions.');sprite.pixelRange=r.skip(count,'sprite.pixels');}
  sprite.range.end=r.offset;d.sprites.push(sprite);
 }
 for(const sprite of d.sprites)if(sprite.sourceMembers)sprite.members=sprite.sourceMembers.map(id=>{const index=spriteIds.get(id);if(index==null||d.sprites[index].kind!=='image')r.fail('BAD_SPRITE_GROUP_REFERENCE',`Missing image ${id} in sprite group.`);return index;});
 d.sections.push({name:'Movie-clip sprite pixels and groups',start:sectionStart,end:r.offset,status:'parsed'});sectionStart=r.offset;
 for(let index=0;index<soundCount;index++){const start=r.offset,soundName=r.string('sound.name');d.sounds.push({index,name:soundName,range:{start,end:r.offset},availability:'external-reference-only'});}
 d.sections.push({name:'Movie-clip sound references',start:sectionStart,end:r.offset,status:'parsed'});sectionStart=r.offset;
 const state={totalInstances:0,totalPoses:0,totalFrames:0,validatePoses},frames=[];
 for(let index=0;index<frameCount;index++){frames.push(readClipFrame(r,d,state,index));if(index%32===31){await pause();signal?.throwIfAborted();}}
 if(r.offset!==payload.length)r.fail('TRAILING_MOVIECLIP_BYTES',`${payload.length-r.offset} unexplained bytes after the movie clip.`);
 d.movieclips.push({index:0,name,fps:settings.fps,tweenCount:settings.tweenCount,autoTween:settings.autoTween,flags:[settings.autoTween,settings.clipFlag],nextInstanceId:settings.nextInstanceId,libraryId:0,range:{start:sectionStart,end:r.offset},frames});
 d.sections.push({name:'Movie-clip stored frames',start:sectionStart,end:r.offset,status:'parsed'});
 d.stats={figures:d.figures.length,definitionNodes:d.figures.reduce((s,f)=>s+f.nodeCount,0),polyfills:d.figures.reduce((s,f)=>s+f.polyfillCount,0),movieclips:1,clipFrames:frames.length,mainFrames:0,instances:state.totalInstances,posedNodes:state.totalPoses,images:d.sprites.filter(s=>s.kind==='image').length,spriteGroups:d.sprites.filter(s=>s.kind==='group').length,soundReferences:d.sounds.length,texts:0,payloadBytes:payload.length,unaccountedBytes:0};
 d.validation={sequentialParse:true,sourceEOF:r.offset,expectedEOF:payload.length,allPosesChecked:validatePoses,referenceErrors:0,semanticChecks:validateProjectSemantics(d),universalCompatibility:false,layoutEvidence:'Standalone envelope and local asset references recovered from the supplied native loader; complete EOF required.'};
 d.validation.layoutMode=guessedLayout?'best-effort':'known';
 if(guessedLayout)d.validation.layoutEvidence='Untested profile attempted using existing version-conditioned field rules; exact EOF and reference validation passed.';
 d.issues.push({severity:'warning',code:'NATIVE_BEHAVIOR_GAPS',message:'Movie-clip source frames are available; native tween/play modes and all visual effects require separate compatibility checks.'});
 return d;
}
function checkFrameLimit(r,state){if(++state.totalFrames>PROJECT_LIMITS.frames)r.fail('FRAME_LIMIT','Too many frames in the whole project.');}
function readClipFrame(r,doc,state,index){
 checkFrameLimit(r,state);const start=r.offset,volume=r.f32(),pan=doc.version>=310?r.f32():0,pitch=doc.version>=310?r.f32():1,soundIndex=r.i32();
 if(soundIndex<-1||soundIndex>=doc.sounds.length)r.fail('BAD_SOUND_REFERENCE',`Sound index ${soundIndex} is absent.`);
 const n=r.count('clipFrame.instances',PROJECT_LIMITS.instances),instances=Array.from({length:n},()=>readInstance(r,doc,state,{clip:true})),joins=readJoins(r,doc,instances);
 return {index,range:{start,end:r.offset},settings:[volume,pan,pitch],sound:{volume,pan,pitch},soundIndex,instances,joins,texts:[]};
}
function readMainFrame(r,doc,state,index){
 checkFrameLimit(r,state);const start=r.offset,settings=readMainSettings(r,doc.version,doc.build),n=r.count('mainFrame.instances',PROJECT_LIMITS.instances),instances=Array.from({length:n},()=>readInstance(r,doc,state)),joins=readJoins(r,doc,instances,doc.version>=174);
 const nt=doc.version>=150?r.count('mainFrame.texts',10000):0,texts=Array.from({length:nt},(_,i)=>readProjectText(r,doc.version,doc.build,i)),camera=readCamera(r,doc.version,doc.build);
 if(settings.soundIndex<-1||settings.soundIndex>=doc.sounds.length)r.fail('BAD_SOUND_REFERENCE',`Sound ${settings.soundIndex} is absent.`);
 return {index,range:{start,end:r.offset},settings,instances,joins,texts,camera};
}
export class ProjectDocument {
 constructor(payload){this.payload=payload;this._figureCache=new Map();}
 getFigure(index,{trace=false}={}){const meta=this.figures[index];if(!meta)throw new RangeError(`No figure ${index}`);if(!trace&&this._figureCache.has(index)){const cached=this._figureCache.get(index);this._figureCache.delete(index);this._figureCache.set(index,cached);return cached;}const result=parseNodes(this.payload,{offset:meta.dataRange.start,embedded:true,trace});if(!trace){this._figureCache.set(index,result);if(this._figureCache.size>24)this._figureCache.delete(this._figureCache.keys().next().value);}return result;}
 getPoses(instance,{ranges=false}={}){
  if(instance.type!==0)return [];const base=this.getFigure(instance.assetIndex),r=new BinaryReader(this.payload,instance.poseRange.start);
  return base.nodes.map((node,i)=>({nodeId:node.id,sequenceIndex:i,...readPoseRecord(r,node.connector?this.poseLayouts.connector:this.poseLayouts.normal,{ranges})}));
 }
 posedFigure(instance){
  const base=this.getFigure(instance.assetIndex),poses=this.getPoses(instance),rootAngle=poses[0]?.local_angle??0,baseById=new Map(base.nodes.map(n=>[n.id,n]));
  const nodes=base.nodes.map((n,i)=>{
   const pose=poses[i],out={...n,...pose};
   // Static proxy limbs retain authored dimensions and appearance. They are not
   // world-space pins: their endpoints are still transformed by their ancestors.
   if(n.is_static){for(const key of ['length','thickness','scale','use_segment_scale','use_segment_color','color','use_gradient','gradient_color','gradient_mode','use_circle_outline','circle_outline_color','circle_is_hollow','trapezoid_thickness_start','trapezoid_thickness_end','trapezoid_top_thickness_ratio','trapezoid_is_rounded_start','trapezoid_is_rounded_end','curve_circulization','segment_curve_polyfill_precision'])if(n[key]!==undefined)out[key]=n[key];}
   if(n.is_static){let a=baseById.get(n.parentId);while(a?.is_static&&!a.connector)a=baseById.get(a.parentId);if(a?.is_smart_stretch)out.length=pose.length;}
   if(this.build<=53&&n.parentId===base.nodes[0].id)out.local_angle-=rootAngle;
   if(n.connector)out.connector={...n.connector,...Object.fromEntries(Object.entries(pose).filter(([k])=>k.startsWith('connector_')).map(([k,val])=>[k.slice(10),val]))};
   return out;
  });
  const byId=new Map(nodes.map(n=>[n.id,n]));
  return {...base,posed:true,version:this.version,build:this.build,definitionVersion:base.version,definitionBuild:base.build,scale:instance.scale,color:instance.color,nodes,polyfills:base.polyfills.map(p=>{const pose=byId.get(p.anchorId);return {...p,color:pose?.polyfill_color??p.color,use_polyfill_color:pose?.use_polyfill_color??p.use_polyfill_color}})};
 }
 getPixels(index){const s=this.sprites[index];if(!s?.pixelRange)throw new RangeError('Not an image sprite');return this.payload.subarray(s.pixelRange.start,s.pixelRange.end);}
 exportFrame(frame,{poses=true}={}){return {...frame,instances:frame.instances.map(i=>({...i,...(poses&&i.type===0?{poses:this.getPoses(i)}:{})}))};}
 manifest(){return {schema:this.schema,name:this.name,format:this.format,version:this.version,build:this.build,profile:this.profile,source:this.source,stats:this.stats,validation:this.validation,issues:this.issues,header:this.header,sections:this.sections,figures:this.figures,sounds:this.sounds,sprites:this.sprites,movieclips:this.movieclips.map(({frames,...c})=>({...c,frameCount:frames.length})),mainFrameCount:this.frames.length,trailer:this.trailer};}
 /** Portable clip bundle with the transitive asset closure. External sound files remain references. */
 exportClip(index){
  if(!this.movieclips[index])throw new RangeError('No such clip');
  const clipIds=new Set(),figureIds=new Set(),spriteIds=new Set();
  const visitSprite=id=>{if(spriteIds.has(id))return;spriteIds.add(id);for(const member of this.sprites[id].members??[])visitSprite(member);};
  const visitClip=id=>{if(clipIds.has(id))return;clipIds.add(id);for(const frame of this.movieclips[id].frames)for(const inst of frame.instances){if(inst.type===0)figureIds.add(inst.assetIndex);else if(inst.type===1)visitClip(inst.assetIndex);else visitSprite(inst.assetIndex);}};
  visitClip(index);
  const expandClip=id=>{const clip=this.movieclips[id];return {...clip,frames:clip.frames.map(f=>this.exportFrame(f))};};
  const spriteAssets=[...spriteIds].sort((a,b)=>a-b).map(id=>{const asset=this.sprites[id];return {...asset,...(asset.kind==='image'?{pixels:{encoding:'base64',layout:asset.channels===4?'RGBA8':'RGB8',data:toBase64(this.getPixels(id))}}:{})};});
  return {schema:'sticknodes-project-lab/clip@3',profile:this.profile,source:this.source,issues:this.issues,rootClipIndex:index,clip:expandClip(index),dependencyClips:[...clipIds].filter(id=>id!==index).sort((a,b)=>a-b).map(expandClip),figures:[...figureIds].sort((a,b)=>a-b).map(id=>({index:id,name:this.figures[id].name,...this.getFigure(id)})),spriteAssets,sounds:this.sounds,dependencyPolicy:'Transitive figure, movieclip and sprite dependencies are embedded. Numeric IDs retain their original project namespace. Audio is external.'};
 }
 rawRange(range){return this.payload.subarray(range.start,range.end);}
}

/** Open a project or a standalone .nodes asset through one application-facing API. */
export async function openDocument(input,options={}){
 const filename=options.filename??'project.stknds';
 if(!/\.nodes$/i.test(filename))return openProject(input,options);
 options.signal?.throwIfAborted();const bytes=asBytes(input);
 const maxInputBytes=options.maxInputBytes??32*1024*1024,maxOutputBytes=options.maxOutputBytes??64*1024*1024;
 for(const value of [maxInputBytes,maxOutputBytes])if(!Number.isSafeInteger(value)||value<1)throw new RangeError('Byte budgets must be positive integers.');
 if(bytes.length>maxInputBytes)throw new DecodeError('INPUT_LIMIT','Figure exceeds the input budget.');
 const report=await decodeFile(new Uint8Array(bytes),filename,{trace:false,maxOutputBytes:Math.min(maxOutputBytes,PROJECT_LIMITS.output)});options.signal?.throwIfAborted();
 if(report._payload.length>maxOutputBytes)throw new DecodeError('OUTPUT_LIMIT','Figure exceeds the output budget.');
 const figure=report.figures[0];
 if(!figure||report.diagnostics.some(d=>d.severity==='error')){const issue=report.diagnostics.find(d=>d.severity==='error');throw new DecodeError(issue?.code??'INVALID_FIGURE',issue?.message??'Figure could not be parsed.',issue?.offset);}
 if(figure.range.end!==report._payload.length)throw new DecodeError('TRAILING_FIGURE_BYTES','Standalone figure has unexplained trailing bytes.',figure.range.end);
 const d=new ProjectDocument(report._payload);const meta={index:0,name:filename.replace(/\.nodes$/i,''),range:figure.range,dataRange:figure.range,nodeCount:figure.nodes.length,nodeIds:figure.nodes.map(n=>n.id),polyfillCount:figure.polyfills.length,features:figure.features,version:figure.version,build:figure.build};
 Object.assign(d,{schema:PROJECT_SCHEMA,format:'nodes',profile:`${figure.version}-${figure.build}`,name:meta.name,version:figure.version,build:figure.build,figures:[meta],sounds:[],sprites:[],movieclips:[],frames:[],header:{settings:{fps:0,tweenCount:0}},trailer:null,original:report._original,source:{filename,wrapper:report.container.wrapper,prefixLength:report.container.prefixLength,inputBytes:report.originalBytes,payloadBytes:report.payloadBytes,sha256:report.sha256,payloadSha256:await sha256(report._payload)},stats:{figures:1,definitionNodes:figure.nodes.length,polyfills:figure.polyfills.length,movieclips:0,clipFrames:0,mainFrames:0,instances:0,posedNodes:0,images:0,spriteGroups:0,soundReferences:0,texts:0,payloadBytes:report.payloadBytes,unaccountedBytes:0},validation:{sequentialParse:true,sourceEOF:figure.range.end,expectedEOF:report.payloadBytes,allPosesChecked:true,referenceErrors:0,universalCompatibility:false,rendering:'Diagnostic approximation, not native fidelity certified.'},sections:[{name:'Standalone figure',start:0,end:figure.range.end,status:'parsed'}],issues:[...report.diagnostics,{code:'FIGURE_RENDERING_APPROXIMATION',message:'This is a standalone figure. No animation timeline is present. Native behavior and visual fidelity are not certified.'}]});
 // Preserve the detected byte order for legacy figures; do not reparse them as big-endian.
 d.getFigure=(index)=>{if(index!==0)throw new RangeError('No such figure');return figure;};
 options.onProgress?.({phase:'Figure indexed',progress:1});return d;
}
