import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraActionsView} from '../src/camera-view.mjs';

test('camera command groups expose distinct actions with clipboard, selection and neighbor availability', () => {
  const actions = [];
  const editor = {selectedObjects: [], frameIndex: 0, report: {keyframes: [{}, {}]}};
  const render = () => cameraActionsView({editor,
    button: (action, icon, title, disabled = false) => { actions.push({action, icon, title, disabled}); return `[${action}]`; },
    group: (title, body) => `${title}:${body}`, tools: body => body});
  assert.match(render(), /Camera pose.*Center on selection.*Canvas alignment.*Neighboring pose/);
  assert.equal(actions.length, 10); assert.equal(new Set(actions.map(action => action.action)).size, 10);
  const byId = new Map(actions.map(action => [action.action, action]));
  for (const action of ['camera-paste', 'camera-center', 'camera-center-x', 'camera-center-y', 'camera-locate-previous']) assert.equal(byId.get(action).disabled, true);
  assert.equal(byId.get('camera-locate-next').disabled, false);
  actions.length = 0; editor._cameraClipboard = {}; editor.selectedObjects = [{}]; editor.frameIndex = 1; render();
  assert.equal(actions.find(action => action.action === 'camera-paste').disabled, false);
  assert.equal(actions.find(action => action.action === 'camera-center').disabled, false);
  assert.equal(actions.find(action => action.action === 'camera-locate-next').disabled, true);
});
