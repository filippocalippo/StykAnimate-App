// npm run stats (scripts/stats.mjs): the command-line reader of the website's statistics views, against a
// local server that serves the views as the website's README gives them (tests/support/stats-views.mjs).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatCuriosities, formatFinding, formatFindings, formatProblem, formatProblems, formatRelease, formatResponsiveness,
  formatSafety, formatUsage, parseArgs, percent, run, siteOrigin, UsageError,
} from '../scripts/stats.mjs';
import { FINDINGS, VIEWS, findings, overview, problem, problems, responsiveness, safety, usage, curiosities } from './support/stats-views.mjs';

const KEY = 'k3Y-for-the-tests_0123456789abcdefghijklmnopqrst';
const LOCKED_KEY = 'locked-key-0123456789abcdefghijklmnopqrstuvwxyz';
const REDIRECT_KEY = 'redirect-key-0123456789abcdefghijklmnopqrstuvwx';
const script = fileURLToPath(new URL('../scripts/stats.mjs', import.meta.url));

const requests = [];
const everything = [];
let server;
let site;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers });
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const auth = request.headers.authorization;
    if (auth === `Bearer ${LOCKED_KEY}`) return send(429, { error: 'key_locked' });
    if (auth === `Bearer ${REDIRECT_KEY}`) return send(302, '', { location: 'https://elsewhere.example/api/v1/admin/stats/overview' });
    if (auth !== `Bearer ${KEY}`) return send(401, { error: 'unauthorized' });
    const view = url.pathname.replace('/api/v1/admin/stats/', '');
    for (const field of ['release', 'compare']) {
      const value = url.searchParams.get(field);
      if (value && !['9.1.0', '9.0.0', 'all', 'none'].includes(value)) return send(404, { error: 'unknown_release', field });
    }
    if (!VIEWS[view]) return send(404, { error: 'not_found' });
    return send(200, VIEWS[view]());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  // The key is never printed, in any output or error of any test.
  for (const text of everything) {
    for (const key of [KEY, LOCKED_KEY, REDIRECT_KEY]) assert.ok(!text.includes(key), `the key appeared in: ${text.slice(0, 200)}`);
  }
});

async function stats(argv, env = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    env: { STYK_STATS_KEY: KEY, STYK_STATS_URL: site, ...env },
    out: text => { out += text; },
    err: text => { err += text; },
  });
  everything.push(out, err);
  return { code, out: out.replace(/\n$/, ''), err: err.replace(/\n$/, '') };
}

const FOOTER = [
  'Numbers to 2026-11-12 23:30 UTC · last 7 days (2026-11-06 to 2026-11-12) · stable channel, all platforms',
  "9.0.0's totals are estimated from a sample.",
];

describe('the text of each command', () => {
  test('release: the promises, what needs attention, and what to run next', async () => {
    const expected = [
      'StykAnimate 9.1.0 · 6 days out · 1,050 sessions · compared with 9.0.0',
      '9.1.0 needs attention: a new engine stop reached 28 sessions, and 5 more things to look at.',
      '',
      '  Work is safe       99.7%    -0.3',
      '  Stays responsive   97.1%    -0.9   dragging, 50,000-200,000 segments, integrated graphics under 16 GB',
      '  Old files open     97.3%    same   8 of 42 opens of Stick Nodes 4.3 files failed',
      "  Doesn't crash      97.0%    +0.2   28 sessions hit an engine stop (new)",
      '',
      'Needs attention',
      '  E-a786  The engine stops: index out of bounds: the len is # but the i…  critical, new in 9.1.0',
      '  R-ff75  Dragging stutters in scenes of 50,000 to 200,000 segments on…   worse than 9.0.0',
      '  F-5a1c  Stick Nodes 4.3 files fail to open                              since 9.1.0',
      '  and 3 more not shown (the views give the three that reach most sessions)',
      '',
      ...FOOTER,
      'Next: npm run stats -- show E-a786        (add --json for the numbers alone)',
    ].join('\n');
    assert.equal(formatRelease(overview()), expected);
    const read = await stats([]);
    assert.equal(read.code, 0);
    assert.equal(read.out, expected);
    const last = requests.at(-1);
    assert.equal(last.path, '/api/v1/admin/stats/overview');
    assert.equal(last.method, 'GET');
    assert.equal(last.headers.authorization, `Bearer ${KEY}`);
    assert.equal(last.headers.accept, 'application/json');
  });

  test('release with a version and options sends them as the view parameters, and the next command keeps them', async () => {
    const read = await stats(['release', '9.1.0', '--compare', '9.0.0', '--days=30', '--platform', 'win32', '--channel', 'stable', '--fresh']);
    assert.equal(read.code, 0);
    assert.deepEqual(requests.at(-1).query, { release: '9.1.0', compare: '9.0.0', days: '30', platform: 'win32', channel: 'stable', fresh: '1' });
    assert.match(read.out.split('\n').at(-1), /^Next: npm run stats -- show E-a786 --release 9\.1\.0 --compare 9\.0\.0 --days 30 --platform win32 {8}/);
  });

  test('a promise with too few sessions, no release, a sampled period and no rollup yet', () => {
    const view = overview();
    view.promises[0] = { ...view.promises[0], value: null, tooFew: true, sessions: 12, change: null, trend: null };
    view.sample = { percent: 25, sampled: true, effective: 0.25 };
    view.rolledUpTo = null;
    view.compare = null;
    view.findings = [];
    view.notShown = 0;
    const text = formatRelease(view);
    assert.match(text, /^StykAnimate 9\.1\.0 · 6 days out · 1,050 sessions · nothing compared$/m);
    assert.match(text, /^ {2}Work is safe {7}too few \(12\)$/m);
    assert.match(text, /^Needs attention\n {2}nothing$/m);
    assert.match(text, /^No rollup has run yet, so there are no numbers · /m);
    assert.match(text, /^Sampled: totals are estimated from a 25% share of the sessions/m);
    assert.match(text, /^Next: npm run stats -- responsiveness/m);
    assert.equal(formatRelease({ ...view, release: null, verdict: 'No sessions on this channel in this period yet.' }).split('\n')[0],
      'No sessions on this channel in this period yet.');
  });

  test('findings: each finding with its id, title and evidence line', async () => {
    const expected = [
      'Findings · 9.1.0 · compared with 9.0.0',
      '9.1.0 needs attention: a new engine stop reached 28 sessions, and 5 more things to look at.',
      '',
      'E-a786  critical  problem  28 sessions',
      '  The engine stops: index out of bounds: the len is # but the index is #',
      '  New in 9.1.0 · 28 sessions · encode_strokes styk-eval/src/drawlist.rs',
      '',
      'R-ff75  warning  responsiveness  57 sessions',
      '  Dragging stutters in scenes of 50,000 to 200,000 segments on integrated graphics with less than 16 GB of memory',
      '  Worse than 9.0.0 · 57 sessions · smooth frames fell from 88% to 71%',
      '',
      'F-5a1c  warning  files  42 sessions',
      '  Stick Nodes 4.3 files fail to open',
      '  Since 9.1.0 · 8 of 42 opens failed · a version the reader does not know',
      '',
      'And 3 more not shown: the views give the three that reach most sessions.',
      '',
      ...FOOTER,
      'Next: npm run stats -- show E-a786',
    ].join('\n');
    assert.equal(formatFindings(findings()), expected);
    const read = await stats(['findings']);
    assert.equal(read.code, 0);
    assert.equal(read.out, expected);
  });

  test('show: one finding whole, with its evidence, its brief and the command that opens it', async () => {
    const expected = [
      'R-ff75 · warning · responsiveness · 57 sessions · release 9.1.0',
      'Dragging stutters in scenes of 50,000 to 200,000 segments on integrated graphics with less than 16 GB of memory',
      'Worse than 9.0.0 · 57 sessions · smooth frames fell from 88% to 71%',
      '',
      'Evidence',
      '  doing drag · scene 50k-200k · machine integrated-small · sessions 57 · frames 42,541',
      '  smooth 71.4% · p50 17 ms · p95 100 ms · worst 420 ms',
      '  compare: sessions 29 · frames 24,145 · smooth 87.7% · p50 12 ms · p95 83 ms · worst 420 ms',
      '',
      'Brief for an agent',
      FINDINGS[1].brief,
      '',
      'Open: npm run stats -- responsiveness drag --release 9.1.0 --compare 9.0.0',
      ...FOOTER,
    ].join('\n');
    assert.equal(formatFinding(FINDINGS[1], findings()), expected);
    const read = await stats(['show', 'r-ff75']);
    assert.equal(read.code, 0);
    assert.equal(read.out, expected);
    assert.equal(requests.at(-1).path, '/api/v1/admin/stats/findings');

    const files = formatFinding(FINDINGS[2], findings());
    assert.match(files, /^ {2}reasons: stage decode a version the reader does not know 8$/m);
    assert.match(files, /^Open: npm run stats -- safety --release 9\.1\.0 --compare 9\.0\.0$/m);
  });

  test('show of a problem finding beyond the three shown opens its problem group', async () => {
    const read = await stats(['show', 'E-a786']);
    assert.equal(read.code, 0);
    assert.match(read.out, /^E-a786 · critical · problem/);
    const beyond = await stats(['show', 'E-0c3b']);
    assert.equal(beyond.code, 1, beyond.err);
    assert.match(beyond.err, /^No problem group 0c3b5e2f9a1d4e77 in this release and period/);
    assert.deepEqual(requests.slice(-3).map(r => r.path), ['/api/v1/admin/stats/findings', '/api/v1/admin/stats/problems', '/api/v1/admin/stats/problems/0c3b5e2f9a1d4e77']);
    const unknown = await stats(['show', 'R-0000']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /^No finding R-0000 among those of 9\.1\.0 shown now: E-a786, R-ff75, F-5a1c\./);
  });

  test('responsiveness: the grid as a table, the totals, the worst cells and the command that reproduces it', async () => {
    const expected = [
      'Dragging · 9.1.0 · compared with 9.0.0',
      'Smooth share of frames (sessions), change in points against 9.0.0',
      '',
      '                              Integrated <16 GB   Integrated 16 GB+   Graphics card',
      '  under 1,000 segments        99.5% (140) -0.2    99.4% (150) -0.2    99.3% (160) -0.2',
      '  1,000 to 10,000 segments    98.3% (120) -0.2    98.2% (130) -0.2    98.1% (140) -0.2',
      '  10,000 to 50,000 segments   97.1% (100) -0.2    97.0% (110) -0.2    96.9% (120) -0.2',
      '  50,000 to 200,000 segments  71.4% (57) -16.3    too few (17)        95.7% (100)',
      '  over 200,000 segments       too few (18)        too few (17)        too few (16)',
      '',
      'All cells: 97.1% smooth of 829,104 frames, 23,774 late (9.0.0: 98.0% of 585,866)',
      'Other interactions: Playing 99.0% · Scrubbing 95.8% · Moving the view 99.4% · Drawing too few',
      '',
      "Worst cells, and where their late frames' time went",
      '  50,000-200,000 segments, integrated graphics under 16 GB: 71.4% (9.0.0: 87.7%), p50 17 ms, p95 100 ms, worst 420 ms',
      '    evaluating the frame 44% · building geometry 23% · drawing 13%',
      '  50,000-200,000 segments, graphics card: 95.7%, p50 8 ms, p95 33 ms, worst 120 ms',
      '    drawing 50%',
      '  10,000-50,000 segments, graphics card: 96.9% (9.0.0: 97.1%), p50 8 ms, p95 29 ms, worst 120 ms',
      '    drawing 50%',
      '',
      'Reproduce: node scripts/styk-profile.mjs <file of 50,000 to 200,000 segments> drag --desktop',
      ...FOOTER,
    ].join('\n');
    assert.equal(formatResponsiveness(responsiveness()), expected);
    const read = await stats(['responsiveness', 'play']);
    assert.equal(read.code, 0);
    assert.equal(requests.at(-1).query.doing, 'play');
    const drawing = responsiveness();
    drawing.doing = 'draw';
    drawing.profile = null;
    drawing.grid = drawing.grid.map(c => ({ scene: c.scene, machine: c.machine, sessions: 3, tooFew: true }));
    const text = formatResponsiveness(drawing);
    assert.match(text, /^Every cell has too few sessions to show \(20 needed\)\.$/m);
    assert.match(text, /^Reproduce: no profiling scenario covers drawing; /m);
  });

  test('safety: saves, recovery, opens and exports with their reasons', async () => {
    const expected = [
      'Safety · 9.1.0 · compared with 9.0.0',
      '',
      'Saves     6,818 of 6,841 succeeded (99.7%), 23 failed, 97 cancelled, in 1,050 sessions',
      '          9.0.0: 1 of 4,737 failed',
      '          save 3,575 ok, 23 failed · autosave 3,243 ok, 0 failed',
      '  Why:    no permission to write 9 (file left as it was: 9) · disk full 6 (file left as it was: 6)',
      'Recovery  10 ended badly with unsaved work · 7 offered · 6 restored · 1 could not be read (damaged file 1)',
      '          9.0.0: 7 · 6 · 6 · 0',
      '',
      'Opens, most opened first',
      '  StykAnimate, version 1             210 tries      0 failed (0.0%)',
      '  Stick Nodes, version 4.3            42 tries      8 failed (19.1%)  a version the reader does not know, at decode',
      '  picture                        too few (6)',
      '',
      'Exports',
      '  video                              111 tries      2 failed (1.8%)  out of memory, at encode',
      '',
      ...FOOTER,
    ].join('\n');
    assert.equal(formatSafety(safety()), expected);
    assert.equal((await stats(['safety'])).out, expected);
  });

  test('problems and problem: the groups, then one with its stack, trails, what the sessions share and the brief', async () => {
    assert.equal(formatProblems(problems()), [
      'Problems · 9.1.0 · 2 groups',
      '',
      '  a786ede6755b92d1  engine         28 sessions (2.7%)     new in 9.1.0',
      '    index out of bounds: the len is # but the index is # — encode_strokes styk-eval/src/drawlist.rs',
      '  0c3b5e2f9a1d4e77  error          9 sessions             since 9.0.0',
      "    Cannot read properties of undefined (reading '#') — renderTimeline src/timeline.mjs",
      '',
      ...FOOTER,
      'Next: npm run stats -- problem a786ede6755b92d1',
    ].join('\n'));
    const expected = [
      'Problem a786ede6755b92d1 · engine · release 9.1.0',
      'index out of bounds: the len is # but the index is #',
      '28 sessions (2.7%), 28 times, none recovered · first seen in 9.1.0 on 2026-11-06 (new in this release)',
      '',
      'Message: index out of bounds: the len is 0 but the index is 0',
      'Stack',
      '  encode_strokes styk-eval/src/drawlist.rs:412',
      '  evaluate styk-eval/src/frame.rs:233',
      '  export_frame styk-engine/src/jobs.rs:118',
      'Trails (the last commands, oldest first)',
      '  28 sessions: file.open, onion.toggle, timeline.play, export.video',
      'What the sessions share',
      '  activity exporting 28 of 28 · features onion 28 of 28',
      '  varied: scene, machine, platform',
      '',
      'Brief for an agent',
      problem().brief,
      '',
      ...FOOTER,
    ].join('\n');
    assert.equal(formatProblem(problem()), expected);
    // A start of the signature is enough: the reader finds the group in the problems view.
    const read = await stats(['problem', 'a786']);
    assert.equal(read.code, 0);
    assert.equal(read.out, expected);
    assert.equal(requests.at(-1).path, '/api/v1/admin/stats/problems/a786ede6755b92d1');
    const few = formatProblem({ ...problem(), shared: null, tooFew: true });
    assert.match(few, /^ {2}too few sessions to say \(20 needed\)$/m);
  });

  test('usage and curiosities', async () => {
    assert.equal(formatUsage(usage()), [
      'Usage · 9.1.0 · 1,050 sessions',
      '',
      'First sessions    94 of them · opened 100.0% · edit 81.9% · play 64.9% · save too few',
      'Features          onion 60.7% · library 38.3%',
      'Scenes            under 1,000 segments 35.2% · 1,000-10,000 segments 40.0%',
      'Files opened from StykAnimate 52.3%',
      'Formats opened    styk 52.3%',
      'Timeline          simple 67.4% of minutes · advanced 32.6%',
      'Platforms         win32 81.0% · linux 19.1%',
      'Machines          integrated graphics under 16 GB 38.5%',
      'Memory            4 GB 8.9%',
      'Languages         tr 2.3% · ja too few',
      'Most run          frame.duplicate 20.8 a session',
      '',
      ...FOOTER,
    ].join('\n'));
    assert.equal(formatCuriosities(curiosities()), [
      'Curiosities · every release · 1,050 sessions',
      '',
      '  853 hours spent animating (that is 36 days of animating)',
      '  7 hours 54 minutes the longest session',
      '  Saturday the busiest day for animating',
      '',
      'Largest project seen: over 200,000 segments, over 100 figures, over 5,000 frames',
      '',
      'Numbers to 2026-11-12 23:30 UTC · last 7 days (2026-11-06 to 2026-11-12) · stable channel, all platforms',
      'Sampled: totals are estimated from a 25% share of the sessions (shares are of what was stored).',
    ].join('\n'));
    assert.equal((await stats(['usage', '--release', 'all'])).code, 0);
    assert.equal(requests.at(-1).query.release, 'all');
    assert.equal((await stats(['curiosities'])).code, 0);
  });

  test('every text is short enough to read in full', () => {
    for (const text of [formatRelease(overview()), formatFindings(findings()), formatFinding(FINDINGS[0], findings()), formatResponsiveness(responsiveness()),
      formatSafety(safety()), formatProblems(problems()), formatProblem(problem()), formatUsage(usage()), formatCuriosities(curiosities())]) {
      assert.ok(text.split('\n').length <= 40, text);
    }
  });

  test('percentages keep one decimal, and never round a share below 100% up to it', () => {
    assert.equal(percent(0.7104), '71.0%');
    assert.equal(percent(0.9996), '99.96%');
    assert.equal(percent(1), '100.0%');
    assert.equal(percent(null), 'n/a');
  });
});

describe('--json', () => {
  test('prints the view unchanged', async () => {
    const read = await stats(['safety', '--json']);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.out), safety());
    const show = await stats(['show', 'F-5a1c', '--json']);
    assert.deepEqual(JSON.parse(show.out), FINDINGS[2]);
  });
});

describe('refusals', () => {
  test('no key: which variable, why it is kept outside the repository, and how the owner sets it; nothing is sent', async () => {
    const before = requests.length;
    const read = await stats([], { STYK_STATS_KEY: '' });
    assert.equal(read.code, 2);
    assert.match(read.err, /STYK_STATS_KEY is not set/);
    assert.match(read.err, /the repository is public/);
    assert.match(read.err, /npx wrangler secret put STATS_READ_KEY/);
    assert.equal(requests.length, before);
  });

  test('a refused key (401) and a locked address (429)', async () => {
    const wrong = await stats([], { STYK_STATS_KEY: `${KEY}x` });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /^The site refused the key \(401\)/);
    const locked = await stats([], { STYK_STATS_KEY: LOCKED_KEY });
    assert.equal(locked.code, 1);
    assert.match(locked.err, /^Locked \(429\).*Try again/);
  });

  test('an unknown release lists the releases the channel reported', async () => {
    const read = await stats(['release', '8.8.8']);
    assert.equal(read.code, 1);
    assert.equal(read.err, '8.8.8 is not a release the stable channel reported (--release).\n'
      + 'The stable channel reported: 9.1.0 (1,050 sessions in the period), 9.0.0 (98 sessions in the period).');
    const compare = await stats(['--compare', '7.0.0']);
    assert.match(compare.err, /^7\.0\.0 is not a release the stable channel reported \(--compare\)\./);
  });

  test('a redirect is not followed, so the key reaches no other host', async () => {
    const before = requests.length;
    const read = await stats([], { STYK_STATS_KEY: REDIRECT_KEY });
    assert.equal(read.code, 1);
    assert.match(read.err, /answered with a redirect to https:\/\/elsewhere\.example\/.* \(302\)\. The reader follows none/);
    assert.equal(requests.length, before + 1);
  });

  test('the site unreachable', async () => {
    const closed = createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise(resolve => closed.close(resolve));
    const read = await stats([], { STYK_STATS_URL: `http://127.0.0.1:${port}` });
    assert.equal(read.code, 1);
    assert.match(read.err, new RegExp(`^Could not reach http://127\\.0\\.0\\.1:${port}`));
  });

  test('a wrong command line exits with 2', async () => {
    for (const argv of [['nonsense'], ['--days', '14'], ['--platform', 'amiga'], ['--channel', 'nightly'], ['responsiveness', 'juggle'],
      ['show'], ['problem'], ['safety', 'extra'], ['--wat'], ['--release'], ['problem', 'xyz!']]) {
      const before = requests.length;
      const read = await stats(argv);
      assert.equal(read.code, 2, argv.join(' '));
      assert.match(read.err, /npm run stats -- help/);
      assert.equal(requests.length, before, argv.join(' '));
    }
    assert.throws(() => parseArgs(['--json=1']), UsageError);
    assert.deepEqual(parseArgs(['responsiveness', 'view', '--json']), { command: 'responsiveness', arg: 'view', params: { doing: 'view' }, json: true });
  });

  test('http: only for localhost and 127.0.0.1, and the site is an origin alone', () => {
    assert.equal(siteOrigin(undefined), 'https://stykanimate.com');
    assert.equal(siteOrigin('https://stykanimate.com/'), 'https://stykanimate.com');
    assert.equal(siteOrigin('http://localhost:8787'), 'http://localhost:8787');
    assert.equal(siteOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    for (const bad of ['http://stykanimate.com', 'http://192.168.1.4:8787', 'ftp://stykanimate.com', 'https://user:pass@stykanimate.com',
      'https://stykanimate.com/api', 'not an address']) {
      assert.throws(() => siteOrigin(bad), UsageError, bad);
    }
  });

  test('help needs no key', async () => {
    const read = await stats(['help'], { STYK_STATS_KEY: '' });
    assert.equal(read.code, 0);
    assert.match(read.out, /^npm run stats -- \[command\] \[options\]/);
  });
});

describe('the script', () => {
  test('runs from the command line with its exit codes, and keeps the key out of its output', () => {
    const env = { ...process.env, STYK_STATS_KEY: KEY, STYK_STATS_URL: 'http://stykanimate.com' };
    const insecure = spawnSync(process.execPath, [script, 'release'], { env, encoding: 'utf8', windowsHide: true });
    everything.push(insecure.stdout, insecure.stderr);
    assert.equal(insecure.status, 2);
    assert.match(insecure.stderr, /accepted only for localhost and 127\.0\.0\.1/);
    const help = spawnSync(process.execPath, [script, '--help'], { env: { ...process.env, STYK_STATS_KEY: '' }, encoding: 'utf8', windowsHide: true });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /STYK_STATS_KEY/);
  });
});
