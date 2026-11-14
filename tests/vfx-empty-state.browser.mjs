import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
// The empty VFX panel offers one-click starting points, and the catalogue
// switches between effects and presets without closing.
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));
const check=(name,value)=>{assert.ok(value,name);console.log('PASS',name);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{const e=styk.editor;e.select(e.frame.objects[0].unique_id);});
  await page.getByRole('tab',{name:'VFX',exact:true}).click();
  check('an empty panel suggests effects and presets',await page.getByRole('button',{name:'Add Glow',exact:true}).isVisible()&&await page.getByRole('button',{name:'Add Power up',exact:true}).isVisible());
  const undo=await page.evaluate(()=>styk.editor._undo.length);
  await page.getByRole('button',{name:'Add Glow',exact:true}).click();
  check('a suggestion adds one effect clip as one undo step',await page.evaluate(u=>styk.editor.getVfxClips().length===1&&styk.editor._undo.length===u+1,undo));
  check('the new effect is shown and selected',await page.locator('.vfx-clip.is-selected').count()===1);
  check('its settings open under its own row, without repeating its name',await page.locator('.vfx-entry.is-open > .vfx-clip.is-selected + .vfx-detail').count()===1&&await page.locator('.vfx-detail h3').count()===0);
  // Combining is the usual next step, so it is a visible button at the foot of the effect's settings (a quiet word button,
  // a 24px target at least), not only in its ⋯ menu.
  const combine=page.locator('.vfx-detail').getByRole('button',{name:'Combine with another effect',exact:true});
  check('a single effect shows Combine with another effect in view under its settings',await combine.isVisible()&&await combine.evaluate(button=>{const r=button.getBoundingClientRect(),panel=button.closest('#vfx-panel')?.getBoundingClientRect()??{top:0,bottom:innerHeight};return r.height>=24&&r.top>=panel.top&&r.bottom<=panel.bottom;}));
  await combine.click();
  await page.locator('.vfx-catalog [data-choice="blur"]').click();
  check('the visible button combines another effect into a group in one step',await page.evaluate(()=>styk.editor.getVfxClips().length===1&&styk.editor.getVfxClips()[0].effects.length===2)&&await page.getByRole('button',{name:'Add to group',exact:true}).isVisible());
  await page.keyboard.press('Control+z');
  check('one undo separates them again',await page.evaluate(()=>styk.editor.getVfxClips()[0]?.effects.length===1));
  await page.locator('.vfx-clip [data-clip-action="select"]').click();
  check('clicking the open row closes its settings',await page.locator('.vfx-detail').count()===0&&await page.locator('.vfx-clip [data-clip-action="select"]').getAttribute('aria-expanded')==='false');
  await page.locator('.vfx-clip [data-clip-action="select"]').click();
  await page.getByRole('button',{name:'Effect clip actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Combine with another effect…',exact:true}).click();
  await page.locator('.vfx-catalog [data-choice="blur"]').click();
  check('the row menu combines another effect into a group',await page.evaluate(()=>styk.editor.getVfxClips().length===1&&styk.editor.getVfxClips()[0].effects.length===2)&&await page.getByRole('button',{name:'Add to group',exact:true}).isVisible());
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  check('undo removes the suggested effect',await page.evaluate(()=>styk.editor.getVfxClips().length===0));
  await page.getByRole('button',{name:'Add effect',exact:true}).click();
  await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  check('the catalogue switches to presets in place',await page.locator('.vfx-catalog [data-choice="Neon"]').isVisible()&&await page.locator('.vfx-catalog [data-catalog-mode="presets"][aria-selected="true"]').count()===1);
  await page.locator('.vfx-catalog [data-choice="Neon"]').click();
  check('choosing a preset adds a grouped clip',await page.evaluate(()=>styk.editor.getVfxClips()[0]?.effects.length===2));
  // The catalogue groups effects by what they do, the most used first, and opens Distort-like effects with Blur.
  await page.getByRole('button',{name:'Add effect',exact:true}).click();
  check('effects are grouped by what they do, generated effects first',(await page.locator('.vfx-catalog [data-catalog-group]').evaluateAll(nodes=>nodes.map(node=>node.dataset.catalogGroup))).join()==='generate,outline,color,distort,texture');
  check('outline and shadow sit with glow',(await page.locator('.vfx-catalog [data-catalog-group="outline"] [data-choice]').evaluateAll(nodes=>nodes.map(node=>node.dataset.choice))).join()==='glow,outline,shadow');
  // Reaching a card shows what it does beside the catalogue, never over it.
  await page.locator('.vfx-catalog [data-choice="glow"]').focus();
  await page.locator('.vfx-peek:popover-open').waitFor();
  check('a preview card says what an effect does before it is added',(await page.locator('.vfx-peek').innerText()).includes('A soft halo of light around the artwork.')&&await page.evaluate(()=>{const peek=document.querySelector('.vfx-peek').getBoundingClientRect(),list=document.querySelector('.vfx-catalog').getBoundingClientRect();return peek.right<=list.left||peek.left>=list.right;}));
  // A search finds a name anywhere, and what an effect does only from the start of a word: "sh" is Shadow, not Tint ("Washes").
  await page.locator('.vfx-catalog input[type=search]').fill('sh');
  check('a search finds what an effect does from the start of a word',(await page.locator('.vfx-catalog [data-choice]').evaluateAll(nodes=>nodes.map(node=>node.dataset.choice))).join()==='shadow');
  await page.locator('.vfx-catalog input[type=search]').fill('smo');
  check('a search finds an effect by what it makes',(await page.locator('.vfx-catalog [data-choice]').evaluateAll(nodes=>nodes.map(node=>node.dataset.choice))).sort().join()==='explosion,smoke');
  // A moment is placed at the playhead for its length, in the same undo step as adding it.
  await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();
  check('presets are split into moments and lasting looks',await page.locator('.vfx-catalog [data-catalog-group="moments"] [data-choice="Hit flash"]').count()===1&&await page.locator('.vfx-catalog [data-catalog-group="looks"] [data-choice="Neon"]').count()===1);
  const momentUndo=await page.evaluate(()=>{styk.editor.seek(3,{allowBeyondEnd:true});return styk.editor._undo.length;});
  await page.locator('.vfx-catalog [data-choice="Hit flash"]').click();
  check('a moment preset lasts its few frames from the playhead, with its fade, as one undo step',await page.evaluate(undo=>{const clip=styk.editor.getVfxClips().at(-1);return clip.name==='Hit flash'&&clip.start===3&&clip.duration===4&&clip.fadeOut===3&&styk.editor._undo.length===undo+1;},momentUndo));
  check('no uncaught browser errors',!errors.length);
}finally{await browser.close();}
if(errors.length)console.error(errors.join('\n'));
