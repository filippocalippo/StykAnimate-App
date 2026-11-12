import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {builderFixture} from './support/builder-fixture.mjs';
const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47841');
  await page.waitForFunction(() => window.styk?.ready);
  const report = builderFixture(4);
  report.figure_types[0].segments.forEach((s, i) => {s.parent_id = [0,1,1,1][i]; s.length = 90; s.angle_rad = [-1.5,-.7,.5,1][i]; s.thickness = 5;});
  report.keyframes[0].objects[0].angles = report.figure_types[0].segments.map(s => s.angle_rad);
  await page.evaluate(report => {styk.editor.load(report); styk.editor.select(1, -1); styk.actions['zoom-selection']();}, report);
  for (const [axis, action] of [['horizontal','mirror'], ['vertical','mirror-vertical']]) {
    for (const joint of [1, -1]) {
      const result = await page.evaluate(({joint, action}) => {
        const e = styk.editor; e.select(1, joint);
        const before = [...e.object.angles]; styk.actions[action]();
        return {before, after: [...e.object.angles]};
      }, {joint, action});
      result.before.forEach((angle, i) => assert.ok(Math.abs(result.after[i] - (joint === -1 || i === joint ? axis === 'horizontal' ? Math.PI - angle : -angle : angle)) < 1e-6));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await mkdir('artifacts/selection-flip', {recursive:true});
      await page.screenshot({path:`artifacts/selection-flip/${axis}-${joint === -1 ? 'root' : 'part'}.png`});
      await page.evaluate(() => styk.editor.undo());
    }
  }
  console.log('PASS: app horizontal/vertical actions respect part and root selection.');
} finally {await browser.close();}
