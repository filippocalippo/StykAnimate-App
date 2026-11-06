/**
 * The inspector kit in a real page: its markup through updateInspectorDOM(),
 * PropertyControls on kit number fields (scrub with Shift, arrow steps,
 * Escape rollback), titled sections that stay open across refreshes, node
 * identity across optional content (the scope slot, hidden sections), the
 * title switch, plain step buttons, slider readouts (drag, keys, rollback),
 * Mixed values, collections, the "more below" fade, the one-time scrub hint
 * and field containment at the docked widths. The kit's stylesheets are
 * linked by hand, with the spec tokens tokens.css does not define yet, until
 * app.css imports them. `--shot <file>` also saves a picture of the sections.
 *
 *   node tests/inspector-kit.browser.mjs            (STYK_URL, default http://127.0.0.1:47914)
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

// segmented.css is track C's, linked for the radio thumb the inspector sheet draws on it.
const SHEETS = ['field', 'slider', 'select', 'stepper', 'switch', 'check', 'swatch', 'form', 'section', 'list-row', 'segmented']
  .map(name => `/src/styles/components/${name}.css`).concat('/src/styles/features/inspector.css');
// The spec tokens these sheets read that tokens.css adds when app.css imports them (spec tokens.css, verbatim).
const PENDING_TOKENS = ':root{--weight-value:450;--type-value:var(--weight-value) var(--text-13)/var(--leading-13) var(--font-ui);--space-3-5:14px}';
const WIDTHS = [256, 272, 288];
const shotIndex = process.argv.indexOf('--shot'), shot = shotIndex > 0 ? process.argv[shotIndex + 1] : null;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const passed = [];
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
try {
  const page = await browser.newPage({viewport: {width: 900, height: 1000}});
  page.on('pageerror', error => { throw error; });
  await page.route('**/src/app.mjs', route => route.fulfill({contentType: 'text/javascript', body: ''}));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47914');
  await page.evaluate(async ({sheets, tokens}) => {
    await Promise.all(sheets.map(href => new Promise((resolve, reject) => {
      const link = Object.assign(document.createElement('link'), {rel: 'stylesheet', href});
      link.onload = resolve; link.onerror = () => reject(new Error(`${href} did not load`));
      document.head.append(link);
    })));
    const style = document.createElement('style');
    style.textContent = `@layer tokens{${tokens}}`;
    document.head.append(style);
    await document.fonts.ready;
    document.documentElement.dataset.theme = 'light';
    document.documentElement.removeAttribute('data-theme-pending');
    document.getElementById('app')?.remove();
    const head = Object.assign(document.createElement('div'), {id: 'inspector-head'});
    const root = Object.assign(document.createElement('div'), {id: 'inspector'});
    for (const element of [head, root]) element.setAttribute('data-ui', '');
    head.style.cssText = 'box-sizing:content-box;inline-size:256px;padding:12px 16px 0;background:var(--surface);position:absolute;inset:0 auto auto 0;display:block';
    root.style.cssText = 'box-sizing:content-box;inline-size:256px;padding:12px 16px;background:var(--surface);position:absolute;inset:60px auto auto 0;display:block';
    document.body.append(head, root);
  }, {sheets: SHEETS, tokens: PENDING_TOKENS});

  // Everything below runs against one live inspector (window.kitPage).
  await page.evaluate(async () => {
    const kit = await import('/src/inspector-kit.mjs'), {updateInspectorDOM} = await import('/src/inspector-dom.mjs');
    const {PropertyControls} = await import('/src/property-controls.mjs'), {icon} = await import('/src/icons.mjs');
    const root = document.getElementById('inspector'), head = document.getElementById('inspector-head');
    const model = {root_x: 100, scale: 100, figure_z_order: 2, chain: 2, joined: false, scope: null, text: false, roundness: 50, opacity: 40, mixed: true};
    const saved = [], log = [], changes = [];
    const memory = new kit.SectionMemory({}, {onChange: value => saved.push(value)});
    const descriptor = () => ({
      kind: 'figure', quick: {context: 'figure', label: 'Figure actions'}, scope: model.scope,
      sections: [
        {id: 'text', title: 'Text', hidden: !model.text, rows: [{kind: 'actions', items: [{action: 'edit-text', icon: 'text', label: 'Edit text', text: true, variant: 'outline'}]}]},
        {id: 'transform', title: 'Transform', rows: [{kind: 'grid', rows: [
          {kind: 'number', key: 'root_x', label: 'X', unit: 'px', value: model.root_x},
          {kind: 'number', key: 'scale', label: 'Scale', unit: '%', value: model.scale, min: 0.01},
        ]}]},
        {id: 'appearance', title: 'Appearance', actions: [{action: 'reset-color', icon: 'undo', label: 'Reset colours'}], rows: [{kind: 'grid', rows: [
          {kind: 'color', id: 'figure-color', label: 'Colour', value: '#0d99ff'},
          {kind: 'number', key: 'figure_opacity', field: false, label: 'Opacity', unit: '%', value: model.opacity, min: 0, max: 100, mixed: model.mixed},
        ]}]},
        {id: 'arrange', title: 'Arrange', actions: [{action: 'join-figure', label: 'Join…', text: true}], rows: [{kind: 'grid', ratio: '3:2', stackNarrow: true, rows: [
          {kind: 'select', id: 'figure-layer', label: 'Layer', options: [{value: 'a', label: 'Bubble', selected: true}, {value: 'b', label: 'Rival'}]},
          {kind: 'stepper-field', key: 'figure_z_order', label: 'Order', description: 'Z-index', precision: 0, value: model.figure_z_order, min: -1000000, max: 1000000,
            down: {action: 'layer-down', label: 'Send backward', icon: 'step-down'}, up: {action: 'layer-up', label: 'Bring forward', icon: 'step-up'}},
        ]}]},
        {id: 'preview', title: 'Preview', place: 'titled', open: true, rows: [{kind: 'preview', media: {tag: 'canvas', key: 'camera-monitor', label: 'Live camera output', data: {'camera-monitor': true}},
          caption: ['960 × 540', '100% zoom']}]},
        {id: 'ik', title: 'IK', rows: [
          {kind: 'grid', rows: [{kind: 'field-switch', id: 'node-is-ik', label: 'Use IK', checked: true, controls: 'node-ik-options'}, {kind: 'field-switch', id: 'pin-joint', label: 'Pin joint'}]},
          {kind: 'group', id: 'node-ik-options', rows: [
            {kind: 'stepper', id: 'node-ik-chain', label: 'Chain', description: 'IK chain length', value: model.chain, min: 1, max: 3, step: 1},
            {kind: 'segmented', label: 'Bend', description: 'IK bend direction', name: 'node-ik-bend', value: 0, options: [[-1, 'Left'], [0, 'Both'], [1, 'Right']].map(([value, label]) => ({value, label}))},
          ]},
        ]},
        {id: 'connection', title: 'Connection', place: 'titled', open: ctx => ctx.joined, rows: [
          {kind: 'value', label: 'Joined to', text: 'Rival · Left hand'},
          {kind: 'actions', items: [{action: 'combine-figures', label: 'Combine connected', text: true, variant: 'outline'}]},
        ]},
        {id: 'colours', title: 'Colours', place: 'titled', rows: [{kind: 'swatches', label: 'Figure colours', items: ['#0d99ff', '#13263a', '#ff6a2b'].map(value => ({value, picker: 'paint', label: `Replace ${value}`}))}]},
        {id: 'parallax', title: 'Parallax', place: 'titled', switch: {id: 'parallax-on', label: 'Enable parallax', checked: true}, rows: [
          {kind: 'slider', label: 'Movement', min: 0, max: 400, value: 100, unit: '%', valueText: 'Normal', data: {'parallax-field': 'movement'}},
          {kind: 'slider', key: 'roundness', label: 'Round', min: 0, max: 100, value: model.roundness, unit: '%'},
          {kind: 'checkbox', id: 'inspector-layer-visible', label: 'Visible', checked: true},
        ]},
      ],
    });
    const render = () => {
      updateInspectorDOM(head, kit.renderInspectorHead(descriptor(), {icon}));
      updateInspectorDOM(root, kit.renderInspector(descriptor(), {icon, memory, ctx: {joined: model.joined}}));
      installed?.sync();
    };
    let installed = null;
    render();
    let hints = 0;
    installed = kit.installInspectorKit(root, {memory, onScrubHint: text => { hints++; log.push(text); }});
    const controls = new PropertyControls(root, {
      begin: payload => payload.key, preview: payload => log.push(['preview', payload.key, payload.value]),
      commit: payload => { model[payload.key] = payload.value; log.push(['commit', payload.key, payload.value]); },
      cancel: payload => log.push(['cancel', payload.key, payload.initialValue]),
    });
    root.addEventListener('change', event => changes.push(event.target.id || event.target.dataset.property || event.target.name));
    window.kitPage = {kit, root, head, model, saved, log, changes, memory, render, installed, controls, hints: () => hints};
  });

  const inPage = (name, body) => page.evaluate(body).then(ok => { assert.ok(ok, name); pass(name); });

  // Titled sections: a click opens in place, the memory remembers, a refresh keeps it.
  await inPage('Titled sections start closed', () => {
    const {root} = window.kitPage;
    return root.querySelector('[data-section-toggle="colours"]').getAttribute('aria-expanded') === 'false' && root.querySelector('#inspector-section-figure-colours').hidden;
  });
  await inPage('A click opens the section in place, the memory saves it and a refresh keeps it and its node', () => {
    const {root, saved, render} = window.kitPage, toggle = root.querySelector('[data-section-toggle="colours"]');
    toggle.click();
    const opened = toggle.getAttribute('aria-expanded') === 'true' && !root.querySelector('#inspector-section-figure-colours').hidden && toggle.closest('.ui-section').hasAttribute('data-open');
    const remembered = JSON.stringify(saved.at(-1)) === '{"figure":{"colours":true}}';
    render();
    return opened && remembered && root.querySelector('[data-section-toggle="colours"]') === toggle && toggle.getAttribute('aria-expanded') === 'true';
  });
  await inPage('An auto-open section opens when its content matters, stays closed after a close, and opens again next time', () => {
    const {root, model, render} = window.kitPage, state = () => root.querySelector('[data-section-toggle="connection"]').getAttribute('aria-expanded');
    model.joined = true; render();
    const opens = state() === 'true';
    root.querySelector('[data-section-toggle="connection"]').click(); render();
    const holds = state() === 'false';
    model.joined = false; render(); model.joined = true; render();
    return opens && holds && state() === 'true';
  });

  // Node identity across optional content: the scope slot and a hidden section before the others.
  await inPage('The scope line and a hidden section come and go without replacing the quick row, the monitor, the fields or focus', () => {
    const {root, head, model, render} = window.kitPage;
    const quick = head.querySelector('.ui-quick[data-quick-context="figure"]');
    quick.innerHTML = '<button type="button" data-action="mirror">Flip</button>';
    const monitor = root.querySelector('canvas[data-camera-monitor]'), x = root.querySelector('input[data-property="root_x"]');
    const nodes = [...root.querySelectorAll('input, select, button')];
    x.focus();
    const same = () => head.querySelector('.ui-quick') === quick && quick.textContent === 'Flip' && root.querySelector('canvas[data-camera-monitor]') === monitor &&
      root.querySelector('input[data-property="root_x"]') === x && document.activeElement === x &&
      [...root.querySelectorAll('input, select, button')].filter(node => !node.closest('[data-section="text"]')).every((node, i) => node === nodes[i]);
    const results = [];
    const scopeSlot = () => head.querySelector('#inspector-scope');
    results.push(Boolean(scopeSlot()?.hidden) && !scopeSlot().getClientRects().length);
    model.scope = {label: 'Editing frames 22–28', stop: {command: 'toggle-range-edit'}}; render();
    results.push(same(), scopeSlot()?.hidden === false && scopeSlot().textContent.includes('Editing frames 22–28'));
    model.text = true; render();
    results.push(same(), Boolean(root.querySelector('[data-section="text"] [data-action="edit-text"]')));
    model.scope = null; model.text = false; render();
    results.push(same(), Boolean(scopeSlot()?.hidden), !root.querySelector('[data-section="text"]')?.getClientRects().length);
    x.blur();
    return results.every(Boolean);
  });
  await inPage('With the head and foot in the same host, the scope slot still leaves the quick row, the monitor and the foot in place', async () => {
    const {kit, model} = window.kitPage, {updateInspectorDOM} = await import('/src/inspector-dom.mjs'), {icon} = await import('/src/icons.mjs');
    const host = document.createElement('div');
    host.hidden = true;
    document.body.append(host);
    const descriptor = () => ({kind: 'figure', quick: {context: 'figure'}, scope: model.scope, footer: [{action: 'add-to-library', icon: 'library', label: 'Add to library'}], sections: [
      {id: 'text', title: 'Text', hidden: !model.text, rows: []},
      {id: 'preview', rows: [{kind: 'preview', media: {tag: 'canvas', key: 'camera-monitor', label: 'Live camera output'}}]},
    ]});
    const draw = () => updateInspectorDOM(host, kit.renderInspector(descriptor(), {icon}, {head: true, foot: true}));
    draw();
    const quick = host.querySelector('.ui-quick'), monitor = host.querySelector('canvas'), foot = host.querySelector('[data-action="add-to-library"]');
    quick.textContent = 'kept';
    const same = () => host.querySelector('.ui-quick') === quick && quick.textContent === 'kept' && host.querySelector('canvas') === monitor && host.querySelector('[data-action="add-to-library"]') === foot;
    const results = [];
    for (const [scope, text] of [[{label: 'Editing frames 2–4'}, false], [{label: 'Editing frames 2–4'}, true], [null, true], [null, false]]) {
      model.scope = scope; model.text = text; draw();
      results.push(same());
    }
    host.remove();
    return results.every(Boolean);
  });

  // PropertyControls on kit fields.
  await inPage('The first focus of a scrub-able field shows the hint once; Shift+ArrowUp steps 0.1 and commits; Escape rolls back', () => {
    const {root, model, log, kit, hints} = window.kitPage, x = root.querySelector('input[data-property="root_x"]');
    x.focus();
    const hinted = hints() === 1 && log.includes(kit.SCRUB_HINT);
    x.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', shiftKey: true, bubbles: true}));
    x.dispatchEvent(new KeyboardEvent('keyup', {key: 'ArrowUp', bubbles: true}));
    const stepped = Math.abs(model.root_x - 100.1) < 1e-9;
    x.value = '250'; x.dispatchEvent(new Event('input', {bubbles: true}));
    x.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    const rolled = Math.abs(model.root_x - 100.1) < 1e-9 && log.some(entry => entry[0] === 'cancel' && entry[1] === 'root_x') && x.value === '100.1';
    x.blur();
    root.querySelector('#node-is-ik').focus(); root.querySelector('input[data-property="scale"]').focus();
    const once = hints() === 1;
    root.querySelector('input[data-property="scale"]').blur();
    return hinted && stepped && rolled && once;
  });
  await inPage('A Mixed value stays Mixed when a person leaves it unchanged', async () => {
    const {root} = window.kitPage, opacity = root.querySelector('input[data-property="figure_opacity"]');
    const before = opacity.value === '' && opacity.placeholder === 'Mixed';
    opacity.focus(); opacity.blur();
    await new Promise(resolve => setTimeout(resolve, 0));
    return before && opacity.value === '' && opacity.dataset.propertyValue === '40';
  });

  // Steps.
  await inPage('A plain step changes the value within its limits, reports it and turns off at the limit', () => {
    const {root, changes} = window.kitPage, up = root.querySelector('.ui-stepper [data-kit-step="1"]');
    up.click();
    const stepped = root.querySelector('#node-ik-chain').value === '3' && changes.includes('node-ik-chain') && up.disabled;
    up.click();
    return stepped && root.querySelector('#node-ik-chain').value === '3' && changes.filter(id => id === 'node-ik-chain').length === 1 && up.tabIndex === -1;
  });
  await inPage('The stepper field draws Order, the step down, the value, the step up; its steps are out of the tab order', () => {
    const order = window.kitPage.root.querySelector('.ui-field[data-steps]');
    const [label, down, input, up] = ['.ui-field-label', '[data-action="layer-down"]', 'input', '[data-action="layer-up"]'].map(selector => order.querySelector(selector));
    const left = element => element.getBoundingClientRect().left;
    return left(label) < left(down) && left(down) < left(input) && left(input) < left(up) && down.tabIndex === -1 && up.tabIndex === -1;
  });

  // The title switch switches; only the rest of the title row opens the section.
  const section = () => page.evaluate(() => window.kitPage.root.querySelector('[data-section-toggle="parallax"]').getAttribute('aria-expanded'));
  const before = await section();
  await page.click('#parallax-on');
  assert.equal(await page.evaluate(() => document.getElementById('parallax-on').checked), false, 'the title switch switches');
  assert.equal(await section(), before, 'clicking the switch does not open or close its section');
  pass('Clicking the title switch switches the feature and leaves the section as it was');
  await page.evaluate(() => window.kitPage.root.querySelector('[data-section-toggle="parallax"]').click());
  assert.equal(await section(), 'true');

  // Sliders: dragged (input events), stepped by keys and rolled back (no input event), custom readouts.
  await inPage('A slider keeps its fill and readout while dragged, and a custom readout for the value it names', () => {
    const slider = window.kitPage.root.querySelector('.ui-slider[data-parallax-field="movement"]'), output = () => slider.parentElement.querySelector('output').textContent;
    const custom = output() === 'Normal' && slider.getAttribute('aria-valuetext') === 'Normal';
    slider.value = '200'; slider.dispatchEvent(new Event('input', {bubbles: true}));
    const dragged = slider.style.getPropertyValue('--_p') === '50%' && output() === '200%' && slider.getAttribute('aria-valuetext') === '200%';
    slider.value = '100'; slider.dispatchEvent(new Event('input', {bubbles: true}));
    return custom && dragged && output() === 'Normal';
  });
  // The readout follows once the key event is done (a task later), so wait for the value, then for the readout to agree.
  const readout = async value => {
    await page.waitForFunction(value => {
      const slider = window.kitPage.root.querySelector('.ui-slider[data-property="roundness"]');
      return slider.value === value && slider.parentElement.querySelector('output').textContent === `${value}%`;
    }, value, {timeout: 2000}).catch(() => {});
    return page.evaluate(() => {
      const slider = window.kitPage.root.querySelector('.ui-slider[data-property="roundness"]');
      return [slider.value, slider.parentElement.querySelector('output').textContent, slider.getAttribute('aria-valuetext'), slider.style.getPropertyValue('--_p')];
    });
  };
  await page.focus('.ui-slider[data-property="roundness"]');
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await readout('51'), ['51', '51%', '51%', '51%']);
  assert.equal(await page.evaluate(() => window.kitPage.model.roundness), 51);
  await page.keyboard.down('ArrowUp');
  assert.deepEqual(await readout('52'), ['52', '52%', '52%', '52%'], 'held keys update the readout before the edit ends');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowUp');
  assert.deepEqual(await readout('51'), ['51', '51%', '51%', '51%'], 'Escape rolls the readout back with the value');
  pass('A keyed slider\'s readout follows keyboard steps and Escape rollback');

  // Collections are one tab stop; the arrow keys move inside.
  await page.focus('[data-section="colours"] .ui-swatch[tabindex="0"]');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-section="colours"] .ui-swatch')];
    return [items.indexOf(document.activeElement), items.map(item => item.tabIndex)];
  }), [1, [-1, 0, -1]]);
  pass('A swatch collection is one tab stop and the arrow keys move inside it');

  // The "more below" fade follows the scroll position.
  await inPage('The body fades its last line while more is below', () => {
    const {root, installed} = window.kitPage;
    root.style.maxBlockSize = '300px'; root.style.overflow = 'auto';
    installed.sync();
    const faded = root.hasAttribute('data-more-below') && getComputedStyle(root).maskImage !== 'none';
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event('scroll'));
    const bottom = !root.hasAttribute('data-more-below');
    root.style.maxBlockSize = ''; root.style.overflow = ''; root.scrollTop = 0; installed.sync();
    return faded && bottom && !root.hasAttribute('data-more-below');
  });

  // Styles: rest states from the tokens.
  await inPage('Fields are 36px sunken boxes with no ring at rest; a switch is 32×18; the unit follows its value', () => {
    const {root} = window.kitPage, field = root.querySelector('.ui-field[data-property-row="root_x"]'), style = getComputedStyle(field);
    const box = style.blockSize === '36px' && style.boxShadow.startsWith('rgba(0, 0, 0, 0)') && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
    const sw = getComputedStyle(root.querySelector('#node-is-ik'));
    const suffix = root.querySelector('[data-property-row="root_x"] .ui-field-suffix').getBoundingClientRect(), value = root.querySelector('input[data-property="root_x"]').getBoundingClientRect();
    return box && sw.inlineSize === '32px' && sw.blockSize === '18px' && suffix.left - value.right < 8 && suffix.left >= value.right - 1;
  });

  // Containment at the docked widths: every field keeps its whole value and its buttons inside it.
  for (const width of WIDTHS) {
    const cut = await page.evaluate(width => {
      const {root, model, render} = window.kitPage;
      model.mixed = false; model.figure_z_order = -12; render();
      root.style.inlineSize = `${width}px`;
      const shown = element => element.getClientRects().length > 0;
      const problems = [];
      for (const element of root.querySelectorAll('.ui-field, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]), select')) {
        if (!shown(element)) continue;
        if (element.scrollWidth > element.clientWidth + 0.5) problems.push(`${element.className || element.id || element.dataset.property}: ${element.scrollWidth} > ${element.clientWidth}`);
      }
      const order = root.querySelector('.ui-field[data-steps]').getBoundingClientRect(), up = root.querySelector('[data-action="layer-up"]').getBoundingClientRect();
      if (up.right > order.right + 0.5) problems.push(`Bring forward spills ${up.right - order.right}px past the Order field`);
      const value = root.querySelector('input[data-property="figure_z_order"]');
      if (value.value !== '-12') problems.push(`the Order value reads ${value.value}`);
      return problems;
    }, width);
    assert.deepEqual(cut, [], `${width}px: fields keep their values and buttons inside`);
    pass(`At ${width}px every field keeps its whole value and its buttons inside`);
  }
  await page.evaluate(() => { window.kitPage.root.style.inlineSize = '256px'; });

  // Scrubbing with the pointer and Shift: a 20px drag moves the value 2 (×0.1).
  await page.evaluate(async () => {
    const {root, controls, installed, kit} = window.kitPage;
    controls.destroy(); installed.destroy();
    const {PropertyControls} = await import('/src/property-controls.mjs');
    window.kitScrub = [];
    window.kitPage.scrub = new PropertyControls(root, {begin: payload => payload.key, commit: payload => window.kitScrub.push([payload.key, payload.value])});
    window.kitPage.installed = kit.installInspectorKit(root, {});
  });
  const label = page.locator('[data-property-row="scale"] .ui-field-label');
  const box = await label.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let dx = 4; dx <= 24; dx += 4) await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const scrub = await page.evaluate(() => window.kitScrub);
  assert.equal(scrub.length, 1, 'one committed scrub');
  assert.equal(scrub[0][0], 'scale');
  assert.ok(scrub[0][1] > 100 && scrub[0][1] <= 102.4 + 1e-9, `Shift scrubs finely: ${scrub[0][1]}`);
  pass('Scrubbing a label with Shift moves the value in tenths');
  if (shot) {
    await page.evaluate(() => { for (const toggle of document.querySelectorAll('#inspector .ui-section-toggle[aria-expanded="false"]')) toggle.click(); });
    await page.locator('#inspector').screenshot({path: shot});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.locator('#inspector').screenshot({path: shot.replace(/(\.png)?$/i, '-dark.png')});
    console.log(`Saved ${shot} and its dark twin`);
  }
  assert.equal(passed.length, 19);
} finally { await browser.close(); }
