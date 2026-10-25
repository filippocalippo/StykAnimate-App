import test from 'node:test';
import assert from 'node:assert/strict';
import {HotkeyManager, HOTKEY_COMMANDS, DEFAULT_HOTKEYS, DESKTOP_PANEL_KEYS, normalizeBinding, normalizeHotkeys, eventBinding, findHotkeyConflicts, isHotkeyInput, shortcutLabel} from '../src/hotkeys.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';

function key(code, props = {}) {
  return {code, key:code, preventDefault() {this.defaultPrevented = true;}, ...props};
}

test('motion path falloff has no shortcuts, including persisted former bindings', () => {
  const bindings = normalizeHotkeys({'falloff-hold': ['KeyQ'], 'falloff-smaller': ['BracketLeft'], 'falloff-larger': ['BracketRight']});
  assert.ok(HOTKEY_COMMANDS.every(command => !command.id.startsWith('falloff-')));
  assert.ok(Object.keys(bindings).every(id => !id.startsWith('falloff-')));
  const manager = new HotkeyManager();
  manager.setBindings(bindings);
  for (const code of ['KeyF', 'KeyQ', 'BracketLeft', 'BracketRight']) assert.equal(manager.resolve(key(code)), null);
});

test('Ctrl V pastes normally and Ctrl Shift V pastes in place', () => {
  const manager = new HotkeyManager({mac: false});
  assert.equal(manager.resolve(key('KeyV', {ctrlKey: true}))?.id, 'paste');
  assert.equal(manager.resolve(key('KeyV', {ctrlKey: true, shiftKey: true}))?.id, 'paste-in-place');
  assert.deepEqual(normalizeHotkeys({})['paste-in-place'], ['Mod+Shift+KeyV']);
});

test('builder split supports extra Shift without treating a remapped binding Shift as scope', () => {
  const calls = [], manager = new HotkeyManager({mac: false, run: (id, event, modifiers) => calls.push([id, modifiers.shift])});
  assert.equal(manager.resolve(key('KeyS')), null);
  manager.keydown(key('KeyS'), ['builder']);
  manager.keydown(key('KeyS', {shiftKey: true}), ['builder']);
  manager.keydown(key('KeyB'), ['builder']);
  manager.setBindings({'split-segment': ['Mod+Shift+KeyQ']});
  manager.keydown(key('KeyQ', {ctrlKey: true, shiftKey: true}), ['builder']);
  assert.deepEqual(calls, [['split-segment', false], ['split-segment', true], ['toggle-builder-branch', false], ['split-segment', false]]);
});

test('J joins and unjoins once; Shift J controls visibility and old defaults migrate', () => {
  const calls = [], manager = new HotkeyManager({run: id => calls.push(id)});
  assert.equal(manager.resolve(key('KeyJ'))?.id, 'join-figure');
  assert.equal(manager.resolve(key('KeyJ', {shiftKey: true}))?.id, 'toggle-handles');
  manager.keydown(key('KeyJ')); manager.keydown(key('KeyJ', {repeat: true}));
  assert.deepEqual(calls, ['join-figure']);
  const migrated = normalizeHotkeys({'toggle-handles': ['KeyJ']});
  assert.deepEqual(migrated['join-figure'], ['KeyJ']);
  assert.deepEqual(migrated['toggle-handles'], ['Shift+KeyJ']);
  assert.deepEqual(normalizeHotkeys(migrated), migrated);
  for (const custom of [[], ['KeyQ']])
    assert.deepEqual(normalizeHotkeys({'toggle-handles': custom})['toggle-handles'], custom);
  const explicit = normalizeHotkeys({'join-figure': [], 'toggle-handles': ['KeyJ']});
  assert.deepEqual(explicit['join-figure'], []);
  assert.deepEqual(explicit['toggle-handles'], ['KeyJ']);
  assert.deepEqual(normalizeHotkeys({save: ['KeyJ']})['join-figure'], []);
});
test('catalog defaults are unique, valid and stable; A replaces Ctrl Enter everywhere', () => {
  assert.equal(new Set(HOTKEY_COMMANDS.map(c => c.id)).size, HOTKEY_COMMANDS.length);
  assert.deepEqual(normalizeHotkeys(DEFAULT_HOTKEYS), DEFAULT_HOTKEYS);
  assert.deepEqual(DEFAULT_HOTKEYS['add-frame'], ['KeyA']);
  const manager = new HotkeyManager();
  for (const scopes of [[], ['timeline'], ['simple'], ['canvas'], ['builder']]) {
    assert.equal(manager.resolve(key('KeyA'), scopes)?.id, 'add-frame');
    assert.equal(manager.resolve(key('Enter', {ctrlKey:true}), scopes), null);
  }
});
test('normalization validates modifiers and codes and preserves explicit unassignment', () => {
  assert.equal(normalizeBinding('Shift+Mod+KeyA'), 'Mod+Shift+KeyA');
  for (const bad of ['A', 'Mod+Mod+KeyA', 'Ctrl+Mod+KeyA', '<script>', 'Shift', 'Foo+KeyA', '', null]) assert.equal(normalizeBinding(bad), null);
  const value = normalizeHotkeys({save:[], undo:['bad'], unknown:['KeyA'], redo:['Mod+KeyY','Mod+KeyY']});
  assert.deepEqual(value.save, []); assert.deepEqual(value.undo, DEFAULT_HOTKEYS.undo);
  assert.deepEqual(value.redo, ['Mod+KeyY']); assert.equal(value.unknown, undefined);
  value.undo.push('KeyQ'); assert.deepEqual(DEFAULT_HOTKEYS.undo, ['Mod+KeyZ']);
});
test('preferences round-trip and old preferences receive defaults without losing settings', () => {
  const settings = normalizeEditorSettings({timelineMode:'simple', handleSize:8, hotkeys:{'add-frame':['KeyB'], save:[]}});
  assert.equal(settings.timelineMode, 'simple'); assert.equal(settings.handleSize, 8);
  assert.deepEqual(normalizeEditorSettings(JSON.parse(JSON.stringify(settings))), settings);
  assert.deepEqual(normalizeEditorSettings({locale:'it'}).hotkeys['add-frame'], ['KeyA']);
});
test('a custom binding replaces its previous default immediately', () => {
  const calls = [], manager = new HotkeyManager({run:id=>calls.push(id)});
  manager.setBindings({'add-frame':['KeyB']});
  assert.equal(manager.keydown(key('KeyA')), false);
  assert.equal(manager.keydown(key('KeyB')), true);
  manager.setBindings({'add-frame':[]});
  assert.equal(manager.keydown(key('KeyA')), false); assert.equal(manager.keydown(key('KeyB')), false);
  assert.deepEqual(calls, ['add-frame']);
});
test('exact modifier matching avoids destructive plain-key fallthrough', () => {
  const manager = new HotkeyManager({mac: false});
  assert.equal(manager.resolve(key('KeyA', {ctrlKey:true}))?.id, 'select-all');
  assert.equal(manager.resolve(key('KeyA', {altKey:true})), null);
  assert.equal(manager.resolve(key('KeyA', {shiftKey:true}))?.id, 'extend-keyframe');
  assert.equal(manager.resolve(key('Delete', {ctrlKey:true})), null);
});
test('context precedence preserves canvas nudging, hovered locate and builder shortcuts', () => {
  const manager = new HotkeyManager();
  assert.equal(manager.resolve(key('ArrowRight'), ['canvas'])?.id, 'handle-right');
  assert.equal(manager.resolve(key('Period'), ['timeline'])?.id, 'next-frame');
  assert.equal(manager.resolve(key('KeyL'), ['hover','canvas'])?.id, 'locate-previous');
  assert.equal(manager.resolve(key('KeyL'))?.id, 'tool-line');
  assert.equal(manager.resolve(key('F10'), ['canvas','builder'])?.id, 'builder-static-handles');
  assert.equal(manager.resolve(key('F10'))?.id, 'camera-align-view');
});
test('conflicts account for aliases and Shift selection variants within a scope', () => {
  assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS, 'save', 'Ctrl+KeyZ', false).map(c=>c.id), ['undo']);
  assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS, 'save', 'Shift+Period').map(c=>c.id), ['next-keyframe']);
  assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS, 'tool-select', 'KeyA').map(c=>c.id), ['add-frame']);
  assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS, 'handle-right', 'ArrowRight'), []);
});
test('conflicting persisted assignments recover deterministically with custom bindings winning', () => {
  const bindings = normalizeHotkeys({save:['Mod+KeyZ']});
  assert.deepEqual(bindings.save, ['Mod+KeyZ']); assert.deepEqual(bindings.undo, []);
  assert.deepEqual(normalizeHotkeys(bindings), bindings);
});
test('non-repeat commands execute once, navigation repeats, blocked commands are consumed', () => {
  const calls = [], manager = new HotkeyManager({run:id=>calls.push(id)});
  manager.keydown(key('KeyA')); manager.keydown(key('KeyA', {repeat:true}));
  manager.keydown(key('Period')); manager.keydown(key('Period', {repeat:true}));
  const blocked = key('Delete'); manager.keydown(blocked, [], () => false);
  assert.equal(blocked.defaultPrevented, true);
  assert.deepEqual(calls, ['add-frame','next-frame','next-frame']);
});
test('remapped held keys release by physical code after modifiers and focus change', () => {
  const calls = [], manager = new HotkeyManager({mac: false, bindings:{'handle-edit-hold':['Mod+KeyQ']}, run:id=>calls.push(['down',id]), release:(id,event)=>calls.push(['up',id,Boolean(event.cancelled)])});
  manager.keydown(key('KeyQ', {ctrlKey:true}));
  manager.keyup(key('ControlLeft')); assert.equal(manager.held.size,1);
  manager.keyup(key('KeyQ', {target:{}}));
  assert.deepEqual(calls,[['down','handle-edit-hold'],['up','handle-edit-hold',false]]);
  assert.equal(manager.held.size,0);
});
test('blur, cancellation and rebinding release all held actions without tap actions', () => {
  const releases=[], manager = new HotkeyManager({release:(id,event)=>releases.push([id,event.cancelled])});
  manager.keydown(key('Space')); manager.keydown(key('KeyR')); manager.releaseAll(); manager.releaseAll();
  manager.keydown(key('CapsLock')); manager.setBindings({});
  assert.deepEqual(releases,[['play-pan',true],['handle-edit-hold',true],['isolate-hold',true]]);
  assert.equal(manager.held.size,0);
});
test('composing, AltGraph, modifier-only and already-handled events do not execute', () => {
  const calls=[], manager = new HotkeyManager({run:id=>calls.push(id)});
  for (const event of [key('KeyA',{isComposing:true}),key('KeyA',{keyCode:229}),key('KeyA',{getModifierState:()=>true}),key('ControlLeft'),key('KeyA',{defaultPrevented:true})]) assert.equal(manager.keydown(event),false);
  assert.deepEqual(calls,[]);
});
test('Ctrl / Command are portable while secondary platform modifiers remain distinct', () => {
  assert.equal(eventBinding(key('KeyS',{metaKey:true}),true),'Mod+KeyS');
  assert.equal(eventBinding(key('KeyS',{ctrlKey:true}),true),'Ctrl+KeyS');
  const manager=new HotkeyManager({mac:true});
  assert.equal(manager.resolve(key('KeyS',{metaKey:true}))?.id,'save');
  assert.equal(manager.resolve(key('KeyS',{ctrlKey:true})),null);
  assert.equal(manager.label('save'), 'Cmd+S');
  assert.equal(new HotkeyManager({mac:false}).label('save'), 'Ctrl+S');
  const customized = new HotkeyManager({mac:true,bindings:{save:['Meta+KeyZ']}});
  assert.deepEqual(customized.bindings.undo,[]);
  assert.equal(customized.resolve(key('KeyZ',{metaKey:true}))?.id,'save');
});
test('hints show alternatives and cleared shortcuts without reverting to defaults', () => {
  assert.equal(shortcutLabel({'add-frame':[]},'add-frame'),'');
  assert.equal(shortcutLabel({'add-frame':['KeyB','KeyQ']},'add-frame'),'B / Q');
  assert.equal(isHotkeyInput({closest:selector=>selector.includes('contenteditable') ? {} : null}),true);
  assert.equal(isHotkeyInput(null),false);
});
test('Shift inside a custom binding does not accidentally extend or align the action', () => {
  const gestures=[],manager=new HotkeyManager({mac: false, bindings:{'timeline-layer-down':['Mod+Shift+KeyB'],'handle-right':['KeyQ']},run:(id,event,modifiers)=>gestures.push([id,modifiers.shift])});
  manager.keydown(key('KeyB',{ctrlKey:true,shiftKey:true}), ['timeline']);
  manager.keydown(key('KeyQ'),['canvas']);
  manager.keydown(key('KeyQ',{shiftKey:true,repeat:true}),['canvas']);
  assert.deepEqual(gestures,[['timeline-layer-down',false],['handle-right',false],['handle-right',true]]);
});

test('retired frame commands migrate without losing custom or disabled bindings', () => {
  assert.deepEqual(normalizeHotkeys({'add-frame':['F6'],'duplicate-frame-after':['KeyA']})['add-frame'], ['KeyA']);
  assert.deepEqual(normalizeHotkeys({'add-frame':['F6'],'duplicate-frame-after':['KeyB']})['add-frame'], ['KeyB']);
  assert.deepEqual(normalizeHotkeys({'add-frame':['F7'],'duplicate-frame-after':['KeyB']})['add-frame'], ['F7']);
  assert.deepEqual(normalizeHotkeys({'add-frame':[],'duplicate-frame-after':['KeyB']})['add-frame'], []);
  for (const id of ['blank-frame','insert-frames','duplicate-frame-after']) assert.equal(id in DEFAULT_HOTKEYS, false);
});


test('frame and keyframe punctuation defaults work in every editing scope', () => {
  const manager = new HotkeyManager();
  for (const scopes of [[], ['timeline'], ['simple'], ['canvas'], ['builder']]) {
    for (const [code, direction] of [['Comma', 'previous'], ['Period', 'next']]) {
      assert.equal(manager.resolve(key(code), scopes)?.id, `${direction}-frame`);
      assert.equal(manager.resolve(key(code, {shiftKey:true}), scopes)?.id, `${direction}-keyframe`);
    }
  }
  const old = normalizeHotkeys({'previous-frame':['ArrowLeft'], 'next-frame':['ArrowRight'], 'previous-exposure':['Comma'], 'next-exposure':['Period']});
  assert.deepEqual(old, DEFAULT_HOTKEYS);
  assert.deepEqual(normalizeHotkeys(old), old);
  const custom = normalizeHotkeys({'previous-frame':[], 'next-frame':['KeyQ'], 'next-exposure':['KeyW']});
  assert.deepEqual(custom['previous-frame'], []);
  assert.deepEqual(custom['next-frame'], ['KeyQ']);
  assert.deepEqual(custom['next-exposure'], ['KeyW']);
});

test('origin selection settings normalize safely and selection commands can be remapped', () => {
  assert.equal(normalizeEditorSettings({}).marqueeSelection, 'origins');
  assert.equal(normalizeEditorSettings({marqueeSelection:'origins'}).marqueeSelection, 'origins');
  assert.equal(normalizeEditorSettings({marqueeSelection:'unknown'}).marqueeSelection, 'origins');
  assert.equal(normalizeEditorSettings({marqueeSelection:'bounds'}).marqueeSelection, 'bounds');
  const manager = new HotkeyManager({mac: false, bindings: {'toggle-selection-origins': ['Mod+Shift+KeyB'], 'toggle-range-edit': ['Mod+Shift+KeyR']}});
  manager.setBindings({'toggle-selection-origins': ['Mod+Shift+KeyB'], 'toggle-range-edit': ['Mod+Shift+KeyR']});
  assert.equal(manager.resolve(key('KeyB', {ctrlKey:true,shiftKey:true}))?.id, 'toggle-selection-origins');
  assert.equal(manager.resolve(key('KeyR', {ctrlKey:true,shiftKey:true}))?.id, 'toggle-range-edit');
  assert.deepEqual(DEFAULT_HOTKEYS['toggle-selection-origins'], []);
  assert.deepEqual(DEFAULT_HOTKEYS['toggle-range-edit'], []);
});

test('Ctrl+P, Ctrl+Shift+P and F1 open the command palette without taking a key from another command', () => {
  assert.deepEqual(DEFAULT_HOTKEYS['command-palette'], ['Mod+KeyP', 'Mod+Shift+KeyP', 'F1']);
  const manager = new HotkeyManager({mac: false});
  for (const scopes of [[], ['canvas', 'hover'], ['timeline'], ['simple'], ['builder'], ['drawing'], ['polygon'], ['library']]) {
    assert.equal(manager.resolve(key('KeyP', {ctrlKey: true}), scopes)?.id, 'command-palette', `Ctrl+P in ${scopes}`);
    assert.equal(manager.resolve(key('KeyP', {ctrlKey: true, shiftKey: true}), scopes)?.id, 'command-palette', `Ctrl+Shift+P in ${scopes}`);
    assert.equal(manager.resolve(key('F1'), scopes)?.id, 'command-palette', `F1 in ${scopes}`);
    assert.equal(manager.resolve(key('KeyP'), scopes)?.id, 'tool-pose', `P alone is still the Pose tool in ${scopes}`);
  }
  assert.equal(new HotkeyManager({mac: true}).resolve(key('KeyP', {metaKey: true}))?.id, 'command-palette', 'Command+P on macOS');
  // A person's own binding wins: the palette keeps its other keys.
  const custom = normalizeHotkeys({save: ['Mod+KeyP']}, false);
  assert.deepEqual([custom.save, custom['command-palette']], [['Mod+KeyP'], ['Mod+Shift+KeyP', 'F1']]);
});

test('the shell keys reach their commands in every scope without taking another key', () => {
  const manager = new HotkeyManager({mac: false});
  for (const scopes of [[], ['canvas', 'hover'], ['timeline'], ['simple'], ['builder'], ['drawing'], ['polygon'], ['library']]) {
    assert.equal(manager.resolve(key('F6'), scopes)?.id, 'focus-next-region', `F6 in ${scopes}`);
    assert.equal(manager.resolve(key('F6', {ctrlKey: true}), scopes)?.id, 'focus-previous-region', `Ctrl+F6 in ${scopes}`);
    assert.equal(manager.resolve(key('Backslash', {ctrlKey: true}), scopes)?.id, 'layout-focus', `Ctrl+\ in ${scopes}`);
    assert.equal(manager.resolve(key('KeyM', {ctrlKey: true, altKey: true}), scopes)?.id, 'layout-arrange', `Ctrl+Alt+M in ${scopes}`);
  }
  // Shift+F6 still removes keyframes in the timeline.
  assert.equal(manager.resolve(key('F6', {shiftKey: true}), ['timeline'])?.id, 'clear-keys');
  // Ctrl+1–4 are the desktop app's (a browser keeps them for its tabs): free there, and unbound here.
  const desktop = {...DEFAULT_HOTKEYS, ...DESKTOP_PANEL_KEYS};
  for (const [id, keys] of Object.entries(DESKTOP_PANEL_KEYS)) {
    assert.deepEqual(DEFAULT_HOTKEYS[id], [], `${id} has no browser default`);
    for (const binding of keys) assert.deepEqual(findHotkeyConflicts(desktop, id, binding, false).map(command => command.id), [], `${binding} is free`);
  }
  assert.deepEqual(Object.values(DESKTOP_PANEL_KEYS).flat(), ['Mod+Digit1', 'Mod+Digit2', 'Mod+Digit3', 'Mod+Digit4']);
});
