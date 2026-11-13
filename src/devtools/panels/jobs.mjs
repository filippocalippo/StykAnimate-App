/**
 * The Jobs tab (developer build only; docs/DEVTOOLS.md "Panels"): the state of the app's threads and jobs that the
 * Performance tab does not chart. The engine's threads (how many, lost, the document generation, whether its counters
 * were busy), what the interface is doing (playing, buffering, importing, playback's buffer), the stage (its back end,
 * frames drawn, the last draw's geometry and submit times, a refusal), the browser's own counts of long tasks and slow
 * inputs since the page started, and every worker the page started with its messages. Frames prepared, queues, the
 * frame cache and memory are the Performance tab's.
 */
import {element, facts, format, liveTable, megabytes, setText} from './dom.mjs';

export function createJobsTab({runtime}) {
  const {sampler} = runtime;
  const engine = facts(['Threads', 'Lost', 'Generation', 'Busy']);
  const work = facts(['Playing', 'Buffering', 'Importing', 'Playback buffer', 'Last compile ms']);
  const stage = facts(['Back end', 'Frames drawn', 'Geometry ms', 'Submit ms', 'Refusal']);
  const browser = facts(['Long tasks', 'Long task ms', 'Slow inputs', 'Worst input ms']);
  const threads = liveTable(['#', 'Name', 'Script', 'Age s', 'Sent', 'Received', 'Errors'], {numeric: [0, 3, 4, 5, 6]});
  const threadsTitle = element('h4');
  const root = element('div', {}, element('h4', {textContent: 'Engine'}), engine.element, element('h4', {textContent: 'Interface'}), work.element,
    element('h4', {textContent: 'Stage'}), stage.element, element('h4', {textContent: 'Browser (since the page started)'}), browser.element, threadsTitle,
    element('div', {className: 'dt-scroll'}, threads.element));

  function refresh() {
    const jobs = sampler.jobs(), e = jobs.engine ?? {};
    engine.update([`${e.workers ?? '–'}${e.threaded === false ? ' (no workers)' : ''}`, format(e.workersLost ?? null), format(e.generation ?? null), String(e.busy ?? '–')]);
    const playback = jobs.playback && !jobs.playback.error ? jobs.playback : {};
    work.update([String(jobs.playing), String(jobs.buffering), String(jobs.importing), `${format(playback.readyFrames ?? null)} frames, ${megabytes(playback.bytes)}`, format(playback.lastCompileMs ?? null)]);
    const s = jobs.stage && !jobs.stage.error ? jobs.stage : {};
    stage.update([format(s.backend ?? null), format(s.frames ?? null), format(s.lastSendMs ?? null), format(s.lastDrawMs ?? null), s.refusal ? String(s.refusal) : '–']);
    browser.update([jobs.browser.longTasks, jobs.browser.longTaskMs, jobs.browser.slowInputs, jobs.browser.worstInputMs]);
    setText(threadsTitle, `Threads (${jobs.threads.live} live of ${jobs.threads.started} started)`);
    threads.update(sampler.threads().map(row => ({key: row.id, cells: [row.id, row.name, row.url, format(row.ageMs / 1000, 0), row.sent, row.received, row.errors]})));
  }

  return {name: 'Jobs', root, refresh, interval: 500};
}
