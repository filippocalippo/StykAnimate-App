// Report views of the website's statistics, as its README (worker/stats/README.md in the site's repository)
// gives them, for the tests of scripts/stats.mjs. Releases 9.1.0 and 9.0.0 are the README's synthetic ones.

const envelope = view => ({
  view,
  generatedAt: '2026-11-12T23:39:15.587Z',
  rolledUpTo: '2026-11-12T23:30:00.412Z',
  minGroup: 20,
  period: { days: 7, from: '2026-11-06', to: '2026-11-12' },
  sample: { percent: 100, sampled: false, effective: 1 },
  filters: { channel: 'stable', platform: 'all', release: '9.1.0', compare: '9.0.0' },
  sessions: 1050,
  stored: 1050,
  release: { version: '9.1.0', firstDay: '2026-11-06', age: 6 },
  compare: { release: '9.0.0', firstDay: '2026-10-16', from: '2026-10-16', to: '2026-10-22', sessions: 2604, stored: 735, sampled: true },
});

const VERDICT = '9.1.0 needs attention: a new engine stop reached 28 sessions, and 5 more things to look at.';

const BRIEF_R = [
  'Finding R-ff75, release 9.1.0, 57 sessions in 7 days.',
  'While dragging in scenes of 50,000 to 200,000 segments on integrated graphics with less than 16 GB of memory, 71% of frames were smooth (9.0.0: 88%).',
  'Reproduce: npm run perf -- run --scenario pose.drag-joint --workload stress',
  'Measure: what npm run perf -- compare <the run before the change> says about pose.drag-joint, before and after the change.',
  'Done when: smooth share is back to 88% or better here, and the other interactions hold.',
  'Read first: docs/engine/README.md, docs/engine/editing.md',
].join('\n');

const BRIEF_E = [
  'Finding E-a786, new in release 9.1.0, 28 sessions in 7 days (2.7% of sessions).',
  'The engine stops with "index out of bounds: the len is 0 but the index is 0" at encode_strokes styk-eval/src/drawlist.rs:412.',
  'Reproduce: follow the most common trail: file.open, onion.toggle, timeline.play, export.video.',
  'Done when: a Rust test in styk-eval fails for this reason before the fix and passes after, and the group stops arriving after the next release.',
  'Read first: docs/engine/README.md, docs/document-exports.md',
].join('\n');

export const FINDINGS = [
  {
    id: 'E-a786', kind: 'problem', severity: 'critical', sessions: 28,
    title: 'The engine stops: index out of bounds: the len is # but the index is #',
    summary: 'New in 9.1.0 · 28 sessions · encode_strokes styk-eval/src/drawlist.rs',
    evidence: { sig: 'a786ede6755b92d1', type: 'engine', title: 'index out of bounds: the len is # but the index is #', sessions: 28, share: 0.0267, recovered: 0, firstVersion: '9.1.0', firstDay: '2026-11-06', isNew: true },
    brief: BRIEF_E,
    open: { view: 'problems/a786ede6755b92d1', params: { channel: 'stable', platform: 'all', release: '9.1.0', compare: '9.0.0', days: 7 } },
  },
  {
    id: 'R-ff75', kind: 'responsiveness', severity: 'warning', sessions: 57,
    title: 'Dragging stutters in scenes of 50,000 to 200,000 segments on integrated graphics with less than 16 GB of memory',
    summary: 'Worse than 9.0.0 · 57 sessions · smooth frames fell from 88% to 71%',
    evidence: { doing: 'drag', scene: '50k-200k', machine: 'integrated-small', sessions: 57, frames: 42541, smooth: 0.714, p50: 17, p95: 100, worst: 420,
      compare: { sessions: 29, frames: 24145, smooth: 0.877, p50: 12, p95: 83, worst: 420 } },
    brief: BRIEF_R,
    open: { view: 'responsiveness', params: { channel: 'stable', platform: 'all', release: '9.1.0', compare: '9.0.0', days: 7, doing: 'drag' }, cell: { scene: '50k-200k', machine: 'integrated-small' } },
  },
  {
    id: 'F-5a1c', kind: 'files', severity: 'warning', sessions: 42,
    title: 'Stick Nodes 4.3 files fail to open',
    summary: 'Since 9.1.0 · 8 of 42 opens failed · a version the reader does not know',
    evidence: { made: 'sticknodes/4.3', format: 'sticknodes', opens: 42, failed: 8, rate: 0.1905, sessions: 42, since: '9.1.0', reasons: [{ stage: 'decode', reason: 'unsupported-version', n: 8 }] },
    brief: 'Finding F-5a1c, since release 9.1.0, 8 failed opens in 7 days.\nDone when: these files open.\nRead first: docs/IMPORT-PIPELINE.md',
    open: { view: 'safety', params: { channel: 'stable', platform: 'all', release: '9.1.0', compare: '9.0.0', days: 7 }, made: 'sticknodes/4.3' },
  },
];

export const overview = () => ({
  ...envelope('overview'),
  releases: [{ version: '9.1.0', firstDay: '2026-11-06', sessions: 1050, stored: 1050 }, { version: '9.0.0', firstDay: '2026-10-16', sessions: 98, stored: 98 }],
  verdict: VERDICT,
  promises: [
    { id: 'saves', label: 'Work is safe', measure: 'saves that succeeded', value: 0.9966, count: 6841, sessions: 1050, compare: { value: 0.9998, count: 4737, sessions: 735 }, change: -0.0032, trend: 'worse' },
    { id: 'smooth', label: 'Stays responsive', measure: 'frames that were smooth', value: 0.9713, count: 829104, sessions: 1050, compare: { value: 0.9799, count: 585866, sessions: 735 }, change: -0.0086, trend: 'worse' },
    { id: 'opens', label: 'Old files open', measure: 'files that opened', value: 0.9734, count: 301, sessions: 1050, compare: { value: 0.9741, count: 270, sessions: 735 }, change: -0.0007, trend: 'same' },
    { id: 'clean', label: "Doesn't crash", measure: 'sessions that ended normally', value: 0.9705, count: 1050, sessions: 1050, compare: { value: 0.9684, count: 735, sessions: 735 }, change: 0.0021, trend: 'better' },
  ],
  findings: FINDINGS,
  notShown: 3,
  endedNormally: { release: [{ age: 0, day: '2026-11-06', sessions: 150, clean: 148, share: 0.9867 }], compare: [{ age: 0, day: '2026-10-16', sessions: 105, clean: 102, share: 0.9714 }] },
  installs: { thisWeek: { from: '2026-11-09', to: '2026-11-12', active: 274, new: 63 }, lastWeek: { from: '2026-11-02', to: '2026-11-08', active: 382, new: 87 }, cameBack: { from: '2026-11-06', to: '2026-11-12', cameBack: 67, newFrom: '2026-10-30', newTo: '2026-11-05', newBefore: 66, share: 1 }, sampled: true },
});

export const findings = () => ({ ...envelope('findings'), verdict: VERDICT, findings: FINDINGS, notShown: 3 });

/** The performance runner's workload nearest each scene size, as the site names it in a command. */
const WORKLOADS = ['small', 'medium', 'large', 'stress', 'stress'];
const SCENES = [['under-1k', 'under 1,000 segments'], ['1k-10k', '1,000 to 10,000 segments'], ['10k-50k', '10,000 to 50,000 segments'], ['50k-200k', '50,000 to 200,000 segments'], ['over-200k', 'over 200,000 segments']];
const MACHINES = [['integrated-small', 'Integrated graphics, under 16 GB'], ['integrated-large', 'Integrated graphics, 16 GB or more'], ['discrete', 'Separate graphics card']];

export const responsiveness = () => {
  const grid = [];
  SCENES.forEach(([scene], si) => MACHINES.forEach(([machine], mi) => {
    if (scene === '50k-200k' && machine === 'integrated-small') {
      grid.push({ scene, machine, sessions: 57, frames: 42541, late: 12167, smooth: 0.714, p50: 17, p95: 100, worst: 420,
        stages: [{ stage: 'evaluate', label: 'evaluating the frame', ms: 375437, share: 0.44 }, { stage: 'geometry', label: 'building geometry', ms: 196250, share: 0.23 }, { stage: 'draw', label: 'drawing', ms: 110000, share: 0.13 }],
        compare: { sessions: 29, frames: 24145, late: 2969, smooth: 0.877, p50: 12, p95: 83, worst: 420 }, change: -0.163,
        command: 'npm run perf -- run --scenario pose.drag-joint --workload stress' });
    } else if (scene === 'over-200k' || (scene === '50k-200k' && machine !== 'discrete')) {
      grid.push({ scene, machine, sessions: 18 - mi, tooFew: true });
    } else {
      const smooth = Number((0.995 - si * 0.012 - mi * 0.001).toFixed(4));
      grid.push({ scene, machine, sessions: 140 - si * 20 + mi * 10, frames: 90000 - si * 10000, late: Math.round((90000 - si * 10000) * (1 - smooth)), smooth,
        p50: 8, p95: 21 + si * 4, worst: 120, stages: [{ stage: 'draw', label: 'drawing', ms: 2000 + si * 100, share: 0.5 }],
        compare: si === 3 ? { sessions: 12, tooFew: true } : { sessions: 90, frames: 60000, late: 900, smooth: Number((smooth + 0.002).toFixed(4)), p50: 8, p95: 21, worst: 110 },
        change: si === 3 ? null : -0.002, command: `npm run perf -- run --scenario pose.drag-joint --workload ${WORKLOADS[si]}` });
    }
  }));
  return {
    ...envelope('responsiveness'),
    filters: { channel: 'stable', platform: 'all', release: '9.1.0', compare: '9.0.0', doing: 'drag' },
    doing: 'drag',
    doings: [
      { id: 'drag', label: 'Dragging', scenario: 'drag', frames: 829104, smooth: 0.9713, compare: { frames: 585866, smooth: 0.9799 } },
      { id: 'play', label: 'Playing', scenario: 'play', frames: 912000, smooth: 0.9902, compare: { frames: 600000, smooth: 0.9911 } },
      { id: 'scrub', label: 'Scrubbing', scenario: 'scrub', frames: 120000, smooth: 0.958, compare: null },
      { id: 'view', label: 'Moving the view', scenario: 'pan-zoom', frames: 300000, smooth: 0.9944, compare: null },
      { id: 'draw', label: 'Drawing', scenario: null, frames: 900, smooth: null, compare: null },
    ],
    axes: { scenes: SCENES.map(([id, label]) => ({ id, label })), machines: MACHINES.map(([id, label]) => ({ id, label })) },
    profile: { scenario: 'pose.drag-joint', command: 'npm run perf -- run --scenario pose.drag-joint --workload <workload of this size>' },
    total: { frames: 829104, late: 23774, smooth: 0.9713, compare: { frames: 585866, late: 11791, smooth: 0.9799 } },
    grid,
    slowest: [{ ms: 420, day: '2026-11-06', scene: '50k-200k', machine: 'integrated-small', stages: [{ stage: 'evaluate', label: 'evaluating the frame', ms: 2891.7, share: 0.44 }] }],
  };
};

export const safety = () => ({
  ...envelope('safety'),
  saves: { total: 6841, ok: 6818, failed: 23, cancelled: 97, sessions: 1050,
    ops: [{ op: 'save', ok: 3575, failed: 23, cancelled: 97, sessions: 1050 }, { op: 'autosave', ok: 3243, failed: 0, cancelled: 0, sessions: 1050 }],
    reasons: [{ reason: 'no-permission', n: 9, untouched: 9, unknown: 0 }, { reason: 'disk-full', n: 6, untouched: 6, unknown: 0 }],
    compare: { total: 4737, failed: 1, sessions: 735 } },
  recovery: { unsaved: 10, offered: 7, restored: 6, failed: 1, reasons: [{ reason: 'damaged', n: 1 }], compare: { unsaved: 7, offered: 6, restored: 6, failed: 0 } },
  opens: [
    { format: 'styk', made: 'stykanimate/1', label: 'StykAnimate, version 1', attempts: 210, ok: 210, failed: 0, cancelled: 0, sessions: 160, failureRate: 0, reason: null, stage: null },
    { format: 'sticknodes', made: 'sticknodes/4.3', label: 'Stick Nodes, version 4.3', attempts: 42, ok: 34, failed: 8, cancelled: 0, sessions: 42, failureRate: 0.1905, reason: 'unsupported-version', stage: 'decode' },
    { format: 'picture', made: null, label: null, sessions: 6, tooFew: true },
  ],
  exports: [{ format: 'video', attempts: 111, ok: 109, failed: 2, cancelled: 0, sessions: 111, failureRate: 0.018, reason: 'out-of-memory', stage: 'encode' }],
});

const PROBLEM = { sig: 'a786ede6755b92d1', title: 'index out of bounds: the len is # but the index is #', type: 'engine', key: null };
export const problems = () => ({
  ...envelope('problems'),
  groups: 2,
  problems: [
    { ...PROBLEM, where: 'encode_strokes styk-eval/src/drawlist.rs', sessions: 28, times: 28, share: 0.0267, recovered: 0, recoveredShare: 0,
      firstSeen: { release: '9.1.0', day: '2026-11-06', thisRelease: true }, series: [{ day: '2026-10-30', sessions: 0 }, { day: '2026-11-12', sessions: 7 }] },
    { sig: '0c3b5e2f9a1d4e77', title: 'Cannot read properties of undefined (reading \'#\')', type: 'error', key: null, where: 'renderTimeline src/timeline.mjs',
      sessions: 9, times: 14, share: null, recovered: 9, recoveredShare: 1, firstSeen: { release: '9.0.0', day: '2026-10-18', thisRelease: false }, series: [] },
  ],
});

export const problem = () => ({
  ...envelope('problems/a786ede6755b92d1'),
  problem: { ...PROBLEM, sessions: 28, times: 28, recovered: 0, share: 0.0267, firstSeen: { release: '9.1.0', day: '2026-11-06', thisRelease: true } },
  reports: { sessions: 28, sampled: false },
  message: 'index out of bounds: the len is 0 but the index is 0',
  stack: ['encode_strokes styk-eval/src/drawlist.rs:412', 'evaluate styk-eval/src/frame.rs:233', 'export_frame styk-engine/src/jobs.rs:118'],
  trails: [{ commands: ['file.open', 'onion.toggle', 'timeline.play', 'export.video'], sessions: 28 }],
  recovered: 0,
  shared: { sessions: 28, shared: [{ dimension: 'activity', value: 'exporting', sessions: 28, of: 28, text: '28 of 28' }, { dimension: 'features', value: 'onion', sessions: 28, of: 28, text: '28 of 28' }], varied: ['scene', 'machine', 'platform'] },
  brief: BRIEF_E,
});

export const usage = () => ({
  ...envelope('usage'),
  firstSession: { sessions: 94, steps: [{ step: 'opened', sessions: 94, share: 1 }, { step: 'edit', sessions: 77, share: 0.8191 }, { step: 'play', sessions: 61, share: 0.6489 }, { step: 'save', sessions: 18, tooFew: true }] },
  features: [{ name: 'onion', sessions: 637, share: 0.6067 }, { name: 'library', sessions: 402, share: 0.3829 }],
  project: { scene: [{ name: 'under-1k', sessions: 370, share: 0.3524 }, { name: '1k-10k', sessions: 420, share: 0.4 }], figures: [], frames: [], rate: [] },
  formats: [{ name: 'styk', attempts: 308, sessions: 308, share: 0.5229 }],
  sources: [{ name: 'stykanimate', label: 'StykAnimate', attempts: 308, sessions: 308, share: 0.5229 }],
  modes: { simple: { minutes: 34507, share: 0.674 }, advanced: { minutes: 16688, share: 0.326 } },
  languages: [{ name: 'tr', sessions: 24, share: 0.0229 }, { name: 'ja', sessions: 18, tooFew: true }],
  platforms: [{ name: 'win32', sessions: 850, share: 0.8095 }, { name: 'linux', sessions: 200, share: 0.1905 }],
  machines: { class: [{ name: 'integrated-small', sessions: 404, share: 0.3848 }], memory: [{ name: '4', sessions: 93, share: 0.0886 }] },
  commands: { top: [{ command: 'frame.duplicate', runs: 21802, sessions: 1050, perSession: 20.8 }], notShown: 0 },
});

export const curiosities = () => ({
  ...envelope('curiosities'),
  filters: { channel: 'stable', platform: 'all', release: 'all', compare: 'none' },
  release: { version: 'all' },
  compare: null,
  sample: { percent: 25, sampled: true, effective: 0.25 },
  items: [
    { id: 'hours', value: 853.3, text: '853', label: 'hours spent animating', comparison: 'that is 36 days of animating' },
    { id: 'longest', value: 474, text: '7 hours 54 minutes', label: 'the longest session' },
    { id: 'busiestDay', value: 'Saturday', text: 'Saturday', label: 'the busiest day for animating' },
  ],
  when: { table: [], byWeekday: [], sessions: 1050 },
  age: [{ name: 'day', sessions: 94, share: 0.0895 }],
  largestProject: { scene: 'over-200k', figures: 'over-100', frames: 'over-5k' },
  sources: [], exports: [], languages: [],
});

/** Every view by the path the reader asks for. */
export const VIEWS = {
  overview, findings, responsiveness, safety, problems, usage, curiosities,
  'problems/a786ede6755b92d1': problem,
};
