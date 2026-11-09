/**
 * The tutorials (docs/TUTORIALS.md): pure data, no DOM and no editor.
 *
 * A tutorial is {id, icon, tint, minutes, titleKey, lineKey, setup, steps}.
 * `setup` says how its practice animation starts: {selection: 'none' |
 * 'figure'}. Every tutorial runs in the Animate workspace with the Advanced
 * timeline, on a new practice animation.
 *
 * A step is {id, target, sayKey, moreKey, done, doneKey, demo}:
 *   target   what the step is about, resolved by tutorial-targets.mjs:
 *            {selector}, {canvas: 'stage' | 'figure' | 'origin' | 'joint',
 *            segment}, or {timeline: 'ruler' | 'grid' | 'labels'}
 *   sayKey   the one sentence the strip shows: a message key, or (app) => key
 *            where the words depend on a setting, on touch or on a shortcut
 *            being bound (app: {touch, zoomGesture, shortcut(command)})
 *   shortcut the command whose keys the step names: {shortcut} in its words,
 *            and a "Shortcut" line under its explanation
 *   moreKey  the longer explanation, shown on request
 *   done     (now, start) => boolean: the step is finished. `now` is the
 *            editor as tutorial-probe.mjs reads it, `start` what it read when
 *            the step began, `now.ran` the commands run since. A step without
 *            `done` only explains: the person presses Next.
 *   doneKey  what the strip says once it is done: a key, or (now) => key
 *   demo     how "Show me" demonstrates it: {kind: 'click' | 'drag' | 'scroll'
 *            | 'keys', ...}
 * Message parameters: {shortcut} is the step's `shortcut` command's keys as
 * the person bound them.
 *
 * The practice animation is the startup document: Blue alone on the stage,
 * one pose at frame 1 held through frame 10. Blue's segments are numbered as
 * in src/startup-blue-data.mjs: 4 is the left forearm (the hand on the right
 * of the stage), 8 the left lower leg.
 */
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;
const moved = (now, start) => Math.hypot(now.viewX - start.viewX, now.viewY - start.viewY);

/** Blue's hand on the right of the stage: the joint the posing steps point at. */
export const PRACTICE_HAND = 4;

const STAGE = Object.freeze({canvas: 'stage'});
const FIGURE = Object.freeze({canvas: 'figure'});
const HAND = Object.freeze({canvas: 'joint', segment: PRACTICE_HAND});

export const TUTORIALS = Object.freeze([
  {
    id: 'tour', icon: 'home', tint: 'select', minutes: 2,
    titleKey: 'tutorials.tour.title', lineKey: 'tutorials.tour.line',
    setup: {selection: 'figure'},
    steps: [
      {id: 'stage', target: STAGE, sayKey: 'tutorials.tour.stage.say', moreKey: 'tutorials.tour.stage.more'},
      {id: 'tools', target: {selector: '.studio-rail'}, sayKey: 'tutorials.tour.tools.say', moreKey: 'tutorials.tour.tools.more'},
      {id: 'deselect', target: STAGE, sayKey: 'tutorials.tour.deselect.say', moreKey: 'tutorials.tour.deselect.more',
        done: now => now.selected === null, doneKey: 'tutorials.tour.deselect.done', demo: {kind: 'click', at: 'corner'}},
      {id: 'select', target: FIGURE, sayKey: 'tutorials.tour.select.say', moreKey: 'tutorials.tour.select.more',
        done: now => now.selected !== null, doneKey: 'tutorials.tour.select.done', demo: {kind: 'click'}},
      {id: 'panels', target: {selector: '.shell-tabs:has(#properties-tab)'}, sayKey: 'tutorials.tour.panels.say', moreKey: 'tutorials.tour.panels.more'},
      {id: 'timeline', target: {selector: '#animation-timeline'}, sayKey: 'tutorials.tour.timeline.say', moreKey: 'tutorials.tour.timeline.more'},
      {id: 'workspaces', target: {selector: '.workspace-switch'}, sayKey: 'tutorials.tour.workspaces.say', moreKey: 'tutorials.tour.workspaces.more'},
    ],
  },
  {
    id: 'canvas', icon: 'hand', tint: 'library', minutes: 2,
    titleKey: 'tutorials.canvas.title', lineKey: 'tutorials.canvas.line',
    setup: {selection: 'none'},
    steps: [
      {id: 'zoom', target: FIGURE,
        sayKey: app => (app.touch ? 'tutorials.canvas.zoom.sayTouch' : app.zoomGesture === 'scroll' ? 'tutorials.canvas.zoom.sayScroll' : 'tutorials.canvas.zoom.say'),
        moreKey: 'tutorials.canvas.zoom.more', done: (now, start) => now.zoom > start.zoom * 1.15, doneKey: 'tutorials.canvas.zoom.done', demo: {kind: 'scroll'}},
      {id: 'pan', target: STAGE, sayKey: app => (app.touch ? 'tutorials.canvas.pan.sayTouch' : 'tutorials.canvas.pan.say'), moreKey: 'tutorials.canvas.pan.more',
        done: (now, start) => moved(now, start) > 40 && near(now.zoom, start.zoom, start.zoom * 0.02), doneKey: 'tutorials.canvas.pan.done',
        demo: {kind: 'drag', dx: -110, dy: 36, keys: ['Space']}},
      {id: 'fit', target: {selector: '.stage-head [data-action="zoom-reset"]'}, sayKey: 'tutorials.canvas.fit.say', moreKey: 'tutorials.canvas.fit.more', shortcut: 'zoom-reset',
        done: now => now.fitted, doneKey: 'tutorials.canvas.fit.done', demo: {kind: 'click'}},
      {id: 'exact', target: {selector: '#zoom-label'}, sayKey: 'tutorials.canvas.exact.say', moreKey: 'tutorials.canvas.exact.more',
        done: (now, start) => near(now.zoom, 1) && (now.ran.has('zoom-100') || !near(start.zoom, 1)), doneKey: 'tutorials.canvas.exact.done', demo: {kind: 'click'}},
      {id: 'grid', target: {selector: '#canvas-guides-button'}, sayKey: 'tutorials.canvas.grid.say', moreKey: 'tutorials.canvas.grid.more',
        done: (now, start) => now.grid !== start.grid, doneKey: 'tutorials.canvas.grid.done', demo: {kind: 'click'}},
    ],
  },
  {
    id: 'posing', icon: 'person', tint: 'select', minutes: 3,
    titleKey: 'tutorials.posing.title', lineKey: 'tutorials.posing.line',
    setup: {selection: 'none'},
    steps: [
      {id: 'select', target: FIGURE, sayKey: 'tutorials.posing.select.say', moreKey: 'tutorials.posing.select.more',
        done: now => now.selected !== null, doneKey: 'tutorials.posing.select.done', demo: {kind: 'click'}},
      {id: 'pose', target: HAND, sayKey: 'tutorials.posing.pose.say', moreKey: 'tutorials.posing.pose.more',
        done: (now, start) => now.pose !== start.pose, doneKey: 'tutorials.posing.pose.done', demo: {kind: 'drag', dx: 46, dy: -70}},
      {id: 'move', target: {canvas: 'origin'}, sayKey: 'tutorials.posing.move.say', moreKey: 'tutorials.posing.move.more',
        done: (now, start) => Math.hypot(now.rootX - start.rootX, now.rootY - start.rootY) > 6, doneKey: 'tutorials.posing.move.done', demo: {kind: 'drag', dx: 90, dy: 0}},
      {id: 'undo', target: {selector: '.titlebar [data-action="undo"]'}, sayKey: 'tutorials.posing.undo.say', moreKey: 'tutorials.posing.undo.more', shortcut: 'undo',
        done: (now, start) => now.canRedo && !start.canRedo, doneKey: 'tutorials.posing.undo.done', demo: {kind: 'click'}},
      {id: 'flip', target: {selector: '[data-slot="inspector-head"] [data-action="mirror"]'}, sayKey: 'tutorials.posing.flip.say', moreKey: 'tutorials.posing.flip.more',
        done: now => now.ran.has('mirror'), doneKey: 'tutorials.posing.flip.done', demo: {kind: 'click'}},
      {id: 'wrap', target: STAGE, sayKey: 'tutorials.posing.wrap.say', moreKey: 'tutorials.posing.wrap.more'},
    ],
  },
  {
    id: 'timeline', icon: 'timeline', tint: 'time', minutes: 3,
    titleKey: 'tutorials.timeline.title', lineKey: 'tutorials.timeline.line',
    setup: {selection: 'figure'},
    steps: [
      {id: 'look', target: {selector: '#animation-timeline'}, sayKey: 'tutorials.timeline.look.say', moreKey: 'tutorials.timeline.look.more'},
      {id: 'scrub', target: {timeline: 'ruler'}, sayKey: 'tutorials.timeline.scrub.say', moreKey: 'tutorials.timeline.scrub.more',
        done: (now, start) => now.tick !== start.tick, doneKey: 'tutorials.timeline.scrub.done', demo: {kind: 'drag', dx: 84, dy: 0}},
      {id: 'add', target: {selector: '.timeline-toolbar .sheet-add-frame'}, sayKey: 'tutorials.timeline.add.say', moreKey: 'tutorials.timeline.add.more', shortcut: 'add-frame',
        done: (now, start) => now.keys > start.keys, doneKey: 'tutorials.timeline.add.done', demo: {kind: 'click'}},
      {id: 'pose', target: HAND, sayKey: 'tutorials.timeline.pose.say', moreKey: 'tutorials.timeline.pose.more',
        done: (now, start) => now.pose !== start.pose, doneKey: 'tutorials.timeline.pose.done', demo: {kind: 'drag', dx: 46, dy: -70}},
      {id: 'play', target: {selector: '#play-button'}, sayKey: 'tutorials.timeline.play.say', moreKey: 'tutorials.timeline.play.more', shortcut: 'play',
        done: now => now.playing, doneKey: 'tutorials.timeline.play.done', demo: {kind: 'click'}},
      {id: 'stop', target: {selector: '#play-button'}, sayKey: 'tutorials.timeline.stop.say', moreKey: 'tutorials.timeline.stop.more',
        done: now => !now.playing, doneKey: 'tutorials.timeline.stop.done', demo: {kind: 'click'}},
      {id: 'onion', target: {selector: '#onion-button'}, sayKey: 'tutorials.timeline.onion.say', moreKey: 'tutorials.timeline.onion.more', shortcut: 'toggle-onion',
        done: (now, start) => now.onion !== start.onion, doneKey: now => (now.onion ? 'tutorials.timeline.onion.doneOn' : 'tutorials.timeline.onion.doneOff'), demo: {kind: 'click'}},
    ],
  },
  {
    id: 'panels', icon: 'layout', tint: 'camera', minutes: 2,
    titleKey: 'tutorials.panels.title', lineKey: 'tutorials.panels.line',
    setup: {selection: 'figure'},
    steps: [
      {id: 'library', target: {selector: '#library-tab'}, sayKey: 'tutorials.panels.library.say', moreKey: 'tutorials.panels.library.more',
        done: now => now.panels.library, doneKey: 'tutorials.panels.library.done', demo: {kind: 'click'}},
      {id: 'properties', target: {selector: '#properties-tab'}, sayKey: 'tutorials.panels.properties.say', moreKey: 'tutorials.panels.properties.more',
        done: now => now.panels.properties, doneKey: 'tutorials.panels.properties.done', demo: {kind: 'click'}},
      {id: 'palette', target: {selector: '.titlebar .brand'}, moreKey: 'tutorials.panels.palette.more', shortcut: 'command-palette',
        sayKey: app => (app.shortcut('command-palette') ? 'tutorials.panels.palette.say' : 'tutorials.panels.palette.sayMenu'),
        done: now => now.palette, doneKey: 'tutorials.panels.palette.done', demo: {kind: 'keys', command: 'command-palette'}},
      {id: 'layout', target: {selector: '.app-menubar [data-app-menu="view"], .titlebar .brand'}, sayKey: 'tutorials.panels.layout.say', moreKey: 'tutorials.panels.layout.more'},
      {id: 'home', target: {selector: '.titlebar [data-action="home"]'}, sayKey: 'tutorials.panels.home.say', moreKey: 'tutorials.panels.home.more'},
    ],
  },
].map(tutorial => Object.freeze({...tutorial, setup: Object.freeze(tutorial.setup), steps: Object.freeze(tutorial.steps.map(step => Object.freeze(step)))})));

export const tutorialById = id => TUTORIALS.find(tutorial => tutorial.id === id) ?? null;

/** Every message key the catalog names: a function key is asked for each kind of app, so none is missed. */
export function catalogKeys(tutorials = TUTORIALS) {
  const keys = new Set();
  const bound = () => 'Ctrl P', unbound = () => '';
  const apps = [{touch: false, zoomGesture: 'ctrl-scroll', shortcut: bound}, {touch: false, zoomGesture: 'scroll', shortcut: unbound}, {touch: true, zoomGesture: 'ctrl-scroll', shortcut: bound}];
  const states = [{onion: true}, {onion: false}];
  const add = (value, variants) => { if (typeof value === 'function') for (const variant of variants) keys.add(value(variant)); else if (value) keys.add(value); };
  for (const tutorial of tutorials) {
    keys.add(tutorial.titleKey); keys.add(tutorial.lineKey);
    for (const step of tutorial.steps) { add(step.sayKey, apps); add(step.moreKey, apps); add(step.doneKey, states); }
  }
  return [...keys];
}
