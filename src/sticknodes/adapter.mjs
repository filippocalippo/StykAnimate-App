/** Stick Nodes -> authoritative StykAnimate document. No source bytes or runtime
 * decoder objects enter editor history. Definitions and clip timelines stay shared. */
import {openDocument} from './decoder/project.mjs';
import {unpackZip,isZip} from './decoder/archive.mjs';
import {toBase64} from './decoder/decoder.mjs';
import {layoutFigure} from './decoder/renderer.mjs';
import {encodePNGPortable} from './decoder/png-browser.mjs';
import {movieclipFigure} from '../movieclips.mjs';
import {createImageFigure,createImageBackground} from '../media-authoring.mjs';
import {createTextFigure,loadTextFont,parseTextFont} from '../text-authoring.mjs';

const rad=Math.PI/180, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),rgb=c=>[c?.r??0,c?.g??0,c?.b??0],alpha=c=>(c?.a??255)/255;
const rgbNumber=c=>((c?.r??0)<<16|(c?.g??0)<<8|(c?.b??0))>>>0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),yieldImport=()=>new Promise(r=>setTimeout(r,0));
export const STICKNODES_EXTENSIONS=/\.(nodes|nodemc|stknds|zip)$/i;
function nativeFrame(objects,duration=1){return {duration_raw:duration,background_id:0,background_id_b:0,background_mix:0,camera:{is_default:true,x:0,y:0,scale:1,angle_rad:0},objects,object_draw_order:objects.map((_,i)=>i),object_draw_order_unique_ids:objects.map(o=>o.unique_id)};}
function nativeDocument(name,fps,figures,frames){return {version:5,canvas_width:1920,canvas_height:1080,fps,auto_easing:false,auto_easing_disabled_raw:1,auto_easing_source:'file',figure_types:figures,backgrounds:[],keyframes:frames.length?frames:[nativeFrame([])],_styk:{format:'StykAnimate',format_version:1,name}};}
function nativeObject(figure,id,x,y){return {object_slot:0,unique_id:id,figure_type_id:figure.figure_type_id,root_x:x,root_y:y,scale:1,color_override_raw:0,field28:0,angles:figure.segments.map(s=>s.angle_rad),len_flag:0,lengths:[],bend_flag:0,bends:[],join:null};}
function paintFor(n,figure){let a=n.use_segment_color?n.color:figure.color,b=n.gradient_color??a;if(n.reverse_gradient)[a,b]=[b,a];const stops=[{offset:0,color:rgb(a),opacity:alpha(a)}];if(n.use_gradient)stops.push({offset:1,color:rgb(b),opacity:alpha(b)});const build=figure.definitionBuild??figure.build??0;let mode=n.gradient_mode??1;if((build<82&&['circle','ellipse','polygon','filled-circle'].includes(n.kind))||(build<=100&&['polygon','filled-circle'].includes(n.kind)))mode=2;if(build<=108&&n.kind==='triangle')mode=1;return {type:n.use_gradient?(mode===2?'radial':'linear'):'solid',angle:mode===0?90:0,stops};}
// Store only active shape fields. Most source limbs need just their kind;
// copying every dormant native flag into every definition doubles scene memory.
function shapeFor(n,p){
 const shape={kind:n.kind},curved=['segment','rounded-segment','trapezoid'].includes(n.kind);
 if(['circle','ellipse'].includes(n.kind)&&n.half_arc){shape.half_arc=true;if(n.triangle_upside_down)shape.triangle_upside_down=true;}
 if(n.kind==='triangle'){if(n.triangle_upside_down)shape.triangle_upside_down=true;if(n.right_triangle_direction)shape.right_triangle_direction=n.right_triangle_direction;}
 if(n.kind==='circle'&&n.use_circle_outline){shape.use_circle_outline=true;shape.outline=rgb(n.circle_outline_color);shape.outlineAlpha=alpha(n.circle_outline_color);if(n.circle_is_hollow)shape.circle_is_hollow=true;}
 if(['polygon','filled-circle'].includes(n.kind))shape.num_polygon_vertices=clamp(n.num_polygon_vertices??5,3,256);
 if(n.kind==='trapezoid'){const ratio=n.trapezoid_top_thickness_ratio??.5;if(ratio!==.5)shape.trapezoid_top_thickness_ratio=ratio;
  if(ratio<0){shape.trapezoid_thickness_start=(n.trapezoid_thickness_start??p.thickness)*p.scale;shape.trapezoid_thickness_end=(n.trapezoid_thickness_end??p.thickness/2)*p.scale;}
  if(n.trapezoid_is_rounded_start)shape.trapezoid_is_rounded_start=true;if(n.trapezoid_is_rounded_end)shape.trapezoid_is_rounded_end=true;
 }
 const logical=Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y);if(n.connector){shape.drawRatio=logical>1e-8?p.length/logical:0;shape.drawLength=p.length;shape.connector=true;}
 if(curved&&n.segment_curve_radius_and_default_curve_radius){shape.sagitta=n.segment_curve_radius_and_default_curve_radius*p.scale;if(n.curve_circulization)shape.curve_circulization=true;}
 return shape;
}
function convertedFigure(source,index,name){
 const unit={...source,scale:1},poses=layoutFigure(unit),nodes=source.nodes.filter(n=>n.parentId!=null),handles=new Map([[source.nodes[0].id,0],...nodes.map((n,i)=>[n.id,i+1])]);
 const segments=nodes.map((n,i)=>{const p=poses.get(n.id),paint=paintFor(n,source),shape=shapeFor(n,p),line=['segment','rounded-segment'].includes(n.kind),primitive=line?(n.kind==='segment'?6:0):3;
  return {segment_id:i+1,parent_id:handles.get(n.parentId),length:Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y),angle_rad:-p.angle*rad,thickness:p.thickness,bend_rad:0,primitive_code:primitive,aux_code:n.is_static?1:0,flags:primitive|(n.is_static?256:0),segment_kind:primitive===6?'squareLine':primitive===0?'line':'circleFill',segment_type:line?'line':'circle',color_rgb:paint.stops[0].color,transparency:Math.round((1-paint.stops[0].opacity)*255),paint:paint.type==='solid'?undefined:paint,secondary:paint.type==='solid'?null:{rgb:paint.stops[1].color,a:Math.round((1-paint.stops[1].opacity)*255)},visible:primitive!==0||p.thickness>.01,z_order:n.id,_sticknodes:shape};
 });
 const polyfills=source.polyfills.map((p,i)=>({polyfill_id:i+1,segment_ids:[p.anchorId,...p.attachedIds].map(id=>handles.get(id)),color_rgb:rgb(p.use_polyfill_color?p.color:source.color),color_alpha:alpha(p.use_polyfill_color?p.color:source.color),z_order:p.anchorId-.1}));
 return {figure:{figure_type_id:index+1,name,segments,segment_count:segments.length,polyfills,image_assets:[],text_assets:[],_styk:{colorMode:'segments',sticknodes:{version:source.version,build:source.build,nodeIds:nodes.map(n=>n.id)}}},handles,nodes};
}

/** Returns the same {kind,document,timings} contract as the existing import worker. */
export async function importStickNodes(input,{filename='project.stknds',signal,onProgress=()=>{},textFont,entryIndex}={}){
 const started=performance.now(),check=()=>signal?.throwIfAborted();check();
 if(/\.zip$/i.test(filename)||isZip(input)){
  const entries=(await unpackZip(input,{signal})).filter(e=>/\.(nodes|nodemc|stknds)$/i.test(e.name));
  if(!entries.length)throw new Error('The ZIP contains no Stick Nodes figures, movie clips or projects.');
  if(entryIndex==null)return {kind:'sticknodes-archive',filename,entries:entries.map((e,index)=>({index,name:e.name,bytes:e.bytes.length})),timings:{decode_ms:performance.now()-started}};
  if(!Number.isInteger(entryIndex)||!entries[entryIndex])throw new Error('Choose a valid ZIP asset.');
  const entry=entries[entryIndex];return importStickNodes(entry.bytes,{filename:entry.name,signal,onProgress,textFont});
 }
 const doc=await openDocument(input,{filename,signal,onProgress}),warnings=new Map();
 const warn=(code,message)=>warnings.set(code,message),definitions=[],figureInfo=[],spriteFigures=new Map(),clipFigures=[],textFigures=new Map();
 const layoutGuesses=new Map(),rememberGuesses=issues=>{for(const issue of issues??[])if(issue.code==='UNVERIFIED_LAYOUT')layoutGuesses.set(`${issue.format}:${issue.profile}`,{format:issue.format,profile:issue.profile,assumption:issue.assumption});};
 rememberGuesses(doc.issues);
 if(doc.format!=='nodes')warn('SOURCE_TIMING','Stored poses are imported with source FPS, delays and available tween settings; exact Stick Nodes solvers/effects are not reproduced.');
 if(doc.sounds.length)warn('EXTERNAL_AUDIO',`${doc.sounds.length} sound references need their external audio files; names are retained in import metadata.`);
 for(const meta of doc.figures){check();const source=doc.getFigure(meta.index),info=convertedFigure(source,meta.index,meta.name);figureInfo.push(info);definitions.push(info.figure);
  rememberGuesses(source.diagnostics);
  if(source.features.some(f=>['smart-stretch','floaty','angle-lock','drag-lock','connectors'].includes(f)))warn('CONSTRAINTS','Constrained source poses are preserved as editable StykAnimate joints; native constraint dynamics are not simulated.');
  if((meta.index&15)===15){onProgress({phase:'Converting figure library',progress:.35+.15*meta.index/doc.figures.length});await yieldImport();}
 }
 if(layoutGuesses.size){const profiles=[...layoutGuesses.keys()];warn('UNVERIFIED_LAYOUT',`Best-effort import: untested layouts ${profiles.slice(0,8).join(', ')}${profiles.length>8?` and ${profiles.length-8} more`:''} were read using existing version-based rules. Review the result for missing or inaccurate features.`);}
 let nextType=definitions.length+1;
 for(const sprite of doc.sprites){if(sprite.kind!=='image')continue;check();const data=await encodePNGPortable(sprite,doc.getPixels(sprite.index));
  const figure=createImageFigure({dataUrl:'data:image/png;base64,'+toBase64(data),width:sprite.width,height:sprite.height,name:sprite.name,figureTypeId:nextType++,maxPixels:64000000});spriteFigures.set(sprite.index,figure);definitions.push(figure);
 }
 const tweenTicks=(frame,settings)=>settings.autoTween&&(frame.settings?.isTweened??true)?Math.max(0,frame.settings?.slowMotion?frame.settings.slowMotionTweenFrames:settings.tweenCount??0):0;
 const holdTicks=(frame,settings)=>frame.settings?.isDelayed?Math.max(1,Math.ceil((frame.settings.delaySeconds??0)*settings.fps-1e-5)):1;
 const durations=(frames,settings)=>frames.map((frame,i)=>clamp(holdTicks(frame,settings)+(i<frames.length-1?tweenTicks(frame,settings):0),1,65535));
 const compact=value=>Array.isArray(value)?value.map(compact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!['fieldRanges','range','colorA','colorB'].includes(k)).map(([k,v])=>[k,compact(v)])):value;
 const backgrounds=[],backgroundIds=new Map(),argb=c=>(((c?.a??255)<<24)|((c?.r??255)<<16)|((c?.g??255)<<8)|(c?.b??255))>>>0;
 let legacyBackgroundId=0;
 if(doc.header.legacyBackground){const source=doc.header.legacyBackground,png=await encodePNGPortable(source,doc.rawRange(source.pixelRange));
  legacyBackgroundId=backgrounds.length+1;const bg=createImageBackground({dataUrl:'data:image/png;base64,'+toBase64(png),width:source.width,height:source.height,backgroundId:legacyBackgroundId,maxPixels:64000000});
  bg._styk.sticknodes={scaleX:source.scaleX,scaleY:source.scaleY,legacyFit:source.legacyFit};backgrounds.push(bg);
  warn('LEGACY_BACKGROUND_FIT','The embedded legacy background is retained as a native image background; its original fit settings may differ.');
 }
 function background(frame){const f=frame.settings??{};if(Array.isArray(f))return 0;if(legacyBackgroundId&&f.useImageBackground!==false)return legacyBackgroundId;const color_a=argb(f.backgroundColor),color_b=argb(f.backgroundGradientColor),key=JSON.stringify([color_a,color_b,f.useGradient]);if(!backgroundIds.has(key)){const background_id=backgrounds.length+1;backgrounds.push({background_id,kind:f.useGradient?3:2,color:color_a,color_a,color_b,x1:.5,y1:0,x2:.5,y2:1});backgroundIds.set(key,background_id);}return backgroundIds.get(key);}

 let fontPromise;
 async function font(){if(textFont)return textFont;if(!fontPromise)fontPromise=typeof process!=='undefined'&&process.versions?.node?import('node:fs/promises').then(async fs=>parseTextFont(await fs.readFile(new URL('../../vendor/text/NotoSans-Regular.ttf',import.meta.url))).font):loadTextFont();return fontPromise;}
 async function textFigure(t){const key=JSON.stringify([t.text,t.fontIndex]);if(textFigures.has(key))return textFigures.get(key);const chosenFont=await font(),text=[...t.text].map(c=>c==='\n'||c==='\r'||(c.codePointAt(0)<=65535&&chosenFont.charToGlyphIndex(c))?c:'?').join('').slice(0,16000);if(text!==t.text)warn('TEXT_GLYPHS','Unavailable font glyphs use question-mark placeholders; the original text is preserved in asset metadata.');const figure=await createTextFigure({text,fontSize:48,color:[0,0,0],name:t.text.slice(0,50),figureTypeId:nextType++},{font:chosenFont});figure._styk={...figure._styk,sticknodesText:{text:t.text,fontIndex:t.fontIndex}};definitions.push(figure);textFigures.set(key,figure);warn('TEXT_FONT','Text remains editable with bundled Noto Sans outlines; the original Stick Nodes font metrics may differ.');return figure;}
 const clipDurations=doc.movieclips.map(c=>durations(c.frames,c)),clipStarts=clipDurations.map(ds=>{let tick=0;return ds.map(n=>{const start=tick;tick+=n;return start;});});
 // Allocate containers before timelines; local documents use only their asset closure.
 for(const c of doc.movieclips){const duration=Math.max(1,clipDurations[c.index].reduce((a,b)=>a+b,0)),local=nativeDocument(c.name,c.fps,[],[]);const figure=movieclipFigure(nextType++,c.name,local,{duration,pivot:{x:960,y:540}});clipFigures.push(figure);definitions.push(figure);}
 async function framesFor(frames,settings,durs){const result=[],usedTypes=new Set(),textIds=new Map();let tick=0,nextTextId=1;for(const f of frames)for(const i of f.instances)nextTextId=Math.max(nextTextId,i.id+1);
  for(const [frameIndex,frame] of frames.entries()){check();const objects=[],sourceSlots=new Map();
   for(const [sourceSlot,instance] of frame.instances.entries()){let object;
    if(instance.type===0){const info=figureInfo[instance.assetIndex],base=info.figure,posed=doc.posedFigure(instance),layout=layoutFigure({...posed,scale:1}),nodeMap=new Map(posed.nodes.map(n=>[n.id,n]));object=nativeObject(base,instance.id,instance.x,1080-instance.y);object.scale=Math.abs(instance.scale);object.len_flag=1;object.lengths=[];object.angles=[];const styles={},shapes={};
     for(let i=0;i<info.nodes.length;i++){const id=info.nodes[i].id,n=nodeMap.get(id),p=layout.get(id),s=base.segments[i],paint=paintFor(n,posed);object.lengths.push(Math.hypot(p.end.x-p.start.x,p.end.y-p.start.y));object.angles.push(-p.angle*rad+(instance.scale<0?Math.PI:0));const style={};
      if(!same(rgb(n.use_segment_color?n.color:posed.color),s.color_rgb))style.color=rgbNumber(n.use_segment_color?n.color:posed.color);
      if(Math.abs(p.thickness-s.thickness)>1e-7)style.thickness=p.thickness;
      if(Math.abs(alpha(n.use_segment_color?n.color:posed.color)-(1-s.transparency/255))>1e-7)style.opacity=alpha(n.use_segment_color?n.color:posed.color);
      if((n.use_gradient||s.paint)&&!same(paint,s.paint))style.paint=paint;
      if(Object.keys(style).length)styles[s.segment_id]=style;const shape=shapeFor(n,p);if(!same(shape,s._sticknodes))shapes[s.segment_id]=shape;
     }
     const polygons={};for(let i=0;i<posed.polyfills.length;i++){const p=posed.polyfills[i],color=p.use_polyfill_color?p.color:posed.color,b=base.polyfills[i];if(!same(rgb(color),b.color_rgb)||alpha(color)!==b.color_alpha)polygons[i+1]={color:rgbNumber(color),opacity:alpha(color)};}
     if(Object.keys(styles).length||Object.keys(polygons).length)object._stykStyle={...(Object.keys(styles).length?{segments:styles}:{}),...(Object.keys(polygons).length?{polygons}: {})};
     if(Object.keys(shapes).length)object._sticknodesShapes=shapes;
    }else if(instance.type===1){const figure=clipFigures[instance.assetIndex],flipX=instance.flipX<0?-1:1,flipY=instance.flipY<0?-1:1;object=nativeObject(figure,instance.id,instance.x,1080-instance.y);object.scale=Math.abs(instance.scale);object.angles=[-(instance.rotation+instance.secondaryRotation)*rad+(flipX<0?Math.PI:0)];object.image_text_flags=Number(flipX!==flipY);
     // Saved cursors are authoritative at each stored parent frame. Playback
     // advances locally between keys, retaining the host's shared clip engine.
     object._stykMovieclip={start:tick,end:null,offset:clipStarts[instance.assetIndex][instance.currentFrameIndex]??0,speed:1,mode:instance.playMode===0?'single':instance.playMode===1?'hold':'loop'};
    }else{let source=doc.sprites[instance.assetIndex];if(source.kind==='group'){if(!source.members.length)continue;source=doc.sprites[source.members[instance.groupFrame]];}const figure=spriteFigures.get(source.index);object=nativeObject(figure,instance.id,instance.x,1080-instance.y);const sx=instance.scaleX??1,sy=instance.scaleY??1,fx=(instance.flipX?-1:1)*Math.sign(sx||1),fy=(instance.flipY?-1:1)*Math.sign(sy||1);
     object.scale=Math.abs(sx);object.angles=[-(instance.rotation??0)*rad+(fy<0?Math.PI:0)];object.image_text_flags=Number(fx!==fy);object._sticknodesSprite={source: {distortion: ['Tl','Tr','Bl','Br'].map(c=>[instance['distort'+c+'X'],instance['distort'+c+'Y']])},ratio:sx?Math.abs(sy/sx):0,pivotX:instance.pivotX??.5,pivotY:instance.pivotY??.5};
     if(['Tl','Tr','Bl','Br'].some(c=>instance['distort'+c+'X']||instance['distort'+c+'Y']))warn('SPRITE_DISTORTION','Sprite corner distortion is retained in import metadata; the imported sprite uses its affine transform.');
    }
    object.object_slot=objects.length;object.field28=Math.round((1-clamp(instance.style?.opacity??1,0,1))*255);object._styk={...(instance.isLocked?{locked:true}:{}),sticknodes:{style:compact(instance.style)}};
    if(instance.style?.blur||instance.style?.glow||instance.style?.motionBlur||instance.style?.pixelation>1||instance.style?.dropShadowAlpha)warn('EFFECTS','Some Stick Nodes GPU effects differ; source effect settings remain recorded in import metadata.');
    usedTypes.add(object.figure_type_id);sourceSlots.set(sourceSlot,objects.length);objects.push(object);
   }
   for(const join of frame.joins){const child=sourceSlots.get(join.child),parent=sourceSlots.get(join.parentIndex);if(child==null||parent==null)continue;const pi=frame.instances[join.parentIndex],handle=pi.type===0?figureInfo[pi.assetIndex].handles.get(join.nodeId):0;
    if(handle!=null){const p=handle===0?{x:pi.x,y:1080-pi.y}:layoutFigure(doc.posedFigure(pi)).get(join.nodeId)?.end,childObject=objects[child];
     const x=handle===0?p.x:pi.x+p.x,y=handle===0?p.y:1080-pi.y+p.y;
     if(Math.hypot(childObject.root_x-x,childObject.root_y-y)<.1)childObject.join={target_object_slot:parent,target_handle_id:handle};
     else {childObject._styk.sticknodes.join=compact(join);warn('JOIN_OFFSETS','Offset attachments keep their stored poses. Reattach them with StykAnimate joints to author new attachment motion.');}
    }
   }
   
   for(const [textIndex,t] of (frame.texts??[]).entries()){if(!t.text?.trim())continue;const textKey=t.id??textIndex;if(!textIds.has(textKey))textIds.set(textKey,nextTextId++);const figure=await textFigure(t),o=nativeObject(figure,textIds.get(textKey),t.x,1080-t.y);o.object_slot=objects.length;o.scale=Math.max(0,t.scale);o.angles=[-(t.rotation??0)*rad];o.color_override_raw=(0xff000000|((t.color?.b??0)<<16)|((t.color?.g??0)<<8)|(t.color?.r??0))>>>0;o.field28=Math.round((1-clamp(t.opacity??1,0,1))*255);const w=figure.segments[0].length*o.scale;if(t.align!==8){const shift=t.align===16?w:w/2;o.root_x-=shift*Math.cos(o.angles[0]);o.root_y-=shift*Math.sin(o.angles[0]);}objects.push(o);usedTypes.add(figure.figure_type_id);}
   const n=durs[frameIndex],out=nativeFrame(objects,n),tweens=frameIndex<frames.length-1?tweenTicks(frame,settings):0;
   out._styk={easing:{interpolation:tweens?(frame.settings?.easeIn&&frame.settings?.easeOut?'bezier':frame.settings?.easeIn?'ease-in':frame.settings?.easeOut?'ease-out':'linear'):'constant'}};
   out.background_id=background(frame);
   if(frame.camera){const c=frame.camera,z=c.zoom>0?c.zoom:1;out.camera={is_default:false,x:c.x+960/z-960,y:540-c.y-540/z,scale:1/z,angle_rad:-(c.rotation??0)*rad};
    if(c.wobbleXY||c.wobbleRotation||c.wobbleScale||c.bindings?.length)warn('CAMERA_DYNAMICS','Camera position, zoom and rotation are imported; procedural wobble and tracking bindings are retained as metadata.');}

   const s=frame.settings;if(s&&!Array.isArray(s)){out._sticknodesFrame={settings:compact(s),camera:compact(frame.camera)};if(s.repeating)warn('REPEATS','Source repeat-loop settings are retained; native repeat-loop control flow is not expanded during import.');}
   const hold=Math.min(n,holdTicks(frame,settings));
   if(tweens&&hold>1){result.push({...out,duration_raw:hold-1,_styk:{easing:{interpolation:'constant'}}});out.duration_raw=n-hold+1;}
   result.push(out);tick+=n;if((result.length&15)===0){onProgress({phase:'Converting stored animation frames',progress:.65});await yieldImport();}
  }
  // Pivot's final key has one tick. A terminal hold key retains the complete
  // source duration without expanding every delayed frame into duplicates.
  if(result.at(-1)?.duration_raw>1){const last=result.at(-1);last.duration_raw--;result.push({...last,duration_raw:1});}
  return {frames:result,usedTypes,ticks:tick};
 }
 for(const clip of doc.movieclips){const figure=clipFigures[clip.index],converted=await framesFor(clip.frames,clip,clipDurations[clip.index]);figure._styk.movieclip.document.keyframes=converted.frames.length?converted.frames:[nativeFrame([])];figure._styk.movieclip.document.backgrounds=backgrounds;figure._styk.movieclip.document.figure_types=definitions.filter(f=>converted.usedTypes.has(f.figure_type_id));}
 let document,kind;
 if(doc.format==='nodes'){const info=figureInfo[0],object=nativeObject(info.figure,1,960,540);object.scale=Math.abs(doc.getFigure(0).scale??1);if(doc.getFigure(0).scale<0)object.angles=object.angles.map(a=>a+Math.PI);document=nativeDocument(doc.name,24,[info.figure],[nativeFrame([object])]);kind='stkz';}
 else if(doc.format==='nodemc'){const figure=clipFigures[0],object=nativeObject(figure,1,960,540);object._stykMovieclip={start:0,end:null,offset:0,speed:1,mode:'loop'};document=nativeDocument(doc.name,doc.header.settings.fps,[figure],[nativeFrame([object])]);kind='stykmov';}
 else{const converted=await framesFor(doc.frames,doc.header.settings,durations(doc.frames,doc.header.settings));document=nativeDocument(doc.name,doc.header.settings.fps,definitions,converted.frames);kind='styk';}
 document.backgrounds=backgrounds;
 document._styk.sticknodes={version:1,format:doc.format,profile:doc.profile,filename,sourceSha256:doc.source.sha256,sourceSettings:compact(doc.header.settings),sounds:doc.sounds.map(s=>s.name),...(layoutGuesses.size?{layoutGuesses:[...layoutGuesses.values()]}:{}),warnings:[...warnings].map(([code,message])=>({code,message}))};
 if(kind==='stkz'||kind==='stykmov')document.figure_types[0]._styk.sticknodesImport=document._styk.sticknodes;
 check();return {ok:true,kind,filename,document,warnings:document._styk.sticknodes.warnings,timings:{decode_ms:performance.now()-started,total_ms:performance.now()-started,document_bytes:doc.payload.length*2}};
}
