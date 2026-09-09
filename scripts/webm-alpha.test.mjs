import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import native from '../desktop/video-export-service.cjs';
const executable=path.resolve(process.env.STYK_FFMPEG||`build/video-encoder/ffmpeg${process.platform==='win32'?'.exe':''}`);
function run(args,bytes){const result=spawnSync(executable,args,{input:bytes,windowsHide:true,maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr?.toString()||result.error?.message);return result.stdout;}
for(const [width,height,rgb]of[[256,16,false],[257,17,false],[1,1,false],[65,33,true]])test(`native VP9 flags preserve every alpha byte at ${width}×${height}${rgb?' from opaque RGB':''}`,()=>{
  const totalFrames=4,components=rgb?3:4,bytes=Buffer.alloc(width*height*components*totalFrames),expected=[];
  for(let tick=0;tick<totalFrames;tick++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=((tick*height+y)*width+x)*components,alpha=rgb?255:(128+x+y*11+tick*73)&255;
    bytes[at]=(x*3+tick*40)&255;bytes[at+1]=(y*7+40)&255;bytes[at+2]=190;if(!rgb)bytes[at+3]=alpha;expected.push(alpha);
  }
  const config=native.validateConfig({format:'webm',codec:'vp9',width,height,totalFrames,fps:8,quality:1,maxBytes:4*1024*1024,bitrate:8000000});
  const args=native.encoderArguments(config,'pipe:1'),tail=args.slice(args.indexOf('-i')+2);
  const encoded=run(['-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt',rgb?'rgb24':'rgba','-video_size',`${width}x${height}`,'-framerate','8','-i','pipe:0',...tail],bytes);
  const decoded=run(['-hide_banner','-loglevel','error','-c:v','libvpx-vp9','-i','pipe:0','-an','-pix_fmt','rgba','-f','rawvideo','pipe:1'],encoded);
  assert.equal(decoded.length,width*height*totalFrames*4);
  for(let i=0;i<expected.length;i++)assert.equal(decoded[i*4+3],expected[i],`pixel ${i}`);
});
