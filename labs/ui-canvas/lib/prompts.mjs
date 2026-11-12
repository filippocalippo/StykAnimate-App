// The user turn of each call. The design system lives in brief/design-brief.md, the system
// prompt, so a request carries only what changes: the ask and the markup in question.

export const MAX_JOBS = 24;

// The owner never sets a count: the agent reads the request and plans the work itself.
export function planPrompt({ prompt, source, tasteFrames }) {
  return [
    source ? `Current screen: "${source.title}" (${source.idea ?? ''}). The owner wants alternatives of it.` : '',
    `The owner asked: ${prompt || 'Show me different directions.'}`,
    'Do not design yet. Work out what to generate and reply only with job lines, no <screen>.',
    'Follow any numbers exactly, however many subjects they name: "5 of this, 5 of that, 10 of one thing in different styles" is 20 jobs.',
    'With no number, choose what serves the request: usually 3 directions, or 1 if they clearly want one specific thing.',
    'Jobs of the same subject must differ in idea, not decoration. Reach for radical simplicity, working directly on the figures, the mental model of a different craft, an unexpected structure.',
    'Set free="true" only where a job should leave the design system, such as when different styles are asked for. Set flow="true" only where one job is a flow of linked screens.',
    `At most ${MAX_JOBS} jobs:`,
    '<job title="2 to 4 words" flow="false" free="false" brief="Under 30 words: what this one designs and its specific direction"/>',
    taste(tasteFrames),
  ].filter(Boolean).join('\n');
}

const SIZE = (frame) => `Viewport ${frame.w}x${frame.h}.`;

function taste(frames) {
  const ideas = (tag) => frames.filter((frame) => frame.tags?.includes(tag) && frame.idea).slice(-4).map((frame) => frame.idea);
  const liked = ideas('keep'), rejected = ideas('reject');
  return [
    liked.length ? `The owner liked: ${liked.join('; ')}.` : '',
    rejected.length ? `The owner rejected: ${rejected.join('; ')}.` : '',
  ].filter(Boolean).join('\n');
}

const styleLine = (free) => (free
  ? 'Style: explore freely. Start the <style> with a :root token override for a distinct, deliberate look, keeping every token name.'
  : 'Style: stay on the design system.');

export function createPrompt({ prompt, job, size, tasteFrames }) {
  return [
    `The owner asked: ${prompt}`,
    `Your part of it: ${job.brief}. Commit to this direction and do not hedge.`,
    `Viewport ${size.w}x${size.h}.`,
    job.flow ? 'Design a flow of 2 to 4 linked screens, connected with data-go.' : 'Design one screen.',
    styleLine(job.free),
    taste(tasteFrames),
  ].filter(Boolean).join('\n');
}

export function variantPrompt({ prompt, source, html, job, tasteFrames }) {
  return [
    `Current screen "${source.title}":`, html,
    `Design a new alternative of this screen. ${prompt ? `The owner asked: ${prompt}` : ''}`,
    `Your direction: ${job.brief}. Commit to it.`, SIZE(source), styleLine(job.free), taste(tasteFrames),
  ].filter(Boolean).join('\n');
}

export function nextPrompt({ prompt, source, html }) {
  return [
    `Current screen "${source.title}" (id ${source.screenId}):`, html,
    `Design the next screen in this flow. ${prompt}`,
    `Give it a new id and a data-go back to "${source.screenId}" where that makes sense.`, SIZE(source),
  ].join('\n');
}

export function combinePrompt({ prompt, sources }) {
  return [
    ...sources.map(({ frame, html }, index) => `Screen ${index + 1} "${frame.title}":\n${html}`),
    `Combine the best of these into one screen. ${prompt}`, SIZE(sources[0].frame),
  ].join('\n');
}

export function refinePrompt({ prompt, source, html }) {
  return [
    `Screen "${source.title}":`, html, `Change: ${prompt}`,
    'Reply only with edits, in order, each <find> an exact unique substring of the screen:',
    '<edit><find>old</find><replace>new</replace></edit>',
  ].join('\n');
}

export function elementPrompt({ prompt, source, element }) {
  return [
    `In screen "${source.title}", this element:`, element, `Change: ${prompt}`,
    'Reply only with <fragment>the replacement element</fragment>.',
  ].join('\n');
}

export function restylePrompt({ prompt, sources }) {
  return [
    `Screens: ${sources.map(({ frame }) => `${frame.title} (${frame.idea ?? ''})`).join('; ')}.`,
    `New look: ${prompt}`,
    'Do not touch the markup. Reply only with <tokens>:root{...}:root[data-theme="dark"]{...}</tokens> overriding design tokens, keeping text contrast at 4.5:1.',
  ].join('\n');
}

export function critiquePrompt({ prompt, source, html }) {
  return [
    `Screen "${source.title}":`, html, `Critique this as a senior product designer. ${prompt}`,
    'List at most 5 real problems or missed creative opportunities, most important first. Reply only with lines of:',
    '<finding sev="high|med|low" title="Under 8 words" why="Under 16 words" fix="One concrete change"/>',
  ].join('\n');
}
