import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
// Saving an effect as a preset, finding it in My presets, adding it to another
// figure, renaming and deleting it, and finding it again after a reload.
const out='artifacts/vfx-user-presets';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));
const check=(name,value)=>{assert.ok(value,name);console.log('PASS',name);};
const ready=async()=>{await page.waitForFunction(()=>window.styk?.ready);await page.evaluate(async()=>{const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),r=emptyDocument(),f=r.figure_types[0];r.keyframes=[createFrame([createObject(f,1,200,200),createObject(f,2,500,200)],24)];styk.editor.load(r);styk.editor.select(1);});await page.getByRole('tab',{name:'VFX',exact:true}).click();};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.evaluate(()=>localStorage.removeItem('stykanimate.vfx-presets.v1'));await page.reload();await ready();
  await page.getByRole('button',{name:'Add Glow',exact:true}).click();
  await page.locator('.vfx-detail').getByRole('button',{name:'Combine with another effect',exact:true}).click();await page.locator('.vfx-catalog [data-choice="blur"]').click();
  const save=page.locator('.vfx-detail').getByRole('button',{name:'Save as preset',exact:true});
  check('Save as preset is in view under the effect’s settings',await save.isVisible());
  await save.click();
  const dialog=page.getByRole('dialog',{name:'Save as preset'});await dialog.waitFor();
  check('the name starts as the effect’s name',await dialog.getByLabel('Name').inputValue()==='Glow');
  await page.screenshot({path:`${out}/save-dialog.png`});
  await dialog.getByLabel('Name').fill('Hero glow');await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('.vfx-save-preset[data-saved]').waitFor();
  check('saving says so in place',(await page.locator('.vfx-save-preset').textContent()).includes('Saved to My presets'));
  check('the preset is written',await page.evaluate(()=>JSON.parse(localStorage.getItem('stykanimate.vfx-presets.v1')).presets[0].name==='Hero glow'));
  const undo=await page.evaluate(()=>styk.editor._undo.length);
  // Another figure: the preset is one of the suggestions and first in the Presets catalogue.
  await page.evaluate(()=>styk.editor.select(2));
  check('an empty figure suggests My presets first',await page.locator('.vfx-suggestion').first().getAttribute('aria-label')==='Add Hero glow');
  await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  const card=page.locator('.vfx-my-presets-section [data-choice^="mine:"]');
  check('Presets starts with My presets',await card.count()===1&&(await card.textContent()).includes('Hero glow'));
  await page.screenshot({path:`${out}/catalogue.png`});
  await card.click();
  check('choosing it adds the whole group to this figure as one undo step',await page.evaluate(u=>{const e=styk.editor,c=e.getVfxClips({kind:'figure',uid:2});return c.length===1&&c[0].name==='Hero glow'&&c[0].effects.map(x=>x.type).join()==='glow,blur'&&e._undo.length===u+1;},undo));
  // Rename and delete from the card's ⋯.
  await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  await page.locator('.vfx-my-preset').hover();await page.getByRole('button',{name:'Hero glow preset actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Rename…',exact:true}).click();
  const rename=page.getByRole('dialog',{name:'Rename preset'});await rename.getByLabel('Name').fill('Hero aura');await rename.getByRole('button',{name:'Rename',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('stykanimate.vfx-presets.v1')).presets[0]?.name==='Hero aura');
  check('rename keeps the preset and writes the new name',true);
  await page.reload();await ready();
  await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  check('presets survive a reload',(await page.locator('.vfx-my-presets-section').textContent()).includes('Hero aura'));
  await page.locator('.vfx-my-preset').click({button:'right'});await page.getByRole('menuitem',{name:'Delete…',exact:true}).click();
  await page.getByRole('dialog',{name:'Delete “Hero aura”?'}).getByRole('button',{name:'Delete',exact:true}).click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('stykanimate.vfx-presets.v1')).presets.length===0);
  await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  check('with no presets, My presets explains how to make one',await page.locator('.vfx-my-presets-empty').isVisible());
  await page.screenshot({path:`${out}/empty.png`});
  check('no uncaught browser errors',!errors.length);
}finally{await browser.close();}
if(errors.length)console.error(errors.join('\n'));
