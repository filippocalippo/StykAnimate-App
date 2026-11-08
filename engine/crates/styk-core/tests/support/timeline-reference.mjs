// Executable legacy policy oracle. Public source only; never updates fixtures.
import {sheetRowLayout} from '../../../../../src/timeline-rows.mjs';
import {edgeSpeed,edgeStep} from '../../../../../src/timeline-navigation.mjs';
import {normalizePlaybackRange,playbackStartupWindow} from '../../../../../src/playback-window.mjs';
import {updatePreviewQuality} from '../../../../../src/preview-quality.mjs';
import {runTimelineHotkey} from '../../../../../src/timeline-hotkeys.mjs';
import {normalizeEditorSettings} from '../../../../../src/settings.mjs';
import {Timeline} from '../../../../../src/layer-timeline.mjs';
const selectionTicks=Object.getOwnPropertyDescriptor(Timeline.prototype,'selectedTicks').get.call({start:1,end:6,ids:['one'],editor:{layerFrameKeys(){return [{tick:0},{tick:6}];}}});
const rows=[{kind:'camera'},{kind:'scene'},...Array.from({length:18},()=>({kind:'layer'}))];
const geometry=[112,240,400].map(height=>{const g=sheetRowLayout(rows,{viewport:height});return {height,pinned:g.pinned,tops:rows.map((_,i)=>g.top(i)),sizes:rows.map((_,i)=>g.size(i))};});
const edge=[];const clock={time:0,rest:0};for(const now of [8,16,32,80,180])edge.push(edgeStep(clock,edgeSpeed(10),now));
const range=[null,{startTick:9,endTick:30},{startTick:2,endTick:4}].map(input=>normalizePlaybackRange(input,5));
const governor={index:0,lowSince:null,highSince:null};const quality=[0,2500,2501,2502,8502,8503].map((now,i)=>[updatePreviewQuality(governor,{fps:i<3?20:25,targetFps:25},now),governor.index]);
const simple={strip:{},selectedIndex:1,selectFrame(index){this.result=index;}};runTimelineHotkey(simple,'timeline-layer-up');
const keys=['timelineMode','loopPlayback','fitViewOnPlayback','playbackQuality','replaceKeyframesOnDrop','autoKey'];
const settings=[{},Object.fromEntries(keys.map(key=>[key,null])),{timelineMode:'simple',loopPlayback:false,fitViewOnPlayback:false,playbackQuality:'draft',autoKey:true}].map(input=>({input,values:Object.fromEntries(keys.map(key=>[key,normalizeEditorSettings(input)[key]]))}));
process.stdout.write(JSON.stringify({geometry,edge,range,quality,selectionTicks,simpleUp:simple.result,startup:[playbackStartupWindow(24,1),playbackStartupWindow(24,40)],settings}));
