import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const executable=path.resolve('build/video-encoder/ffmpeg.exe'),output=path.resolve('artifacts/webm-alpha');
await mkdir(output,{recursive:true});
const width=256,height=16,rgba=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4;rgba[at]=190;rgba[at+1]=80;rgba[at+2]=35;rgba[at+3]=x;}
function run(args,input){const result=spawnSync(executable,['-hide_banner','-loglevel','error',...args],{input,encoding:null,windowsHide:true,maxBuffer:8*1024*1024});if(result.status!==0)throw new Error(result.stderr?.toString()||result.error?.message);return result.stdout;}
const input=['-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate','8','-i','pipe:0'];
const source=(args=[],pixels=rgba,format='rgba')=>run([...input.map(a=>a==='rgba'?format:a),...args,'-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],pixels);
const compare=alpha=>{const different=[];for(let x=0;x<width;x++)if(alpha[x]!==x)different.push([x,alpha[x]]);return{different:different.length,samples:different.slice(0,15),mid:alpha[128]};};
const conversion=[];
for(const flags of[null,'accurate_rnd','bitexact','accurate_rnd+bitexact','neighbor','point','bicubic+accurate_rnd+bitexact']){
  try{const filter=flags?`scale=flags=${flags},format=yuva420p,alphaextract`:'format=yuva420p,alphaextract';conversion.push({flags,...compare(source(['-vf',filter]))});}
  catch(error){conversion.push({flags,error:error.message});}
}
for(const filter of['alphaextract','format=gbrap,format=yuva420p,alphaextract',
  'split[c][a];[a]alphaextract[mask];[c]format=yuv420p[color];[color][mask]alphamerge,alphaextract']){
  try{conversion.push({filter,...compare(source(['-vf',filter]))});}catch(error){conversion.push({filter,error:error.message});}
}
const encoded=[];
for(const options of[
  {name:'default',args:[]},
  {name:'lossless',args:['-lossless','1','-crf','0']},
  {name:'accurate-rnd',args:['-vf','scale=flags=accurate_rnd+bitexact,format=yuva420p','-lossless','1','-crf','0']},
  {name:'planar-rgb',args:['-vf','format=gbrap,format=yuva420p','-lossless','1','-crf','0']},
  {name:'preserve-alpha',args:['-vf','split[c][a];[a]alphaextract[mask];[c]format=yuv420p[color];[color][mask]alphamerge','-lossless','1','-crf','0']},
]){
  const bytes=run([...input,'-frames:v','1','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','8000000','-auto-alt-ref','0','-lag-in-frames','0',...options.args,'-f','webm','pipe:1'],rgba);
  await writeFile(path.join(output,`alpha-ramp-${options.name}.webm`),bytes);
  const alpha=run(['-c:v','libvpx-vp9','-i','pipe:0','-vf','alphaextract','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],bytes);
  encoded.push({name:options.name,...compare(alpha)});
}
const report={version:run(['-version']).toString().split('\n')[0],conversion,encoded};await writeFile(path.join(output,'alpha-diagnostic.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
