#!/usr/bin/env node
// npm run stats: the command-line reader of the app's statistics (docs/STATISTICS.md, "Reading the statistics").
//
// It asks the website's report views (GET <site>/api/v1/admin/stats/<view>) with a read-only key and prints
// them as short text, or unchanged with --json. The key comes from STYK_STATS_KEY and goes to the one origin
// of STYK_STATS_URL only: no redirect is followed, and the key is never printed or written anywhere.
//
// The formatting functions take a view's JSON and return text, so the tests check them without a network.

import { pathToFileURL } from 'node:url';
import { CHANNELS, DOING, PLATFORMS } from '../src/stats/schema.mjs';

export const DEFAULT_SITE = 'https://stykanimate.com';
const TIMEOUT_MS = 30_000;
const DAYS = ['7', '30', '90'];
const COMMANDS = ['release', 'findings', 'show', 'responsiveness', 'safety', 'problems', 'problem', 'usage', 'curiosities', 'help'];

// ------------------------------------------------------------------------------------------------- words
// The views give most labels themselves; these are the few short words the text layout needs beside them.

const SCENE_SHORT = {
  'under-1k': 'under 1,000 segments', '1k-10k': '1,000-10,000 segments', '10k-50k': '10,000-50,000 segments',
  '50k-200k': '50,000-200,000 segments', 'over-200k': 'over 200,000 segments',
};
const MACHINE_SHORT = {
  'integrated-small': 'integrated graphics under 16 GB', 'integrated-large': 'integrated graphics 16 GB+', discrete: 'graphics card',
};
const MACHINE_COLUMN = { 'integrated-small': 'Integrated <16 GB', 'integrated-large': 'Integrated 16 GB+', discrete: 'Graphics card' };
const DOING_VERB = { drag: 'dragging', play: 'playing', scrub: 'scrubbing', view: 'moving the view', draw: 'drawing' };
const PROBLEM_SHORT = {
  error: 'an error', engine: 'an engine stop', frozen: 'a freeze', 'graphics-lost': 'a lost graphics device',
  'window-gone': 'a lost window', 'worker-stopped': 'a stopped background worker',
};
const REASON_WORDS = {
  'disk-full': 'disk full', 'no-permission': 'no permission to write', 'file-in-use': 'file in use by another program',
  'path-gone': 'folder or drive gone', 'too-large': 'file too large', 'not-this-format': 'not a file of this format',
  'unsupported-version': 'a version the reader does not know', 'unsupported-feature': 'a feature the reader does not know',
  damaged: 'damaged file', 'out-of-memory': 'out of memory', timeout: 'took too long', 'graphics-lost': 'graphics device lost',
  'worker-stopped': 'a background worker stopped', engine: 'an engine error', unknown: 'unknown reason',
};
const PROGRAMS = { pivot: 'Pivot', sticknodes: 'Stick Nodes', stykanimate: 'StykAnimate' };
const reasonWords = reason => REASON_WORDS[reason] || reason;
const madeShort = made => {
  if (!made) return 'unknown';
  const [program, version] = made.split('/');
  return `${PROGRAMS[program] || program}${version ? ` ${version}` : ''}`;
};

// ------------------------------------------------------------------------------------------------- numbers

/** 12345 → "12,345"; 20.8 → "20.8". */
export function count(n) {
  if (n === null || n === undefined) return 'n/a';
  const [whole, fraction] = String(Math.round(n * 10) / 10).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}
/** 0.7104 → "71.0%"; two decimals where one would round a share below 100% up to 100.0%. */
export function percent(share) {
  if (share === null || share === undefined) return 'n/a';
  const p = share * 100;
  return `${p < 100 && p >= 99.95 ? p.toFixed(2) : p.toFixed(1)}%`;
}
/** A change of two shares, in points with a sign: -0.0141 → "-1.4". */
export function signedPoints(change) {
  if (change === null || change === undefined) return '';
  const p = Math.round(change * 1000) / 10;
  return p > 0 ? `+${p.toFixed(1)}` : p < 0 ? p.toFixed(1) : '0.0';
}
/** Milliseconds: 420 → "420 ms". */
export const ms = value => (value === null || value === undefined ? 'n/a' : `${count(value)} ms`);
export const plural = (n, word, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`;
/** A range word of the contract in plain words: "over-5k" → "over 5,000", "2-5" → "2 to 5". */
const rangeWords = id => String(id).replace(/(\d+)k\b/g, (_, n) => count(Number(n) * 1000)).replace(/^(over|under)-/, '$1 ').replace(/(\d)-(\d)/, '$1 to $2');
const truncate = (text, width) => (text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`);
const lowerFirst = text => (text ? text[0].toLowerCase() + text.slice(1) : text);

/** Items joined by " · " and wrapped to lines of at most `width` characters, each starting with `indent`. */
function wrap(items, indent = '  ', width = 100) {
  const lines = [];
  let line = '';
  for (const item of items) {
    if (line && indent.length + line.length + 3 + item.length > width) { lines.push(indent + line); line = item; }
    else line = line ? `${line} · ${item}` : item;
  }
  if (line) lines.push(indent + line);
  return lines;
}

// ------------------------------------------------------------------------------------------------- shared parts

const releaseName = view => (view.release?.version === 'all' ? 'every release' : view.release?.version ?? 'no release');
const comparedWith = view => (view.compare ? `compared with ${view.compare.release}` : 'nothing compared');

/** "2026-11-12T23:30:00.412Z" → "2026-11-12 23:30 UTC". */
const utc = iso => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The closing lines every text has: how fresh the numbers are, the period, and whether totals are estimates. */
export function footer(view) {
  const lines = [];
  const filters = view.filters || {};
  const where = `${filters.channel || 'stable'} channel, ${!filters.platform || filters.platform === 'all' ? 'all platforms' : filters.platform}`;
  const period = view.period ? `last ${view.period.days} days (${view.period.from} to ${view.period.to})` : '';
  lines.push(view.rolledUpTo
    ? `Numbers to ${utc(view.rolledUpTo)} · ${period} · ${where}`
    : `No rollup has run yet, so there are no numbers · ${period} · ${where}`);
  if (view.sample?.sampled) {
    const share = view.sample.effective ? `${Math.round(view.sample.effective * 100)}%` : 'partial';
    lines.push(`Sampled: totals are estimated from a ${share} share of the sessions (shares are of what was stored).`);
  }
  if (view.compare?.sampled) lines.push(`${view.compare.release}'s totals are estimated from a sample.`);
  return lines;
}

/** The parameters of a view as flags for the next command (only those that differ from the defaults). */
function flags(params = {}) {
  const parts = [];
  if (params.release && params.release !== 'all') parts.push(`--release ${params.release}`);
  if (params.compare) parts.push(`--compare ${params.compare}`);
  if (params.days && Number(params.days) !== 7) parts.push(`--days ${params.days}`);
  if (params.platform && params.platform !== 'all') parts.push(`--platform ${params.platform}`);
  if (params.channel && params.channel !== 'stable') parts.push(`--channel ${params.channel}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const noRelease = (view, title) => [`${title} · no sessions on the ${view.filters?.channel || 'stable'} channel in this period yet`, '', ...footer(view)];

// ------------------------------------------------------------------------------------------------- release

/** The reason printed beside a promise: the first finding of the kind that moves it. */
function promiseReason(id, findings) {
  const first = kinds => findings.find(f => kinds.includes(f.kind));
  if (id === 'saves') {
    const f = first(['saving', 'recovery']);
    if (!f) return '';
    const e = f.evidence || {};
    if (f.kind === 'recovery') return `${plural(e.failed ?? 0, 'recovery copy', 'recovery copies')} could not be read`;
    const top = e.reasons?.[0];
    return `${plural(e.failed ?? 0, 'failed save')}${top ? `, ${count(top.n)} of them ${reasonWords(top.reason)}` : ''}`;
  }
  if (id === 'smooth') {
    const e = first(['responsiveness'])?.evidence;
    return e ? `${DOING_VERB[e.doing] || e.doing}, ${SCENE_SHORT[e.scene] || e.scene}, ${MACHINE_SHORT[e.machine] || e.machine}` : '';
  }
  if (id === 'opens') {
    const e = first(['files'])?.evidence;
    return e ? `${count(e.failed)} of ${count(e.opens)} opens of ${madeShort(e.made)} files failed` : '';
  }
  if (id === 'clean') {
    const e = first(['problem'])?.evidence;
    return e ? `${plural(e.sessions, 'session')} hit ${PROBLEM_SHORT[e.type] || e.type}${e.isNew ? ' (new)' : ''}` : '';
  }
  return '';
}

function promiseLine(p, findings) {
  const value = p.tooFew || p.value === null ? `too few (${count(p.sessions)})` : percent(p.value);
  const change = p.trend === 'same' ? 'same' : signedPoints(p.change);
  return `  ${p.label.padEnd(18)} ${value.padEnd(8)} ${change.padEnd(6)} ${promiseReason(p.id, findings)}`.trimEnd();
}

/** The "Needs attention" lines, shared by `release` and `findings`. */
function attentionLines(findings, notShown) {
  if (!findings.length) return ['  nothing'];
  const lines = findings.map(f => {
    // The views say a finding's status; one from an older site is the first part of its summary.
    const status = lowerFirst(f.status !== undefined ? f.status ?? '' : (f.summary || '').split(' · ')[0]);
    const mark = f.severity === 'critical' ? 'critical, ' : '';
    return `  ${f.id.padEnd(7)} ${truncate(f.title, 62).padEnd(62)}  ${mark}${status}`.trimEnd();
  });
  if (notShown) lines.push(`  and ${count(notShown)} more that reach fewer sessions (npm run stats -- findings --all)`);
  return lines;
}

/** `release`: the overview and its findings, in the layout of the dashboard's "Agents" page. */
export function formatRelease(view, { next = '' } = {}) {
  if (!view.release) return [view.verdict || 'No sessions on this channel in this period yet.', '', ...footer(view)].join('\n');
  const r = view.release;
  const age = r.age === 0 ? 'out today' : `${plural(r.age, 'day')} out`;
  const findings = view.findings || [];
  const lines = [
    `StykAnimate ${r.version} · ${age} · ${plural(view.sessions, 'session')} · ${comparedWith(view)}`,
    view.verdict,
    '',
    ...(view.promises || []).map(p => promiseLine(p, findings)),
    '',
    'Needs attention',
    ...attentionLines(findings, view.notShown),
    '',
    ...footer(view),
    findings.length
      ? `Next: npm run stats -- show ${findings[0].id}${next}        (add --json for the numbers alone)`
      : `Next: npm run stats -- responsiveness${next}        (or safety, problems, usage; add --json for the numbers alone)`,
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- findings

export function formatFindings(view, { next = '' } = {}) {
  if (!view.release) return noRelease(view, 'Findings').join('\n');
  const findings = view.findings || [];
  const lines = [`Findings · ${releaseName(view)} · ${comparedWith(view)}`, view.verdict, ''];
  for (const f of findings) {
    lines.push(`${f.id}  ${f.severity}  ${f.kind}  ${plural(f.sessions, 'session')}`, `  ${f.title}`, `  ${f.summary}`, '');
  }
  if (!findings.length) lines.push('Nothing needs attention.', '');
  if (view.notShown) lines.push(`And ${count(view.notShown)} more that reach fewer sessions: add --all to list them.`, '');
  lines.push(...footer(view));
  if (findings.length) lines.push(`Next: npm run stats -- show ${findings[0].id}${next}`);
  return lines.join('\n');
}

const SHARE_KEYS = new Set(['smooth', 'rate', 'share', 'failureRate', 'recoveredShare']);
const MS_KEYS = new Set(['p50', 'p95', 'worst', 'ms']);
function evidenceValue(key, value) {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'number') return String(value);
  if (SHARE_KEYS.has(key)) return percent(value);
  if (MS_KEYS.has(key)) return ms(value);
  return count(value);
}
/** A finding's evidence: its plain numbers on wrapped lines, then one line per nested object or list. */
function evidenceLines(evidence = {}) {
  const plain = [];
  const nested = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (Array.isArray(value)) {
      const items = value.map(v => (v && typeof v === 'object'
        ? Object.entries(v).map(([k, x]) => (k === 'reason' ? reasonWords(x) : k === 'n' ? count(x) : `${k} ${evidenceValue(k, x)}`)).join(' ')
        : String(v)));
      nested.push(...wrap(items.length ? items : ['none'], '  ').map((line, i) => (i ? `  ${line}` : `  ${key}: ${line.trimStart()}`)));
    } else if (value && typeof value === 'object') {
      const items = Object.entries(value).map(([k, x]) => `${k} ${evidenceValue(k, x)}`);
      nested.push(...wrap(items, '  ').map((line, i) => (i ? `  ${line}` : `  ${key}: ${line.trimStart()}`)));
    } else {
      plain.push(`${key} ${evidenceValue(key, value)}`);
    }
  }
  return [...wrap(plain, '  '), ...nested];
}

/** The command that opens a finding's view. */
function openCommand(open) {
  if (!open) return null;
  const params = open.params || {};
  if (open.view.startsWith('problems/')) return `npm run stats -- problem ${open.view.slice('problems/'.length)}${flags(params)}`;
  if (open.view === 'responsiveness') return `npm run stats -- responsiveness ${params.doing || 'drag'}${flags(params)}`;
  return `npm run stats -- ${open.view}${flags(params)}`;
}

/** `show <id>`: one finding, whole, with its evidence and its brief for an agent. */
export function formatFinding(finding, view) {
  const lines = [
    `${finding.id} · ${finding.severity} · ${finding.kind} · ${plural(finding.sessions, 'session')} · release ${releaseName(view)}`,
    finding.title,
    finding.summary,
    '',
    'Evidence',
    ...evidenceLines(finding.evidence),
    '',
    'Brief for an agent',
    finding.brief,
    '',
  ];
  const open = openCommand(finding.open);
  if (open) lines.push(`Open: ${open}`);
  lines.push(...footer(view));
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- responsiveness

function cellText(cell) {
  if (!cell) return '';
  if (cell.tooFew) return `too few (${count(cell.sessions)})`;
  const change = cell.change === null || cell.change === undefined ? '' : ` ${signedPoints(cell.change)}`;
  return `${percent(cell.smooth)} (${count(cell.sessions)})${change}`;
}

export function formatResponsiveness(view) {
  if (!view.release) return noRelease(view, 'Responsiveness').join('\n');
  const doing = (view.doings || []).find(d => d.id === view.doing);
  const label = doing?.label || view.doing;
  const scenes = view.axes?.scenes || [];
  const machines = view.axes?.machines || [];
  const cellOf = (scene, machine) => (view.grid || []).find(c => c.scene === scene && c.machine === machine);
  const rowWidth = Math.max(10, ...scenes.map(s => s.label.length)) + 2;
  const columns = machines.map(m => ({ ...m, head: MACHINE_COLUMN[m.id] || m.label }));
  const width = Math.max(20, ...columns.map(c => c.head.length + 2));
  const lines = [
    `${label} · ${releaseName(view)} · ${comparedWith(view)}`,
    `Smooth share of frames (sessions)${view.compare ? `, change in points against ${view.compare.release}` : ''}`,
    '',
    `  ${''.padEnd(rowWidth)}${columns.map(c => c.head.padEnd(width)).join('')}`.trimEnd(),
  ];
  for (const scene of scenes) {
    lines.push(`  ${scene.label.padEnd(rowWidth)}${columns.map(m => cellText(cellOf(scene.id, m.id)).padEnd(width)).join('')}`.trimEnd());
  }
  const t = view.total || {};
  const tc = t.compare;
  lines.push('', `All cells: ${percent(t.smooth)} smooth of ${count(t.frames)} frames, ${count(t.late)} late${tc ? ` (${view.compare.release}: ${percent(tc.smooth)} of ${count(tc.frames)})` : ''}`);
  const others = (view.doings || []).filter(d => d.id !== view.doing)
    .map(d => `${d.label} ${d.smooth === null || d.smooth === undefined ? 'too few' : percent(d.smooth)}`);
  if (others.length) lines.push(...wrap(others, '').map((line, i) => (i ? `  ${line}` : `Other interactions: ${line}`)));

  const measured = (view.grid || []).filter(c => !c.tooFew && typeof c.smooth === 'number');
  const worst = [...measured].sort((a, b) => a.smooth - b.smooth).slice(0, 3);
  if (worst.length) {
    lines.push('', 'Worst cells, and where their late frames\' time went');
    for (const c of worst) {
      const was = c.compare && !c.compare.tooFew ? ` (${view.compare.release}: ${percent(c.compare.smooth)})` : '';
      lines.push(`  ${SCENE_SHORT[c.scene] || c.scene}, ${MACHINE_SHORT[c.machine] || c.machine}: ${percent(c.smooth)}${was}, p50 ${ms(c.p50)}, p95 ${ms(c.p95)}, worst ${ms(c.worst)}`);
      const stages = (c.stages || []).slice(0, 4).map(s => `${s.label} ${Math.round(s.share * 100)}%`);
      if (stages.length) lines.push(`    ${stages.join(' · ')}`);
    }
  } else if ((view.grid || []).length) {
    lines.push('', `Every cell has too few sessions to show (${view.minGroup} needed).`);
  }
  const command = worst[0]?.command || view.profile?.command;
  lines.push('', command
    ? `Reproduce: ${command}`
    : `Reproduce: no profiling scenario covers ${DOING_VERB[view.doing] || view.doing}; record it with the developer tools (docs/DEVTOOLS.md).`);
  lines.push(...footer(view));
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- safety

function failureRow(name, row) {
  if (row.tooFew) return `  ${truncate(name, 30).padEnd(30)} too few (${count(row.sessions)})`;
  const why = row.reason ? `  ${reasonWords(row.reason)}${row.stage ? `, at ${row.stage}` : ''}` : '';
  return `  ${truncate(name, 30).padEnd(30)} ${count(row.attempts).padStart(7)} tries ${count(row.failed).padStart(6)} failed (${percent(row.failureRate)})${why}`;
}

export function formatSafety(view) {
  if (!view.release) return noRelease(view, 'Safety').join('\n');
  const s = view.saves || {};
  const lines = [`Safety · ${releaseName(view)} · ${comparedWith(view)}`, ''];
  const share = s.total ? percent(s.ok / s.total) : 'n/a';
  lines.push(`Saves     ${count(s.ok)} of ${count(s.total)} succeeded (${share}), ${count(s.failed)} failed, ${count(s.cancelled)} cancelled, in ${plural(s.sessions, 'session')}`);
  if (s.compare) lines.push(`          ${view.compare?.release ?? 'compared'}: ${count(s.compare.failed)} of ${count(s.compare.total)} failed`);
  const ops = (s.ops || []).map(o => `${o.op} ${count(o.ok)} ok, ${count(o.failed)} failed`);
  if (ops.length) lines.push(...wrap(ops, '          '));
  if (s.reasons?.length) {
    lines.push(...wrap(s.reasons.map(r => `${reasonWords(r.reason)} ${count(r.n)} (file left as it was: ${count(r.untouched)}${r.unknown ? `, not known: ${count(r.unknown)}` : ''})`), '          ')
      .map((line, i) => (i ? line : `  Why:    ${line.trimStart()}`)));
  }
  const rec = view.recovery;
  if (rec) {
    const why = rec.reasons?.length ? ` (${rec.reasons.map(r => `${reasonWords(r.reason)} ${count(r.n)}`).join(', ')})` : '';
    lines.push(`Recovery  ${count(rec.unsaved)} ended badly with unsaved work · ${count(rec.offered)} offered · ${count(rec.restored)} restored · ${count(rec.failed)} could not be read${why}`);
    if (rec.compare) lines.push(`          ${view.compare?.release ?? 'compared'}: ${count(rec.compare.unsaved)} · ${count(rec.compare.offered)} · ${count(rec.compare.restored)} · ${count(rec.compare.failed)}`);
  }
  const opens = view.opens || [];
  lines.push('', 'Opens, most opened first');
  if (!opens.length) lines.push('  none');
  for (const row of opens.slice(0, 8)) lines.push(failureRow(row.label || row.format, row));
  if (opens.length > 8) lines.push(`  and ${opens.length - 8} more (--json for all)`);
  const exports = view.exports || [];
  lines.push('', 'Exports');
  if (!exports.length) lines.push('  none');
  for (const row of exports.slice(0, 6)) lines.push(failureRow(row.format, row));
  if (exports.length > 6) lines.push(`  and ${exports.length - 6} more (--json for all)`);
  lines.push('', ...footer(view));
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- problems

const firstSeenText = first => (first ? (first.thisRelease ? `new in ${first.release}` : `since ${first.release}`) : '');
const shareText = (sessions, share) => `${plural(sessions, 'session')}${share === null || share === undefined ? '' : ` (${percent(share)})`}`;

export function formatProblems(view, { next = '' } = {}) {
  if (!view.release) return noRelease(view, 'Problems').join('\n');
  const problems = view.problems || [];
  const lines = [`Problems · ${releaseName(view)} · ${plural(view.groups ?? problems.length, 'group')}`, ''];
  if (!problems.length) lines.push('  nothing broke in this period');
  for (const p of problems.slice(0, 10)) {
    lines.push(`  ${p.sig}  ${p.type.padEnd(14)} ${shareText(p.sessions, p.share).padEnd(22)} ${firstSeenText(p.firstSeen)}`.trimEnd());
    lines.push(`    ${truncate(`${p.title}${p.where ? ` — ${p.where}` : ''}`, 96)}`);
  }
  if (problems.length > 10) lines.push(`  and ${problems.length - 10} more (--json for all)`);
  lines.push('', ...footer(view));
  if (problems.length) lines.push(`Next: npm run stats -- problem ${problems[0].sig}${next}`);
  return lines.join('\n');
}

export function formatProblem(view) {
  const p = view.problem || {};
  const recovered = p.recovered ? `, ${count(p.recovered)} recovered` : ', none recovered';
  const lines = [
    `Problem ${p.sig} · ${p.type} · release ${releaseName(view)}`,
    p.title,
    `${shareText(p.sessions, p.share)}, ${plural(p.times, 'time')}${recovered} · first seen in ${p.firstSeen?.release} on ${p.firstSeen?.day}${p.firstSeen?.thisRelease ? ' (new in this release)' : ''}`,
    '',
    `Message: ${view.message ?? 'none'}`,
    'Stack',
    ...(view.stack?.length ? view.stack.map(line => `  ${line}`) : ['  none sent']),
    'Trails (the last commands, oldest first)',
    ...(view.trails?.length ? view.trails.map(t => `  ${plural(t.sessions, 'session')}: ${t.commands.join(', ')}`) : ['  none recorded']),
    'What the sessions share',
  ];
  if (view.shared) {
    const shared = view.shared.shared.map(s => `${s.dimension} ${s.value} ${s.text}`);
    lines.push(...(shared.length ? wrap(shared, '  ') : ['  nothing that 80% of them have']));
    if (view.shared.varied?.length) lines.push(`  varied: ${view.shared.varied.join(', ')}`);
  } else {
    lines.push(`  too few sessions to say (${view.minGroup} needed)`);
  }
  lines.push('', 'Brief for an agent', view.brief, '');
  if (view.reports?.sampled) lines.push(`Only the newest 2,000 reports were read (${plural(view.reports.sessions, 'session')}).`);
  lines.push(...footer(view));
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- usage

const distribution = (list = [], n = 6, name = d => d.label || d.name) =>
  list.slice(0, n).map(d => `${name(d)} ${d.tooFew ? 'too few' : percent(d.share)}`);
function labelled(label, items) {
  if (!items.length) return [];
  return wrap(items, '').map((line, i) => (i ? `${''.padEnd(18)}${line}` : `${label.padEnd(18)}${line}`));
}

export function formatUsage(view) {
  if (!view.release) return noRelease(view, 'Usage').join('\n');
  const first = view.firstSession;
  const modes = view.modes;
  const lines = [`Usage · ${releaseName(view)} · ${plural(view.sessions, 'session')}`, ''];
  if (first) lines.push(...labelled(`First sessions`, [`${count(first.sessions)} of them`, ...first.steps.map(s => `${s.step} ${s.tooFew || s.share === null ? 'too few' : percent(s.share)}`)]));
  lines.push(
    ...labelled('Features', distribution(view.features, 8)),
    ...labelled('Scenes', distribution(view.project?.scene, 5, d => SCENE_SHORT[d.name] || d.name)),
    ...labelled('Files opened from', distribution(view.sources, 5)),
    ...labelled('Formats opened', distribution(view.formats, 5)),
  );
  if (modes) lines.push(...labelled('Timeline', [`simple ${percent(modes.simple?.share)} of minutes`, `advanced ${percent(modes.advanced?.share)}`]));
  lines.push(
    ...labelled('Platforms', distribution(view.platforms, 4)),
    ...labelled('Machines', distribution(view.machines?.class, 3, d => MACHINE_SHORT[d.name] || d.name)),
    ...labelled('Memory', distribution(view.machines?.memory, 6, d => `${d.name} GB`)),
    ...labelled('Languages', distribution(view.languages, 8)),
    ...labelled('Most run', (view.commands?.top || []).slice(0, 6).map(c => `${c.command} ${count(c.perSession)} a session`)),
    '',
    ...footer(view),
  );
  return lines.join('\n');
}

export function formatCuriosities(view) {
  if (!view.release) return noRelease(view, 'Curiosities').join('\n');
  const lines = [`Curiosities · ${releaseName(view)} · ${plural(view.sessions, 'session')}`, ''];
  for (const item of (view.items || []).slice(0, 20)) {
    lines.push(`  ${item.text} ${item.label}${item.comparison ? ` (${item.comparison})` : ''}`);
  }
  if (!view.items?.length) lines.push('  nothing to tell yet');
  const largest = view.largestProject;
  if (largest && (largest.scene || largest.figures || largest.frames)) {
    const parts = [SCENE_SHORT[largest.scene] || largest.scene, largest.figures && `${rangeWords(largest.figures)} figures`, largest.frames && `${rangeWords(largest.frames)} frames`];
    lines.push('', `Largest project seen: ${parts.filter(Boolean).join(', ')}`);
  }
  lines.push('', ...footer(view));
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------- help

export const HELP = `npm run stats -- [command] [options]

Reads what the app's anonymous statistics say about a release, from the website's report views.
Needs STYK_STATS_KEY (a read-only key, kept outside this public repository) and optionally
STYK_STATS_URL (default ${DEFAULT_SITE}; http: only for localhost and 127.0.0.1).

Commands
  release [version]        the four promises and what needs attention (the default)
  findings                 what needs attention with its evidence lines: the three that reach most sessions, or all with --all
  show <id>                one finding whole: evidence and the brief for an agent (R-ff75, E-a786)
  responsiveness [doing]   smooth share by scene size and machine (drag, play, scrub, view, draw)
  safety                   saves, recovery, file opens and exports, and why they failed
  problems                 what broke, for how many sessions, since when
  problem <signature>      one problem: stack, trails, what the sessions share, the brief
  usage                    who uses the app and which features earn their place
  curiosities              numbers worth a smile
  help                     this text

Options
  --release <version>      the release to read (default: the newest with enough sessions; all on usage, curiosities)
  --compare <version|none> the release to compare with (default: the one before)
  --days 7|30|90           the period, in days up to today (default 7)
  --platform <name>        win32, linux, darwin, web or all (default all)
  --channel <name>         stable, beta, internal or development (default stable)
  --all                    with findings: every finding, not the first three
  --fresh                  compute the view now instead of taking one up to five minutes old
  --json                   print the view's JSON unchanged

Exit codes: 0 read, 1 the site refused or could not be reached, 2 a wrong command line or setting.`;

// ------------------------------------------------------------------------------------------------- command line

export class UsageError extends Error {}

/** argv (after the script) → {command, arg, params, json}. Throws UsageError for a wrong command line. */
export function parseArgs(argv) {
  const positional = [];
  const params = {};
  let json = false;
  const valueOptions = ['release', 'compare', 'days', 'platform', 'channel'];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (name === 'json' || name === 'fresh' || name === 'all' || name === 'help') {
      if (eq >= 0) throw new UsageError(`--${name} takes no value.`);
      if (name === 'json') json = true;
      else if (name === 'fresh') params.fresh = '1';
      else if (name === 'all') params.all = '1';
      else positional.unshift('help');
      continue;
    }
    if (!valueOptions.includes(name)) throw new UsageError(`Unknown option --${name}.`);
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
    params[name] = value;
  }
  const command = positional.shift() || 'release';
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}". The commands: ${COMMANDS.join(', ')}.`);
  const arg = positional.shift();
  if (positional.length) throw new UsageError(`Too many words: ${positional.join(' ')}.`);
  if (arg !== undefined) {
    if (command === 'release') params.release = arg;
    else if (command === 'responsiveness') params.doing = arg;
    else if (command !== 'show' && command !== 'problem') throw new UsageError(`"${command}" takes no word after it.`);
  }
  if ((command === 'show' || command === 'problem') && !arg) {
    throw new UsageError(command === 'show' ? 'show needs a finding id, such as R-ff75 (npm run stats -- findings lists them).' : 'problem needs a signature (npm run stats -- problems lists them).');
  }
  if (params.days !== undefined && !DAYS.includes(params.days)) throw new UsageError(`--days is 7, 30 or 90, not ${params.days}.`);
  if (params.platform !== undefined && !['all', ...PLATFORMS].includes(params.platform)) throw new UsageError(`--platform is one of ${['all', ...PLATFORMS].join(', ')}.`);
  if (params.channel !== undefined && !CHANNELS.includes(params.channel)) throw new UsageError(`--channel is one of ${CHANNELS.join(', ')}.`);
  if (params.doing !== undefined && !DOING.includes(params.doing)) throw new UsageError(`responsiveness takes one of ${DOING.join(', ')}, not ${params.doing}.`);
  return { command, arg, params, json };
}

/** The site's origin from STYK_STATS_URL. Throws UsageError when it is not one the key may be sent to. */
export function siteOrigin(value) {
  const raw = value || DEFAULT_SITE;
  let url;
  try { url = new URL(raw); } catch { throw new UsageError(`STYK_STATS_URL is not an address: ${raw}`); }
  if (url.username || url.password) throw new UsageError('STYK_STATS_URL must not carry a user name or password.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new UsageError(`STYK_STATS_URL is the site's address alone, such as ${DEFAULT_SITE}, without a path.`);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new UsageError('STYK_STATS_URL uses http:, which is accepted only for localhost and 127.0.0.1: the key would cross the network unencrypted. Use https:.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`STYK_STATS_URL must be an https: address, not ${url.protocol}`);
  return url.origin;
}

export const NO_KEY = `STYK_STATS_KEY is not set.
The statistics are read with a read-only key kept in that environment variable, outside the
repository, because the repository is public. The owner makes the key and sets it on the website
with \`npx wrangler secret put STATS_READ_KEY\`, then sets the same value in STYK_STATS_KEY here.`;

class Refusal extends Error {}

/** One GET of a view. Returns {status, body, text}; throws Refusal when the site cannot be reached. */
async function getView(origin, key, view, params, fetchImpl) {
  const url = new URL(`/api/v1/admin/stats/${view.split('/').map(encodeURIComponent).join('/')}`, origin);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'styk-stats-reader' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const code = error?.cause?.code || error?.code;
    throw new Refusal(timedOut
      ? `${origin} did not answer within ${TIMEOUT_MS / 1000} seconds. Try again later.`
      : `Could not reach ${origin}${code ? ` (${code})` : ''}. Check the connection, and STYK_STATS_URL if it is set.`);
  }
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* judged below */ }
  return { status: response.status, location: response.headers.get('location'), body, text };
}

/** Does `version` exist? Lists the releases of the channel, from the overview, for a refusal's message. */
async function releaseList(origin, key, params, fetchImpl) {
  const base = { days: params.days, platform: params.platform, channel: params.channel };
  try {
    const answer = await getView(origin, key, 'overview', base, fetchImpl);
    const releases = answer.status === 200 ? answer.body?.releases || [] : [];
    return releases.length ? `The ${params.channel || 'stable'} channel reported: ${releases.slice(0, 12).map(r => `${r.version} (${plural(r.sessions, 'session')} in the period)`).join(', ')}.` : '';
  } catch { return ''; }
}

/** Reads one view, or throws Refusal / UsageError with a message that says what to do. */
async function read(context, view, params) {
  const { origin, key, fetchImpl } = context;
  const answer = await getView(origin, key, view, params, fetchImpl);
  const { status, body } = answer;
  if (status === 200) {
    if (!body || typeof body !== 'object') throw new Refusal(`${origin} answered, but not with statistics. Is STYK_STATS_URL the website?`);
    return answer;
  }
  if (status >= 300 && status < 400) {
    throw new Refusal(`${origin} answered with a redirect${answer.location ? ` to ${answer.location}` : ''} (${status}). The reader follows none, so the key goes to ${origin} only: set STYK_STATS_URL to the address the site answers on.`);
  }
  if (status === 401) {
    throw new Refusal(`The site refused the key (401). Check that STYK_STATS_KEY holds the read key set on the website with \`npx wrangler secret put STATS_READ_KEY\` (at least 32 characters). Eight wrong keys in 15 minutes lock this address out.`);
  }
  if (status === 429) throw new Refusal('Locked (429): too many wrong keys from this address in the last 15 minutes. Try again after the 15 minutes, with the right key.');
  if (status === 400 && body?.error === 'bad_parameter') throw new UsageError(`The site refused --${body.field} ${params[body.field] ?? ''}`.trimEnd() + '. See npm run stats -- help.');
  if (status === 404 && body?.error === 'unknown_release') {
    const field = body.field || 'release';
    const list = await releaseList(origin, key, params, fetchImpl);
    throw new Refusal(`${params[field] ?? 'That release'} is not a release the ${params.channel || 'stable'} channel reported (--${field}).${list ? `\n${list}` : ''}`);
  }
  if (status === 404) {
    if (view.startsWith('problems/')) {
      throw new Refusal(`No problem group ${view.slice('problems/'.length)} in this release and period. npm run stats -- problems lists them.`);
    }
    throw new Refusal(`The site does not know the view "${view}" (404). It may run an older version of the statistics: the views are ${['overview', 'findings', 'responsiveness', 'safety', 'problems', 'usage', 'curiosities'].join(', ')}.`);
  }
  throw new Refusal(`The site answered ${status}${body?.error ? ` (${body.error})` : ''}. Try again later.`);
}

/** Finds the full signature for a prefix or an E- id, from the problems view. */
async function resolveSignature(context, given, params) {
  const prefix = given.replace(/^E-/i, '').toLowerCase();
  if (/^[0-9a-f]{16}$/.test(prefix)) return prefix;
  if (!/^[0-9a-f]+$/.test(prefix)) throw new UsageError(`"${given}" is not a problem signature: 16 hex characters, a start of one, or a finding id such as E-a786.`);
  const { body } = await read(context, 'problems', params);
  const matches = (body.problems || []).filter(p => p.sig.startsWith(prefix));
  if (matches.length === 1) return matches[0].sig;
  if (!matches.length) throw new Refusal(`No problem group starts with ${prefix} in ${releaseName(body)}. npm run stats -- problems lists them.`);
  throw new Refusal(`${prefix} starts ${matches.length} signatures: ${matches.map(p => p.sig).join(', ')}. Give more of it.`);
}

const FORMATTERS = {
  release: ['overview', formatRelease], findings: ['findings', formatFindings], responsiveness: ['responsiveness', formatResponsiveness],
  safety: ['safety', formatSafety], problems: ['problems', formatProblems], usage: ['usage', formatUsage], curiosities: ['curiosities', formatCuriosities],
};

/**
 * Runs the reader. `env` gives STYK_STATS_KEY and STYK_STATS_URL; `out` and `err` take text; `fetchImpl` is
 * the global fetch. Returns the exit code. Nothing written through `out` or `err` contains the key.
 */
export async function run(argv, { env = process.env, out = text => process.stdout.write(text), err = text => process.stderr.write(text), fetchImpl = globalThis.fetch } = {}) {
  const key = env.STYK_STATS_KEY || '';
  const scrub = text => (key ? String(text).split(key).join('<key>') : String(text));
  const print = text => out(`${scrub(text)}\n`);
  const fail = (text, code) => { err(`${scrub(text)}\n`); return code; };
  try {
    const { command, arg, params, json } = parseArgs(argv);
    if (command === 'help') { print(HELP); return 0; }
    const origin = siteOrigin(env.STYK_STATS_URL);
    if (!key) return fail(NO_KEY, 2);
    if (!/^[\x21-\x7e]+$/.test(key)) return fail('STYK_STATS_KEY holds characters a key cannot have (a space, a line break or a letter outside ASCII). Set it again from the key itself.', 2);
    const context = { origin, key, fetchImpl };

    if (command === 'show') {
      // Every finding, so one beyond the three the overview shows can be shown too.
      const { body } = await read(context, 'findings', { ...params, all: '1' });
      const finding = (body.findings || []).find(f => f.id.toLowerCase() === arg.toLowerCase());
      if (!finding && /^E-[0-9a-f]+$/i.test(arg)) {
        // A problem's finding id starts its group's signature, and the problem view holds the same brief,
        // so a problem beyond the three shown findings can still be shown.
        const sig = await resolveSignature(context, arg, params);
        const answer = await read(context, `problems/${sig}`, params);
        print(json ? answer.text : formatProblem(answer.body));
        return 0;
      }
      if (!finding) {
        const ids = (body.findings || []).map(f => f.id);
        return fail(`No finding ${arg} among those of ${releaseName(body)} shown now${ids.length ? `: ${ids.join(', ')}` : ' (none)'}. The views give the three that reach most sessions; a finding that is gone was fixed or fell below its rule.`, 1);
      }
      print(json ? JSON.stringify(finding, null, 2) : formatFinding(finding, body));
      return 0;
    }
    if (command === 'problem') {
      const sig = await resolveSignature(context, arg, params);
      const answer = await read(context, `problems/${sig}`, params);
      print(json ? answer.text : formatProblem(answer.body));
      return 0;
    }
    const [view, format] = FORMATTERS[command];
    const answer = await read(context, view, params);
    print(json ? answer.text : format(answer.body, { next: flags(params) }));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return fail(`${error.message}\nnpm run stats -- help lists the commands and options.`, 2);
    if (error instanceof Refusal) return fail(error.message, 1);
    return fail(`The reader failed: ${error?.message || error}`, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
