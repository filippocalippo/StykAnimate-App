// Stands in for the `claude` CLI in tests: reads the prompt on stdin and streams a canned
// reply in the CLI's stream-json format, so the app can be tested without spending tokens.
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 40);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const body = (id, title, goes = '') => `<screen id="${id}" title="${title}" idea="A test of the ${title.toLowerCase()} idea.">
<style>.t{height:100%;display:grid;place-items:center;background:var(--surface-field)}</style>
<div class="t"><div class="island" style="padding:32px"><h1 data-part="heading">${title}</h1><x-fig p="run"></x-fig><button class="btn" data-variant="primary"${goes}>Continue</button></div></div>
</screen>`;

let reply;
// The plan: the number the owner asked for (3 by default) or, when they ask for a flow, one flow job.
const asked = prompt.match(/The owner asked: (.*)/)?.[1] ?? '';
const ANGLES = ['Calm', 'Bold', 'Playful', 'Quiet', 'Dense', 'Airy'];
const plan = prompt.includes('reply only with job lines');
// FAIL fails the design, so the error lands on its frame.
if (prompt.includes('FAIL') && !plan) { emit({ type: 'result', is_error: true, result: 'Rate limited.', usage: {} }); process.exit(0); }
if (plan && /flow/i.test(asked)) reply = '<job title="A flow" flow="true" free="false" brief="Linked screens"/>';
else if (plan) reply = Array.from({ length: Number(asked.match(/\d+/)?.[0] ?? 3) }, (_, i) => `<job title="Direction" flow="false" free="false" brief="${ANGLES[i % ANGLES.length]} take"/>`).join(' ');
else if (prompt.includes('Reply only with edits')) reply = '<edit><find>Continue</find><replace>Keep going</replace></edit>';
else if (prompt.includes('<fragment>')) reply = '<fragment><h1 data-part="heading">Picked and changed</h1></fragment>';
else if (prompt.includes('<tokens>')) reply = '<tokens>:root{--primary:#7c5cff}</tokens>';
else if (prompt.includes('<finding')) reply = '<finding sev="high" title="The next step is unclear" why="Two buttons compete." fix="Rename Continue to Start"/>';
else if (prompt.includes('flow of 2 to 4')) reply = body('one', 'First', ' data-go="two"') + body('two', 'Second', ' data-go="one"');
else reply = body('home', prompt.match(/(?:Your part of it|Your direction):\s*(\w+)/)?.[1] ?? 'Screen');

emit({ type: 'system', subtype: 'init', model: 'fake' });
await wait(delay);
let full = '';
for (let at = 0; at < reply.length; at += 37) {
  const text = reply.slice(at, at + 37);
  full += text;
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  await wait(delay / 8);
}
// A plan is a short call; each design costs 3702 tokens.
const usage = plan ? { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 48 } : { input_tokens: 2, cache_creation_input_tokens: 2800, cache_read_input_tokens: 0, output_tokens: 900 };
emit({ type: 'result', is_error: false, result: full, duration_ms: 1234, usage });
