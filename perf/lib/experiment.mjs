/**
 * Experiments: a run of the app not as it ships, to learn what a change would give before making it
 * (docs/PERFORMANCE.md "Experiments").
 *
 *   --param engine.workers=2,scrub.aheadFrames=0   live parameters' starting values, over the environment's own
 *                                                  (the Developer panel's Parameters tab lists them);
 *   --experiment <file.js>                         a script evaluated in the page once the app is ready, before any
 *                                                  scenario: stub a function, hide an element, flip a switch.
 *
 * Both are recorded in every pair's facts and said in the summary: an experiment's numbers are never the app's, and
 * the scripts stay out of the repository.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';

/** "a=1,b=true,c=text" as live parameter values: numbers and booleans as such, anything else as text. */
export function parseParameters(text) {
  const values = {};
  for (const part of String(text).split(',').map(piece => piece.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    if (at < 1) throw new Error(`--param takes name=value pairs, and ${JSON.stringify(part)} is not one.`);
    const value = part.slice(at + 1).trim();
    values[part.slice(0, at).trim()] = value === 'true' ? true : value === 'false' ? false : value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
  }
  return values;
}

/** `environment` with `parameters` over its own. */
export function withParameters(environment, parameters) {
  if (!parameters || !Object.keys(parameters).length) return environment;
  return {...environment, page: {...environment.page, parameters: {...environment.page?.parameters, ...parameters}}};
}

/** The page script at `file`: its name, a short hash that tells two versions of it apart, and its source. */
export function readExperiment(file) {
  const source = readFileSync(path.resolve(file), 'utf8');
  return {name: path.basename(file), sha256: createHash('sha256').update(source).digest('hex').slice(0, 12), source};
}

/** What a pair's facts say of an experiment, as a line for the summary; null for the app as it is. */
export function experimentLine(facts) {
  const parts = [];
  if (facts?.experiment) parts.push(`the page script ${facts.experiment.name} (${facts.experiment.sha256}) ran before the scenarios`);
  const asked = Object.entries(facts?.parameters ?? {});
  if (asked.length) parts.push(`live parameters ${asked.map(([name, value]) => `${name}=${value}`).join(', ')}`);
  if (facts?.unreadParameters?.length) parts.push(`the app never read ${facts.unreadParameters.join(', ')} (check the name${facts.unreadParameters.length === 1 ? '' : 's'})`);
  return parts.length ? `EXPERIMENT, not the app as it is: ${parts.join('; ')}` : null;
}
