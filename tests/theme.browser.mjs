import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const base=process.env.STYK_TEST_URL || 'http://127.0.0.1:47831';
const output=path.resolve('artifacts/themes');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});
page.setDefaultTimeout(10000);
const errors=[], checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const check=(label,passed)=>{assert.ok(passed,label);checks.push(label);console.log('PASS',label);};
const shot=name=>page.screenshot({path:path.join(output,name+'.png')});
const ready=()=>page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const openSettings=()=>page.keyboard.press('Control+,');
const closeSettings=()=>page.locator('.styk-settings-head button').click();
const theme=()=>page.locator('html').getAttribute('data-theme');
// The artboard with only the canvases: the chrome floating over it (view controls, badges) follows the theme.
// The floating tool bar's shadow reaches over the artboard's edge; only the artwork is compared.
const artwork=clip=>page.screenshot({clip,style:'#viewport>:not(#artboard,canvas),.artboard-name,.shell-rail{visibility:hidden!important}'});
const background=selector=>page.locator(selector).evaluate(el=>getComputedStyle(el).backgroundColor);

async function readable(selector) {
  return page.locator(selector).first().evaluate(el=>{
    const rgb=value=>(value.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
    const luminance=values=>values.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    let ancestor=el,bg;
    while(ancestor){bg=getComputedStyle(ancestor).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)')break;ancestor=ancestor.parentElement;}
    const a=luminance(rgb(getComputedStyle(el).color)), b=luminance(rgb(bg));
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
  });
}

try {
  await page.goto(base);await ready();await settle();
  check('Default system theme follows a light OS',await theme()==='light');
  await openSettings();
  check('System is selected by default',await page.getByRole('radio',{name:'System',exact:true}).isChecked());
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  check('System theme responds to OS changes',await theme()==='dark');
  await page.evaluate(()=>styk.settingsUI.flush());
  await page.reload();await ready();
  check('System follows the OS after reload',await theme()==='dark');
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  const model=await page.evaluate(()=>JSON.stringify(styk.editor.report));
  const dirty=await page.evaluate(()=>styk.editor.dirty);
  const stage=await page.locator('#artboard').boundingBox();
  const lightArtwork=await artwork(stage);
  await shot('editor-light');
  await openSettings();
  await page.getByRole('radio',{name:'Dark',exact:true}).check();
  check('Settings immediately applies dark mode',await theme()==='dark');
  await page.emulateMedia({colorScheme:'dark'});
  await page.emulateMedia({colorScheme:'light'});
  check('Explicit dark choice overrides the OS',await theme()==='dark');
  check('Native form controls use the selected scheme',await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme)==='dark');
  check('Settings and helper text have readable contrast',await readable('.styk-settings-head h2') && await readable('.styk-settings-hint'));
  await shot('settings-dark');
  await page.getByRole('radio',{name:'Dark',exact:true}).press('ArrowLeft');
  check('Theme control supports the keyboard',await theme()==='light');
  await page.getByRole('radio',{name:'Light',exact:true}).press('ArrowRight');
  check('Keyboard selection restores dark mode',await theme()==='dark');
  check('Keyboard focus stays visible',await page.locator('[data-setting=theme]:checked').evaluate(el=>getComputedStyle(el.closest('label')).outlineStyle)==='solid');
  for(const tab of ['canvas','animation','shortcuts']) {
    await page.locator(`.styk-settings [data-tab=${tab}]`).click();await shot('settings-'+tab+'-dark');
  }
  await closeSettings();await page.mouse.move(1,1);await settle();
  check('Canvas timeline repaints its cached palette',await page.evaluate(()=>styk.timeline.colors.surface==='#15161c' && styk.timeline.colors['scene-tint']==='#231f3d'));
  check('Animation data and dirty state are unchanged',await page.evaluate(({model,dirty})=>JSON.stringify(styk.editor.report)===model && styk.editor.dirty===dirty,{model,dirty}));
  check('Rendered artwork is pixel-identical in both themes',lightArtwork.equals(await artwork(stage)));
  // The panels are islands on the window's field: the stage, the inspector and the timeline are
  // surfaces, and the tool bar floats beside the canvas on the raised surface.
  for(const selector of ['.titlebar','.right-panel > [data-island="right-0"]','.shell-stage','.layer-timeline'])
    check(selector+' uses the dark palette',await background(selector)==='rgb(21, 22, 28)');
  const field=(await background('.workspace')).match(/\d+/g).slice(0,3).map(Number);
  check('The tool bar floats on the dark raised surface',await background('.studio-rail')==='rgb(27, 28, 35)'&&field.every(channel=>channel<32));
  await shot('editor-dark');
  await page.evaluate(()=>styk.settingsUI.flush());
  check('Dark mode is stored with editor preferences',await page.evaluate(()=>JSON.parse(localStorage.getItem('stykanimate.editor.settings.v1')).theme==='dark'));
  await page.reload();await ready();
  check('Dark mode survives reload',await theme()==='dark');

  // Delay the app graph to prove startup restoration is independent of init().
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/src/app.mjs',async route=>{await gate;await route.continue();});
  await page.goto(base,{waitUntil:'commit'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  check('Saved dark mode is applied before app initialization',await page.evaluate(()=>!window.styk?.ready));
  release();await ready();await page.unroute('**/src/app.mjs');

  await page.getByRole('tab',{name:'Library',exact:true}).click();
  check('Library surface follows dark mode',await background('#user-library')==='rgb(21, 22, 28)');
  await shot('library-dark');
  await page.getByRole('tab',{name:'Properties',exact:true}).click();
  await page.locator('#onion-settings-button').click();
  check('Onion popover follows dark mode (the kit popover surface)',await background('.onion-popover')==='rgb(27, 28, 35)');
  await shot('onion-dark');await page.keyboard.press('Escape');
  await page.locator('[data-action=export]').first().click();
  check('Export dialog follows dark mode (the kit dialog surface)',await background('#export-dialog')==='rgb(27, 28, 35)');
  await shot('export-dark');await page.keyboard.press('Escape');

  await page.evaluate(async()=>{
    const {openColorPicker}=await import('/src/color-picker.mjs');
    openColorPicker({anchor:document.querySelector('.titlebar'),paint:{type:'solid',stops:[{offset:0,color:[43,43,43],opacity:1}]},onChange:()=>{}});
  });
  check('Color picker chrome follows dark mode',await background('.paint-picker')==='rgb(21, 22, 28)');
  const darkGradients=await page.locator('.paint-sv, .paint-sliders [data-hue]').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).backgroundImage));
  await shot('paint-dark');
  await page.evaluate(()=>styk.settingsUI.commit({theme:'light'}));
  const lightGradients=await page.locator('.paint-sv, .paint-sliders [data-hue]').evaluateAll(nodes=>nodes.map(el=>getComputedStyle(el).backgroundImage));
  check('Color selection gradients keep their actual colors',JSON.stringify(darkGradients)===JSON.stringify(lightGradients));
  await page.keyboard.press('Escape');
  await page.evaluate(()=>styk.settingsUI.commit({theme:'dark'}));

  await openSettings();
  await page.locator('[data-setting=timelineMode][value=simple]').check();
  await closeSettings();await settle();
  check('Simple timeline uses the dark palette',await background('.sheet-filmstrip')==='rgb(21, 22, 28)');
  await shot('simple-timeline-dark');
  await openSettings();
  await page.setViewportSize({width:1000,height:680});
  check('Settings fits the compact desktop window',await page.locator('.styk-settings').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await shot('settings-compact-dark');
  await page.getByRole('radio',{name:'Light',exact:true}).check();
  await page.locator('[data-setting=timelineMode][value=advanced]').check();
  await closeSettings();await page.evaluate(()=>styk.settingsUI.flush());
  await page.reload();await ready();
  check('Light mode survives reload and restores the timeline palette',await theme()==='light' && await page.evaluate(()=>styk.timeline.colors.surface==='#ffffff'));
  check('No browser errors',errors.length===0);
  await writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
