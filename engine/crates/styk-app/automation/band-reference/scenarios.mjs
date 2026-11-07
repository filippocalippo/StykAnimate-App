// The band's screenshot scenarios, shared by today's app (Chromium, shots.mjs) and the native app (make-script.mjs).
export const NAMES = ['Rooftop fight', 'Chase', 'Untitled animation'];
export const HEIGHT = 900;

const rest = {names: NAMES, dirty: [false, true, false], front: 1, session: ''};
const stepWidths = [['wide', 1560], ['tight', 903], ['name', 879], ['save', 851], ['winctl', 813], ['switchtight', 789], ['icons', 720], ['dot', 610], ['redo', 522], ['primary', 490], ['narrowest', 400]];

export const SCENARIOS = [
  ...stepWidths.map(([step, width]) => ({id: `rest-${step}-light`, theme: 'light', width, ...rest})),
  ...[['wide', 1560], ['icons', 720], ['narrowest', 400]].map(([step, width]) => ({id: `rest-${step}-dark`, theme: 'dark', width, ...rest})),
  ...['build', 'movieclip', 'camera'].map(session => ({id: `${session}-1000-light`, theme: 'light', width: 1000, ...rest, session, workspace: session === 'build' ? 'rig' : 'animate'})),
  {id: 'build-1560-dark', theme: 'dark', width: 1560, ...rest, session: 'build', workspace: 'rig'},
  {id: 'movieclip-1560-light', theme: 'light', width: 1560, ...rest, session: 'movieclip'},
  {id: 'build-narrowest-light', theme: 'light', width: 480, ...rest, session: 'build', workspace: 'rig'},
  {id: 'one-tab-wide-light', theme: 'light', width: 1560, names: ['Untitled animation'], dirty: [false], front: 0, session: ''},
  {id: 'twelve-tabs-light', theme: 'light', width: 1560, names: Array.from({length: 12}, (_, i) => `Project ${i + 1}`), dirty: Array.from({length: 12}, (_, i) => i === 3), front: 5, session: ''},
];
