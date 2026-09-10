import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {buildChannelTimelineTracks} from './helpers/legacy-timeline-projection.mjs';
import {connectedTimelineGroups} from '../src/connected-timeline.mjs';

test('temporary authored attachments do not merge independent timeline figures',()=>{
  const objects=[{unique_id:1,object_slot:0},{unique_id:2,object_slot:1,join:{target_object_slot:0}}];
  const report={keyframes:[{objects:objects.map(o=>({...o,join:null}))}],_styk:{frameSources:{pickup:{objects}}}};
  assert.deepEqual(connectedTimelineGroups(report),[]);
  report._styk.animation={channels:[{property:'pose',keys:[{value:{frameId:'pickup'}}]}]};
  assert.deepEqual(connectedTimelineGroups(report),[]);
});

test('stable anatomy groups across missing poses while pickup and parent switches remain separate',()=>{
  const root={unique_id:1}, child={unique_id:2,join:{target_object_slot:0}}, other={unique_id:3};
  const native={keyframes:[{objects:[root,child,other]},{objects:[root,child,{...other,join:{target_object_slot:1}}]},
    {objects:[root,other]},{objects:[root,child,other]}]};
  assert.deepEqual(connectedTimelineGroups(native).map(g=>g.figureUids),[[1,2]]);
  const groups=connectedTimelineGroups(native);
  native._styk={frameSources:{switch:{objects:[root,{...child,join:{target_object_slot:2}},other]}},
    animation:{channels:[{property:'pose',keys:[{value:{frameId:'switch'}}]}]}};
  assert.deepEqual(connectedTimelineGroups(native,{nativeGroups:groups}),[]);
  assert.deepEqual(connectedTimelineGroups(native,{nativeGroups:groups}),connectedTimelineGroups(native));
});
