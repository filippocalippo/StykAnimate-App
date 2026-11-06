/**
 * Wires tests/fixtures/ui-chrome.html: without ?theme it shows the page twice,
 * light and dark side by side; with ?theme=light|dark it renders the gallery
 * in that theme, with live tool options bars (tool-options.mjs) and quick
 * action rows (quick-actions.mjs) over a command registry whose commands only
 * log their id to fixture.log, through the same [data-action] click
 * delegation the app uses. Each stage header carries PropertyControls, as the
 * app's will, and hosts its bar's More options popover (popoverMount), so the
 * scrub fields commit there too: fixture.properties logs "commit <key> <value>".
 */
import {icon, hydrateIcons} from '/src/icons.mjs';
import {createCommandRegistry} from '/src/ui/command-registry.mjs';
import {CATALOG_REQUIREMENTS, COMMAND_BY_ID} from '/src/ui/command-catalog.mjs';
import {createToolOptions} from '/src/ui/tool-options.mjs';
import {createQuickActions} from '/src/ui/quick-actions.mjs';
import {PropertyControls} from '/src/property-controls.mjs';

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme !== 'light' && theme !== 'dark') {
  document.body.replaceChildren(Object.assign(document.createElement('div'), {className: 'fixture-pair'}));
  for (const name of ['light', 'dark']) {
    const frame = document.createElement('iframe');
    frame.title = `${name} theme`;
    frame.src = `${location.pathname}?theme=${name}`;
    document.querySelector('.fixture-pair').append(frame);
  }
  window.fixture = {ready: true, pair: true};
} else {
  document.documentElement.dataset.theme = theme;
  const log = [];
  const state = {mode: 'animate', isolate: true, handles: true};
  const actions = Object.fromEntries([...COMMAND_BY_ID.keys()].map(id => [id, () => { log.push(id); }]));
  const commands = createCommandRegistry({
    actions, context: () => state,
    requirements: Object.fromEntries(CATALOG_REQUIREMENTS.map(name => [name, () => !name.startsWith('desktop')])),
    checked: (id, context) => ({'toggle-isolate': context.isolate, 'toggle-handles': context.handles})[id],
  });
  // The app's delegation: a click on [data-action] runs the action (Shift picks data-shift-action).
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const name = event.shiftKey ? control.dataset.shiftAction ?? control.dataset.action : control.dataset.action;
    actions[name]?.(control, event);
  });
  hydrateIcons(document);
  document.getElementById('crumb-chip').style.setProperty('--swatch', '#ffffff');
  document.getElementById('badge-swatch').style.setProperty('--swatch', '#e8553a');

  const brush = (pressure = true) => [
    {id: 'colors', kind: 'colors', label: 'Colors', stroke: '#0c0d12', fill: '#ffffff', swap: {command: 'drawing-swap-colors', icon: 'reset'}},
    [
      {id: 'size', kind: 'field', label: 'Size', property: 'brushSize', value: 8, unit: 'px', vch: 3},
      {id: 'opacity', kind: 'field', label: 'Opacity', property: 'brushOpacity', value: 100, unit: '%', vch: 3},
      {id: 'flow', kind: 'field', label: 'Flow', property: 'brushFlow', value: 100, unit: '%', vch: 3, fold: 5},
      {id: 'smooth', kind: 'field', label: 'Smooth', property: 'brushSmooth', value: 20, unit: '%', vch: 3, fold: 4},
    ],
    {id: 'mirror', kind: 'toggles', label: 'Mirror', description: 'Mirror painting', fold: 2, twin: 'mirror-twin-brush', items: [
      {id: 'mirror-x', kind: 'toggle', label: 'Mirror horizontally', icon: 'flip', command: 'drawing-mirror', pressed: false},
      {id: 'mirror-y', kind: 'toggle', label: 'Mirror vertically', icon: 'flip-vertical', pressed: false},
    ]},
    {id: 'pressure', kind: 'toggle', label: 'Pen pressure', icon: 'brush', pressed: pressure, fold: 3, home: 'Brush details › Dynamics',
      tip: 'Pen pressure (Brush details › Dynamics when the window is narrow)', attributes: {'data-draw-setting': 'pressure'}},
    {id: 'recent', kind: 'recent', label: 'Recent colors', colors: ['#e8553a', '#0d99ff', '#18a058', '#f5b400'], fold: 1, home: 'Brush › Recent'},
  ];
  const editJoints = [
    {id: 'mode', kind: 'select', label: 'Drag', description: 'Rig edit mode', showLabel: true, labelFold: 3, elementId: 'rig-mode', value: 'joint',
      options: [{value: 'joint', label: 'Move joint'}, {value: 'branch', label: 'Rotate branch'}]},
    [
      {id: 'branch', kind: 'toggle', label: 'Whole branch', showLabel: true, accent: true, icon: 'builder-branch', pressed: true, labelFold: 1,
        elementId: 'builder-branch', command: 'toggle-builder-branch'},
      {id: 'snap', kind: 'toggle', label: 'Snapping', showLabel: true, icon: 'builder-snap', pressed: true, labelFold: 2, fold: 2, home: 'View › Build',
        elementId: 'builder-snap'},
    ],
  ];
  const selectPixels = [
    {id: 'shape', kind: 'segmented', label: 'Selection shape', iconOnly: true, value: 'lasso',
      options: [{value: 'lasso', label: 'Lasso', icon: 'lasso'}, {value: 'rect', label: 'Rectangle', icon: 'frame'}, {value: 'ellipse', label: 'Ellipse', icon: 'circle'}]},
    [
      {id: 'apply', kind: 'button', command: 'drawing-apply', icon: 'check'},
      {id: 'deselect', kind: 'button', command: 'drawing-deselect', icon: 'close'},
      {id: 'invert', kind: 'button', command: 'drawing-invert-selection', label: 'Invert', showLabel: true, icon: 'lasso'},
    ],
  ];
  const tweener = [
    {id: 'blend', kind: 'segmented', label: 'Tweener mode', value: 'breakdown',
      options: ['Breakdown', 'Neighbor', 'Push', 'Relax'].map(label => ({value: label.toLowerCase(), label}))},
    {id: 'amount', kind: 'field', label: 'Amount', value: 50, unit: '%', vch: 3},
    {id: 'steps', kind: 'stepper', label: 'Steps', showLabel: true, value: 3, min: 1, max: 12},
    {id: 'onion', kind: 'split', label: 'Onion skin', icon: 'onion', command: 'toggle-onion', more: {label: 'Onion skin settings'}},
  ];

  const changes = [], folds = {}, properties = [];
  const host = document.getElementById('optbars');
  const bars = {};
  // Each bar belongs to its tool's workspace, as in the app: Draw's and Build's commands are live there.
  const bar = (name, descriptors, width, label, mode = 'animate') => {
    const head = document.createElement('div');
    head.className = 'stage-head';
    head.setAttribute('role', 'toolbar');
    head.setAttribute('aria-label', `Stage (${name})`);
    head.style.inlineSize = width;
    const start = document.createElement('div');
    start.className = 'stage-head-start';
    const end = document.createElement('div');
    end.className = 'stage-head-end';
    end.innerHTML = '<div class="stage-head-cluster"><button type="button" class="ui-icon-button" aria-label="Fit canvas" data-action="zoom-reset"></button></div>';
    end.querySelector('button').insertAdjacentHTML('beforeend', icon('fit'));
    const local = {...state, mode};
    new PropertyControls(head, {commit: ({key, value}) => { properties.push(`commit ${key} ${value}`); }});
    bars[name] = createToolOptions({descriptors, label, tool: name, registry: commands, context: () => local, icon, popoverMount: head,
      onChange: change => changes.push({bar: name, ...change, element: undefined, event: undefined}), onFold: state => { folds[name] = state; }});
    start.append(bars[name].element);
    head.append(start, end);
    host.append(head);
    return bars[name];
  };
  bar('brush-wide', brush(), '900px', 'Brush options', 'draw');
  bar('brush-medium', brush(), '560px', 'Brush options', 'draw');
  bar('brush-narrow', brush(), '400px', 'Brush options', 'draw');
  bar('edit-joints', editJoints, '640px', 'Edit joints options', 'rig');
  bar('edit-joints-narrow', editJoints, '260px', 'Edit joints options', 'rig');
  bar('select-pixels', selectPixels, '640px', 'Select pixels options', 'draw');
  bar('tweener', tweener, '760px', 'Tweener options');

  const quickHost = document.getElementById('quick-rows');
  const rows = {};
  const quick = (name, context, {pins = [], mode = 'animate', title} = {}) => {
    const heading = document.createElement('h3');
    heading.textContent = title;
    quickHost.append(heading);
    const local = {...state, mode};
    rows[name] = createQuickActions({context, pins, registry: commands, commandContext: () => local, icon});
    quickHost.append(rows[name].element);
  };
  quick('figure', 'figure', {title: 'Bubble'});
  quick('pinned', 'figure', {title: 'Bubble, two pins', pins: ['reset-pose', 'rotate']});
  quick('joint', 'joint', {title: 'Joint 4 (Isolate on)'});
  quick('movieclip', 'movieclip', {title: 'Punch'});
  quick('part', 'part', {title: 'Line 4', mode: 'rig'});
  quick('camera', 'camera', {title: 'Camera'});
  quick('range', 'range', {title: 'Frames 22–28'});

  document.getElementById('fixture').hidden = false;
  window.fixture = {ready: true, theme, log, changes, folds, properties, bars, rows, commands, state, addBar: bar,
    descriptors: {brush, editJoints, selectPixels, tweener}};
}
