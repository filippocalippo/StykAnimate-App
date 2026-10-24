// Actual native projection oracle; recorded before command admission.
// Only materialization/sampling of the existing nativePropertyChannel owner.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {sampleAnimationChannel} from '../../src/animation-channels.mjs';
const folder=new URL('../tests/edit/',import.meta.url);
const json=value=>JSON.stringify(value,(key,item)=>key==='runtime_segments'?undefined:item);
Object.defineProperty(performance,'now',{value:()=>0,configurable:true});
const cases=[];
function record(name,editor,ticks=[0,2.25,3.5,6,8.75,11,14]){
  const documentJSON=json(editor.report),channels=[];
  for(const uid of [1,2,3])for(const property of ['x','y','scale','rotation']){
    const target={kind:'figure',uid},markers=editor.nativePropertyChannel(target,property,{markersOnly:true}),channel=editor.nativePropertyChannel(target,property);
    const channelJSON=json(channel),samples=ticks.map(tick=>({tick,native:sampleAnimationChannel(channel,tick)??null,
      displayed:editor.animationValue(target,property,tick)??null,exactTarget:editor.animationValue(target,property,tick,{exactTarget:true})??null}));
    channels.push({target,property,markersJSON:json(markers),channelJSON,samples});
  }
  assert.equal(json(editor.report),documentJSON,`${name}: projection reads mutated report`);
  writeFileSync(new URL(`${name}.document.json`,folder),documentJSON+'\n');
  cases.push({name,options:{propertyChannels:true},documentJSON,channels});
}
const seed=kind=>JSON.parse(readFileSync(new URL(`native-transform-channels-${kind}-projection.document.json`,folder)));
for(const kind of ['plain','layout','offsets','support'])record(`native-transform-channels-${kind}-projection`,open(seed(kind),{propertyChannels:true}));
for(const kind of ['plain','layout','offsets','support'])for(const mode of ['auto','mixed-easing']){
  const builder=open(seed(kind),{});
  builder.selectFrame(builder.report.keyframes.length-1);builder.setFrameDuration(6);builder.duplicateFrame();
  builder.selectFrame(builder.report.keyframes.length-1);builder.select(1,-1);
  builder.rotateSelection(5.83);builder.moveSelection(32.125,-14.75);builder.scaleSelected(1.2);builder.setFrameDuration(6);
  if(mode==='mixed-easing'){
    builder.setFramesEasing([0],{interpolation:'bezier',bezier:[.12,.75,.8,.3]});builder.setFramesEasing([1],{interpolation:'hold'});
  }
  const raw=builder.serialize();raw.auto_easing=true;delete raw.auto_easing_disabled_raw;
  record(`native-transform-channels-${kind}-projection-${mode}`,open(raw,{propertyChannels:true}),[0,2.25,3.5,6,8.75,11,12,14.25,17]);
}
for(const kind of ['plain','layout','offsets','support']){
  const editor=open(seed(kind),{propertyChannels:true});
  editor.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:277.375},
    {target:{kind:'figure',uid:1},property:'x',tick:8,value:315.625},
    {target:{kind:'figure',uid:1},property:'rotation',tick:0,value:.23},
    {target:{kind:'figure',uid:1},property:'rotation',tick:8,value:6.35}]);
  record(`native-transform-channels-${kind}-projection-dependencies`,editor);
}
const reference=JSON.parse(readFileSync(new URL('move-native.reference.json',folder)));
const builder=open(JSON.parse(reference.steps[0].document),{propertyChannels:true});
builder.setFrameDuration(12);builder.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:300},
  {target:{kind:'figure',uid:1},property:'x',tick:6,value:340}]);builder.createLayer('Destination');
const editor=open(JSON.parse(json(builder.report)),{propertyChannels:true});
editor.select(1,-1);editor.beginDrag('Worker gesture');editor.moveSelection(7.125,-3.25);editor.moveSelection(2.5,1.75);editor.commitDrag();
record('native-channels-inherited-authored-pose-projection',editor);
writeFileSync(new URL('native-transform-projection-oracle.json',folder),json(cases)+'\n');
console.log(`${cases.length} native projection documents / ${cases.reduce((n,c)=>n+c.channels.length,0)} curves / ${cases.reduce((n,c)=>n+c.channels.reduce((sum,row)=>sum+row.samples.length,0),0)} samples generated.`);
