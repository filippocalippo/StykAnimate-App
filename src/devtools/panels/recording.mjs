/**
 * What the panel holds of a recorded stretch (developer build only), shared by the Performance and the Profiler tabs:
 * Record and Stop take a capture (the same capture the control channel and the profiling runner take), "Last 5 s"
 * takes what the rings hold of the last five seconds, and either is held, summarized and graded, until "Live" lets it
 * go. Save writes the summary as JSON; Export Perfetto the spans as a Chrome trace.
 *
 * The summary is the runtime's (`runtime.summarize`, capture.mjs `analyze`), so a stretch recorded here and the same
 * gesture in a profiling run report the same numbers; the grade is grades.mjs `judgeCapture`, the runner's gesture rule.
 */
import {DEVELOPER, perfettoTrace} from '../capture.mjs';
import {judgeCapture} from '../grades.mjs';
import {button, download, element, format, setText, stamped} from './dom.mjs';

/** The label the panel's own captures carry: a capture with another label was started elsewhere (the control channel). */
const LABEL = 'panel';

export function createRecording(runtime) {
  const listeners = new Set();
  const state = {taken: null, summary: null, judged: null, source: null};
  const changed = () => { for (const listener of listeners) listener(state); };
  const hold = (taken, source) => {
    Object.assign(state, {taken, source, summary: runtime.summarize(taken, {series: true})});
    state.judged = judgeCapture(state.summary);
    changed();
  };
  const recording = {
    state,
    /** Calls `listener(state)` whenever what is held changes. */
    onChange(listener) { listeners.add(listener); },
    /** The capture running now, if any; `ours` when this panel started it. */
    get running() { return runtime.capture.running; },
    get ours() { return runtime.capture.running?.label === LABEL; },
    /** Display frames recorded since the running capture began. */
    framesSoFar() { return runtime.capture.running ? runtime.early.frames.total - runtime.capture.running.framesFrom : 0; },
    start() { runtime.startCapture(LABEL); changed(); },
    stop() { hold(runtime.stopCapture(), 'capture'); },
    recent(ms = 5000) { hold(runtime.recent(ms), 'recent'); },
    live() { Object.assign(state, {taken: null, summary: null, judged: null, source: null}); changed(); },
    /** The held stretch's summary as the profiling runner keeps one, with its grade and when it was taken. */
    save() {
      if (!state.summary) return;
      const {taken} = state;
      download(stamped('summary'), JSON.stringify({producer: DEVELOPER, kind: 'capture summary', label: taken.label, source: state.source, startedTime: new Date(taken.startedTime).toISOString(),
        judged: state.judged, summary: state.summary}, null, 1));
    },
    exportPerfetto() {
      if (!state.taken) return;
      const {taken} = state;
      download(stamped('trace'), JSON.stringify(perfettoTrace(taken.events, {origin: taken.startedAt, metadata: {label: taken.label, startedTime: taken.startedTime}})));
    },
  };
  return recording;
}

/**
 * The buttons over a tab that shows a recorded stretch: Record/Stop, Last 5 s, Live, Save, Export Perfetto, and a
 * status line. `update()` refreshes their state; call it on every refresh of the tab.
 */
export function recordingBar(recording) {
  const record = button('Record', () => (recording.running ? recording.stop() : recording.start()), 'Record from now until Stop, then show exactly that stretch');
  const recent = button('Last 5 s', () => recording.recent(5000), 'What the rings hold of the last five seconds: a hitch, after it happened');
  const live = button('Live', () => recording.live(), 'Back to the live view');
  const save = button('Save', () => recording.save(), 'The summary as JSON: the numbers and grade a profiling run would give');
  const perfetto = button('Perfetto', () => recording.exportPerfetto(), 'Export every span as Chrome trace JSON: open it at ui.perfetto.dev');
  const status = element('span', {className: 'dt-status'});
  const root = element('div', {className: 'dt-row'}, record, recent, live, save, perfetto, status);
  const update = () => {
    const running = recording.running, held = recording.state;
    setText(record, running ? 'Stop' : 'Record');
    record.dataset.recording = String(Boolean(running));
    record.disabled = Boolean(running && !recording.ours);
    recent.disabled = Boolean(running);
    live.setAttribute('aria-pressed', String(!held.taken && !running));
    save.disabled = !held.summary; perfetto.disabled = !held.taken;
    let text = 'Live';
    if (running && !recording.ours) text = `A capture from the control channel is running ("${running.label}")`;
    else if (running) text = `Recording… ${format((performance.now() - running.startedAt) / 1000, 1)} s, ${recording.framesSoFar()} frames`;
    else if (held.taken) text = `${held.source === 'recent' ? 'Last' : 'Recorded'} ${format(held.summary.ms / 1000, 1)} s · ${held.summary.frames?.count ?? 0} frames · ${held.summary.inputs?.count ?? 0} inputs · ${held.taken.events.length} events`;
    setText(status, text);
  };
  recording.onChange(update);
  update();
  return {element: root, update};
}
