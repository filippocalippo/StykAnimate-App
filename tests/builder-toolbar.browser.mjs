// Build's commands where the selection is (revision 5: no second toolbar row). A part's tiles in Properties
// (Split, Duplicate, Flip H, Flip V, Delete; Shift reaches the branch), its ⋯ menu (Exact values, Set as origin,
// Appearance, Arrange ▸, Branch ▸, Rig ▸, Attach image, Remove joint, Delete part), the Edit joints tool's Drag in
// the stage header, Build's labelled view toggles (Handles, Highlight), the rail's quick actions (Whole branch, Split,
// Duplicate branch, Flip branch, Delete part; 8200cf0f replaced its Smart snapping, Isolate and Fit figure toggles) and
// Structure's strip (Smart snapping, Fit figure).
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
const out='artifacts/builder-toolbar';await mkdir(out,{recursive:true});
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const serialize=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
const row=name=>page.getByRole('menuitem',{name,exact:true});
page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
 await page.locator('[data-workspace-mode="rig"]').click();await settle();
 // No second row: nothing sits between the stage header and the canvas; Test rig and Done sit in the band.
 assert.equal(await page.locator('#builder-bar').count(),0);
 for(const selector of ['.titlebar [data-action="rig-test"]','#builder-done','.titlebar [data-action="export"]'])assert.equal(await page.locator(selector).isVisible(),true,selector);
 // The figure itself: its tiles add an image part, open the examples and fit it.
 assert.deepEqual(await page.locator('.ui-quick button').evaluateAll(list=>list.map(b=>b.dataset.action)),['add-sprite-segment','rig-examples','rig-connect','zoom-selection']);
 // The Edit joints tool's option: Drag. Whole branch and the part commands are the rail's quick actions, under the tools.
 assert.equal(await page.locator('.stage-head #rig-mode').inputValue(),'move');
 assert.equal(await page.locator('.stage-head [data-action="toggle-builder-branch"]').count(),0);
 assert.deepEqual(await page.locator('.rail-quick button').evaluateAll(list=>list.map(b=>[b.dataset.action,b.getAttribute('aria-pressed')])),
  [['toggle-builder-branch','false'],['split-segment',null],['duplicate-branch',null],['mirror-branch',null],['mirror-branch-vertical',null],['delete-single-segment',null]]);
 // Smart snapping is a one-click action in Structure's folded strip, which mirrors Structure's own Snap button.
 const snap=page.locator('.shell-strip-action[aria-label="Smart snapping"]');
 assert.equal(await snap.getAttribute('aria-pressed'),'true');
 await snap.click();await settle();
 assert.equal(await snap.getAttribute('aria-pressed'),'false');
 assert.equal(await page.locator('#builder-snap').getAttribute('aria-pressed'),'false','Structure\'s Snap shows the same state');
 await snap.click();await settle();
 assert.equal(await snap.getAttribute('aria-pressed'),'true');
 // Build's view toggles have words.
 for(const [action,word] of [['builder-static-handles','Handles'],['builder-highlight','Highlight']])
  assert.equal((await page.locator(`.stage-head [data-action="${action}"]`).textContent()).trim(),word);
 // A part: its name as Structure names it, and its tiles. Structure starts folded to its strip.
 assert.equal(await page.locator('#builder-outliner').isVisible(),false);
 await page.evaluate(()=>styk.editor.select(styk.editor.selectedUid,0));await settle();
 assert.equal((await page.locator('#inspector-name .ui-target-text').textContent()).trim(),await page.evaluate(()=>styk.editor.figure.segments[0].name));
 // Whole branch from the rail: the scope line names what an edit reaches, and B turns it off again.
 await page.locator('.rail-quick [data-action="toggle-builder-branch"]').click();await settle();
 assert.equal(await page.locator('.rail-quick [data-action="toggle-builder-branch"]').getAttribute('aria-pressed'),'true');
 assert.match(await page.locator('#inspector-scope').textContent(),/Editing the whole branch · \d+ parts/);
 await page.locator('#viewport').focus();await page.keyboard.press('b');await settle();
 assert.equal(await page.locator('.rail-quick [data-action="toggle-builder-branch"]').getAttribute('aria-pressed'),'false');
 assert.equal(await page.locator('#inspector-scope').isVisible(),false);
 assert.deepEqual(await page.locator('.ui-quick button').evaluateAll(list=>list.map(b=>b.dataset.action)),
  ['split-segment','duplicate-segment','mirror-segment','mirror-segment-vertical','delete-single-segment']);
 assert.deepEqual(await page.locator('.ui-quick button').evaluateAll(list=>list.map(b=>b.dataset.shiftAction??'')),
  ['','duplicate-branch','mirror-branch','mirror-branch-vertical','delete-segment']);
 const baseline=await serialize();
 await page.locator('.ui-quick [data-action="mirror-segment-vertical"]').click();await settle();
 assert.notEqual(await serialize(),baseline);
 await page.keyboard.press('Control+z');await settle();assert.equal(await serialize(),baseline);
 // The ⋯ menu: groups, submenus, and what removes something last.
 await page.locator('#object-actions').click();await settle();
 const items=await page.locator('.ui-menu:visible [role^="menuitem"]').evaluateAll(list=>list.map(b=>b.querySelector('span')?.textContent.trim()));
 assert.deepEqual(items,['Exact values…','Set as origin','Copy appearance','Paste appearance','Arrange','Branch','Rig','Attach image…','Remove joint, keep ends','Delete part']);
 assert.equal(await row('Paste appearance').isDisabled(),true);
 await row('Arrange').click();await settle();
 assert.equal(await row('Send to back').isVisible(),true);
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');await settle();
 assert.equal(await serialize(),baseline);
 await page.locator('#object-actions').click();await settle();await row('Exact values…').click();await settle();
 assert.equal(await page.locator('#dialog').evaluate(e=>e.open),true);
 await page.keyboard.press('Escape');await settle();
 // A view toggle changes the view, not the figure.
 const handles=page.locator('.stage-head [data-action="builder-static-handles"]'),before=await handles.getAttribute('aria-pressed');
 await handles.click();await settle();assert.notEqual(await handles.getAttribute('aria-pressed'),before);
 await handles.click();await settle();assert.equal(await handles.getAttribute('aria-pressed'),before);
 assert.equal(await serialize(),baseline);
 await page.screenshot({path:`${out}/desktop.png`});
 // A narrow stage keeps every toggle, folding the words to glyphs.
 await page.setViewportSize({width:1000,height:760});await settle();await settle();
 assert.equal(await page.locator('.stage-head [data-action="builder-highlight"] .ui-label').isVisible(),false);
 assert.equal(await page.locator('.stage-head [data-action="builder-highlight"]').isVisible(),true);
 assert.equal(await page.locator('.rail-quick [data-action="delete-single-segment"]').isVisible(),true);
 await page.screenshot({path:`${out}/compact-1000.png`});
 await page.locator('#builder-done').click();await settle();
 assert.equal(await page.evaluate(()=>styk.builder.active),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: no second row; the figure\'s and a part\'s tiles (Shift reaches the branch), the grouped ⋯ menu with submenus, Exact values, the Edit joints option, the rail\'s quick actions, snapping from Structure\'s strip, the branch scope line and Build\'s labelled view toggles, words folding in a narrow stage; no page errors.');
} finally {await browser.close();}
