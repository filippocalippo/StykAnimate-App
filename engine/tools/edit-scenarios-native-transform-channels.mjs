// Native scalar authoring uses the actual Editor animation owner. Projection
// recordings remain prerequisites, separately named, until prepared on a worker.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, joint, nextKey, prune} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
import {findAnimationChannel, sampleAnimationChannel} from '../../src/animation-channels.mjs';
const out = new URL('../tests/edit/', import.meta.url);
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const figure = uid => ({kind:'figure', uid});
let counter = 0;
const samples = [];
function recordSamples(editor, name) {
  const rows=[];
  for(const uid of [1,2,3])for(const property of ['x','y','scale','rotation'])for(const tick of [0,2.25,3.5,6,8.75,11,14]) {
    const target=figure(uid),value=sampleAnimationChannel(findAnimationChannel(editor.report,target,property),tick);
    rows.push({target,property,tick,value:value??null});
  }
  samples.push({name,document:JSON.parse(mirror(editor)),rows});
}
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable:true, value:()=>`00110011-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
function seed(kind) {
  counter = 0;
  const e = open(documentOf([limb(true), limb(), limb()], i => [240 + i * 180, 170]));
  if (kind !== 'plain') {
    joint(e,22,1);e.setOrigin(22);
    if (kind === 'offsets') {joint(e,11,1);e.mirrorSegmentBranch('horizontal');}
    if (kind === 'support') {joint(e,11,1);e.deleteSingleSegment({preserveEndpoints:true});}
    joint(e,22,2);e.setOrigin(22);
  }
  e.select(2);e.joinTo(1,55);
  nextKey(e,6);e.select(1);e.rotateSelection(.63);e.moveSelection(22,-11);e.select(2);e.scaleSelected(.9);e.setFrameDuration(6);e.seek(0);
  for (const frame of e.report.keyframes) for (const object of frame.objects) {
    if (object._stykAnimationOrigin) {
      object._stykAnimationOrigin.futureNativePivot={retained:[7,2]};
      for (const ghost of Object.values(object._stykAnimationOrigin.ghosts??{})) ghost.futureNativeGhost={retained:[6,3]};
    } else object.futureOrdinary={retained:true};
  }
  return prune(e.report);
}
for (const kind of ['plain','layout','offsets','support']) for (const mode of ['new','saved','projection']) {
  const editor = mode === 'projection' ? {propertyChannels:true} : {};
  const initial = open(structuredClone(seed(kind)),editor);
  if (mode === 'saved') {
    initial.addAnimationKeys(['x','y','scale','rotation'].flatMap((property,i)=>[
      {target:figure(1),property,tick:0,value:[260.125,175.25,1,.15][i],interpolation:'linear'},
      {target:figure(1),property,tick:8,value:[305.75,197.125,.85,6.35][i],interpolation:'auto'},
    ]));
    initial.report._styk.animation.futureNativeAnimation={keep:['unknown']};
    for (const channel of initial.report._styk.animation.channels) {
      channel.futureNativeChannel={keep:true};channel.keys[0].futureNativeKey={keep:[3,1]};
      // Persisted native curve flags remain meaningful with projection disabled;
      // an authored replacement removes them at the existing putKey owner.
      if(channel.property==='x')channel.keys[0].passthrough=true;
      if(channel.property==='y')channel.keys[0].nativeCurve='pchip';
      if(channel.property==='rotation'){channel.keys[0].nativeCurve='pchip';channel.keys[0].nativeRotation=true;}
    }
    initial.report._styk.animation.channels.push({id:'figure:3:x',target:figure(3),property:'x',keys:[],futureEmpty:{keep:true}});
  }
  const name=`native-transform-channels-${kind}-${mode}`, document=`${name}.document.json`;
  const loaded=mirror(open(JSON.parse(mirror(initial)),editor));writeFileSync(new URL(document,out),loaded);
  const planning=open(JSON.parse(loaded),editor), calls=[], mutations=new Set();
  if(mode!=='projection')recordSamples(planning,`${name}-initial`);
  const run=(...args)=>{
    const before=mirror(planning), shown=JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame));calls.push(args);
    let error;try {planning[args[0]==='@select'?'select':args[0]==='@seek'?'seek':args[0]](...args.slice(1));} catch(caught) {error=caught;}
    const changed=before!==mirror(planning)||shown!==JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame));
    if(changed)mutations.add(args[0]);calls.push(['@frame']);return error;
  };
  const preview=(value,invalid=false)=>{
    const before=mirror(planning),shown=JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame)),error=run('previewAnimationEdit',value);
    if(invalid&&(!error||before!==mirror(planning)||shown!==JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame))))throw Error(`${name}: invalid preview mutated live state`);
    if(!invalid&&error)throw error;
  };
  run('@select',1,-1);run('selectMany',[1,2]);run('selectMany',[3,999,1]);
  run('@select',2,{add:true});run('@select',1,{toggle:true});run('@select',1,-1);run('@seek',0);
  // A native gesture with no saved channels is committed by the property owner.
  if(mode==='new'){run('beginTranslationDrag');run('moveSelection',7.25,-3.5);}
  run('beginAnimationEdit',figure(1),'rotation');preview(.23);preview(.72);preview(.72);preview('invalid',true);preview({},true);run('commitAnimationEdit');run('undo');run('redo');
  for(const [property,value] of [['x',330.125],['y',210.75],['scale',1.375],['rotation',-.47]]) {
    run('@seek',4);run('beginAnimationEdit',figure(1),property);preview(value);preview(value+.125);
    preview(property==='scale'?-1:null,true);run('cancelAnimationEdit');
    run('beginAnimationEdit',figure(1),property,{exactTarget:true});preview(value);run('commitAnimationEdit');run('undo');run('redo');
    run('@seek',0);const initialValue=planning.animationValue(figure(1),property);
    run('beginAnimationEdit',figure(1),property);preview(value+.25);preview(initialValue);run('commitAnimationEdit');
  }
  // Beginning another edit commits the first one; addKeys does the same.
  run('@seek',6);run('beginAnimationEdit',figure(1),'x');preview(347.25);run('beginAnimationEdit',figure(2),'scale');preview(1.125);
  run('addAnimationKeys',[
    {target:figure(1),property:'x',tick:6,value:362.125,interpolation:'bezier',bezier:[.12,.75,.8,.3]},
    {target:figure(1),property:'x',tick:6,value:363.25,interpolation:'linear'},
    {target:figure(2),property:'y',tick:8,value:205.125,interpolation:'ease-out'},
    {target:figure(2),property:'rotation',tick:8,value:.53,interpolation:'auto'},
  ]);run('undo');run('redo');
  run('addAnimationKey',figure(2),'scale',9,.91);run('undo');run('redo');
  run('addAnimationKeys',[{target:figure(1),property:'scale',tick:6},{target:figure(2),property:'x',tick:6}]);run('undo');run('redo');
  // The exact persisted child curve can differ from its displayed world value
  // after another channel translates the same assembly. A missing/empty curve
  // instead reads the visible property before its first write.
  run('@seek',8);run('beginAnimationEdit',figure(2),'x',{exactTarget:true});preview(430.25);run('commitAnimationEdit');run('undo');run('redo');
  run('addAnimationKeys',[{target:figure(2),property:'x',tick:9,exactTarget:true}]);run('undo');run('redo');
  run('@seek',6);run('beginAnimationEdit',figure(3),'x',{exactTarget:true});preview(710.125);run('commitAnimationEdit');run('undo');run('redo');
  for(const tick of [0,2.25,3.5,6,8.75,11])run('@seek',tick);
  run('beginAnimationEdit',figure(1),'scale');preview(1.4);run('undo');run('redo');
  run('@seek',3.5);run('beginAnimationEdit',figure(1),'x');run('@seek',6);
  run('addAnimationKey',figure(1),'rotation',14,-.31);run('@seek',13.25);run('@seek',14);run('undo');run('redo');
  run('cancelAnimationEdit');run('commitAnimationEdit');run('previewAnimationEdit',1);
  for(const method of ['previewAnimationEdit','addAnimationKeys','addAnimationKey'])if(!mutations.has(method))throw Error(`${name}: ${method} made no observable mutation`);
  if(mode!=='projection')recordSamples(planning,`${name}-final`);
  const file=new URL(`${name}.scenario.json`,out);writeFileSync(file,JSON.stringify({name,document,editor,steps:calls},null,1)+'\n');
  execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),fileURLToPath(file),fileURLToPath(new URL(`${name}.reference.json`,out))]);
  console.log(`${name}: ${calls.length} actual Editor steps${mode==='projection'?' (worker projection prerequisite)':''}`);
}
writeFileSync(new URL('native-transform-channels.samples.json',out),JSON.stringify(samples)+'\n');
// Targets absent from the current frame must be resolved at the edited key.
for(const kind of ['plain','rig','rig-joined']) {
  const raw=JSON.parse(readFileSync(new URL(`origin-future-${kind}-sheet.document.json`,out),'utf8'));delete raw._styk.layerSheet;
  const name=`native-transform-channels-future-${kind}`,document=`${name}.document.json`,editor={};
  writeFileSync(new URL(document,out),mirror(open(raw,editor)));
  const calls=[['@select',1,-1],['beginTranslationDrag'],['moveSelection',2.125,-1.25],
    ['addAnimationKey',figure(3),'x',8,455.25],['@frame'],['undo'],['@frame'],['redo'],['@frame'],['@seek',8.5],['@frame'],
    ['addAnimationKeys',[{target:figure(1),property:'x',tick:8,value:301.25},{target:figure(3),property:'scale',tick:8,value:.85}]],['@frame'],['undo'],['@frame'],['redo'],['@frame']];
  const file=new URL(`${name}.scenario.json`,out);writeFileSync(file,JSON.stringify({name,document,editor,steps:calls},null,1)+'\n');
  execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),fileURLToPath(file),fileURLToPath(new URL(`${name}.reference.json`,out))]);
  console.log(`${name}: ${calls.length} actual Editor steps${kind==='plain'?'':' (atomic refusal prerequisite)'}`);
}
// The editor commits an earlier gesture before validating a new key. Until
// that error-side-effect contract is supported, these calls stay Unported;
// its atomic engine refusal leaves the oracle fallback's original view intact.
for(const kind of ['property-key','property-begin','pose-key']) {
  const name=`native-transform-channels-invalid-open-${kind}`,document='native-transform-channels-plain-new.document.json';
  const prefix=kind==='pose-key'?[
    ['@seek',3.5],['@select',1,-1],['beginTranslationDrag'],['moveSelection',7.25,-3.5],['addAnimationKey',figure(1),'x',3.5,332.125]
  ]:[
    ['@select',1,-1],['beginAnimationEdit',figure(1),'x'],['previewAnimationEdit',330.125],
    kind==='property-key'?['addAnimationKey',figure(1),'y',0,'invalid']:['beginAnimationEdit',figure(999),'x']
  ];
  const calls=[...prefix,['cancelAnimationEdit'],['undo'],['redo']].flatMap(call=>[call,['@frame']]);
  const file=new URL(`${name}.scenario.json`,out);writeFileSync(file,JSON.stringify({name,document,editor:{},steps:calls},null,1)+'\n');
  execFileSync(process.execPath,[fileURLToPath(new URL('./edit-replay.mjs',import.meta.url)),fileURLToPath(file),fileURLToPath(new URL(`${name}.reference.json`,out))]);
  console.log(`${name}: ${calls.length} actual Editor steps (error-side-effect refusal prerequisite)`);
}
