// Grades and metrics as the page shows them. Numbers are written by perf/lib/metrics.mjs `format` itself: the builder
// copies its source into the page with the definitions it reads, so "12.4 ms" is the same text here, in summary.txt
// and in `npm run perf -- compare`.
import {format, GRADES, METRICS} from '../../lib/metrics.mjs';
import {h, s} from './dom.mjs';

/**
 * Each state's word and shape. A grade is never told by colour alone: the shape and the word say it too, so the
 * matrix reads in grey, in print and for a reader who does not tell red from green.
 */
export const STATUS = {
  good: {word: 'Good', shape: 'circle'}, fair: {word: 'Fair', shape: 'triangle'}, poor: {word: 'Poor', shape: 'diamond'}, bad: {word: 'Bad', shape: 'square'},
  failed: {word: 'Failed', shape: 'cross'}, skipped: {word: 'Skipped', shape: 'dash'}, ungraded: {word: 'Not graded', shape: 'ring'},
};
const SHAPES = {
  circle: () => s('circle', {cx: 5, cy: 5, r: 4.2}),
  triangle: () => s('path', {d: 'M5 .6 9.6 9H.4Z'}),
  diamond: () => s('path', {d: 'M5 .2 9.8 5 5 9.8.2 5Z'}),
  square: () => s('rect', {x: 1, y: 1, width: 8, height: 8, rx: 1}),
  cross: () => s('path', {d: 'M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5', class: 'stroke'}),
  dash: () => s('path', {d: 'M1 5H9', class: 'stroke'}),
  ring: () => s('circle', {cx: 5, cy: 5, r: 3.6, class: 'stroke'}),
};

/** The shape of a state, 10 px, coloured by its state. */
export const glyph = status => s('svg', {class: `glyph st-${status}`, viewBox: '0 0 10 10', width: 10, height: 10, 'aria-hidden': 'true'}, SHAPES[(STATUS[status] ?? STATUS.ungraded).shape]());
/** A state as a chip: shape and word. */
export const chip = status => h('span', {class: `chip st-${status}`}, glyph(status), (STATUS[status] ?? STATUS.ungraded).word);
export const word = status => (STATUS[status] ?? STATUS.ungraded).word;

/** A metric's definition: the scenario's own, else the runner's, else a plain one. */
export const definition = (scenario, key) => scenario?.definitions?.[key] ?? METRICS[key] ?? {title: key, unit: '', better: 'lower', digits: 1};
export const title = (scenario, key) => definition(scenario, key).title ?? key;
/** The short name for a phrase ("input to frame"), else the title. */
export const short = (scenario, key) => definition(scenario, key).short ?? title(scenario, key);
/** A metric's value as text with its unit. */
export const metric = (scenario, key, value) => format(key, value, scenario?.definitions ?? {});

/** The limits of a criterion as a phrase: "good to 34 ms, fair to 67 ms, poor to 150 ms" (for a higher metric "from"). */
export function limitsText(scenario, key, limits) {
  if (!limits) return '';
  const to = definition(scenario, key).better === 'higher' ? 'from' : 'to';
  return GRADES.slice(0, 3).map((grade, index) => `${grade} ${to} ${metric(scenario, key, limits[index])}`).join(', ');
}
