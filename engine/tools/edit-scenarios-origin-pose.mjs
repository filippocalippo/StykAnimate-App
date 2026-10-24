// Origin-aware joint and handle gestures: editor-built before the command gates open.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open, joint} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const poseJSON = editor => JSON.stringify(editor.frame.objects.map(object => Object.fromEntries(['root_x', 'root_y', 'scale', 'angles', 'len_flag', 'lengths', 'bend_flag', 'bends', '_stykAnimationOrigin', '_stykIK'].filter(key => key in object).map(key => [key, object[key]]))));
for (const kind of ['layout', 'offsets', 'support', 'support-pinned', 'support-free']) {
  counter = 0;
  const source = kind.startsWith('support') ? 'support' : kind;
  const base = open(JSON.parse(readFileSync(`${out}/origin-reroot-${source}-native.document.json`, 'utf8')));
  // A joined child must carry its hidden angular support when its parent joint turns.
  if (source === 'support') { joint(base, 11, 2); base.deleteSingleSegment({preserveEndpoints: true}); }
  if (kind.endsWith('-pinned') || kind.endsWith('-free')) {
    for (let index = 0; index < base.report.keyframes.length; index++) {
      base.selectFrame(index); joint(base, 66, 2);
      base.setNodeIK({enabled: true, pinned: kind.endsWith('-pinned'), chainLength: 3, allowStretch: true, bendDirection: 1});
    }
    base.seek(0);
  }
  for (const frame of [...base.report.keyframes, ...Object.values(base.report._styk.frameSources ?? {})]) for (const object of frame.objects) {
    if (!object._stykAnimationOrigin) continue;
    for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futurePoseGhost = {retained: [4, 8]};
  }
  for (const mode of ['native', 'sheet', ...(kind.includes('-') ? [] : ['autokey-sheet'])]) {
    const editor = mode === 'native' ? {} : {...app, ...(mode === 'autokey-sheet' ? {autoKey: true} : {})};
    const name = `origin-pose-${kind}-${mode}`, document = `${name}.document.json`;
    const loaded = mode === 'native' ? mirror(base) : mirror(open(JSON.parse(mirror(base)), editor));
    writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor); planning.autoKey = editor.autoKey ?? false;
    const calls = [], mutations = [];
    const call = (...args) => {
      const before = poseJSON(planning); calls.push(args);
      const result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));
      if (['poseJoint', 'rotateJoint', 'bendJoint', 'editHandlePosition', 'transformFigureHandle'].includes(args[0]) && before !== poseJSON(planning)) mutations.push(args[0]);
      return result;
    };
    const select = (handle, uid = 1, options) => { const figure = planning.report.figure_types.find(figure => figure.figure_type_id === uid); call('@select', uid, figure.segments.findIndex(segment => segment.segment_id === handle), ...(options ? [options] : [])); };
    const tip = (index = planning.selectedJoint) => { const point = planning.geometry.objects.get(planning.selectedSlot).segments[index].end; return [point.x, point.y]; };
    select(44); let start = tip(); call('beginDrag', 'Origin joint return'); call('poseJoint', start[0]+13.25, start[1]-8.125, {snap: false}); call('poseJoint', ...start, {snap: false}); call('cancelDrag');
    call('beginDrag', 'Origin turn cancel'); call('rotateJoint', .29); call('rotateJoint', -.29); call('cancelDrag');
    call('beginDrag', 'Origin joint pose'); call('rotateJoint', .19); let point = tip(); call('bendJoint', point[0]-9, point[1]+15, {snap: false}); call('commitDrag'); call('undo'); call('redo');
    point=tip(); call('poseJoint', point[0]+11, point[1]-7, {stretch: true, isolate: true, snap: false}); call('undo'); call('redo'); call('rotateJoint', .1, {isolate: true}); call('undo'); call('redo');
    call('@seek', 3.5); select(55,2); call('beginDrag', 'Origin child cancel'); point=tip(); call('poseJoint', point[0]+10, point[1]-12, {stretch: true, snap: false}); point=tip(); call('bendJoint', point[0]+4, point[1]+8, {stretch: true, snap: false}); call('cancelDrag');
    select(55); call('rotateJoint', .17); call('undo'); call('redo');
    select(22); start=tip(); call('beginHandleEditDrag', {bend: false}); call('editHandlePosition', start[0]+7, start[1]-9); call('editHandlePosition', ...start); call('commitHandleEditDrag'); call('undo'); call('redo');
    start=tip(); call('beginHandleEditDrag', {bend: true}); call('editHandlePosition', start[0]+12, start[1]+15); call('cancelHandleEditDrag');
    call('@seek',8); select(55,2); start=tip(); call('beginHandleEditDrag'); call('editHandlePosition', start[0]+11, start[1]-6); call('commitHandleEditDrag'); call('undo'); call('redo');
    select(33); start=tip(); call('beginFigureHandleDrag'); call('transformFigureHandle', start[0]+20, start[1]-30, {ctrlKey: true}); call('transformFigureHandle', ...start); call('commitFigureHandleDrag'); call('undo'); call('redo');
    start=tip(); call('beginFigureHandleDrag', ...start, {rotate: true, scale: true}); call('transformFigureHandle', start[0]+11, start[1]+17, {shiftKey: true}); call('cancelFigureHandleDrag');
    call('@seek',0); select(22); const groupJoint = planning.selectedJoint; call('selectMany',[2,1]); start=tip(groupJoint); call('beginFigureHandleDrag', ...start, {joint: groupJoint}); call('transformFigureHandle', start[0]+15, start[1]-22); call('commitFigureHandleDrag'); call('undo'); call('redo');
    point=tip(groupJoint); call('transformFigureHandle', point[0]+5, point[1]-14, {joint: groupJoint}); call('undo'); call('redo');
    if (kind.includes('-')) { select(66,2); point=tip(); call('beginDrag','Origin IK target'); call('poseJoint',point[0]-27.25,point[1]+18.5); call('commitDrag'); call('undo'); call('redo'); point=tip(); call('beginDrag','Origin IK cancel'); call('poseJoint',point[0]+7.125,point[1]-6.25); call('cancelDrag'); }
    call('@seek',3.5); select(44); call('rotateJoint', .12); call('undo'); call('redo');
    for (const method of ['poseJoint','rotateJoint','bendJoint','editHandlePosition','transformFigureHandle']) if (!mutations.includes(method)) throw Error(`${name}: ${method} never changed a document`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1)+'\n');
    console.log(`${name}: ${calls.length} steps, ${mutations.length} meaningful mutations`);
  }
}
