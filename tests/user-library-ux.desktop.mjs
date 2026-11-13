import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(), run = path.join(root, 'artifacts', `library-ux-${Date.now()}`), profile = path.join(run, 'profile');
await mkdir(profile, {recursive:true});
await writeFile(path.join(profile, 'stats-state.json'), JSON.stringify({v: 1, enabled: false, noticeSeen: true}));
const checks = [], errors = [], check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log('PASS', name); };
let app, page;
try {
  app = await electron.launch({args:[root], cwd:root, timeout:45000, env:{...process.env, STYK_USER_DATA_DIR:profile, STYK_LIBRARY_DIR:path.join(run,'library')}});
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  const welcome = page.getByRole('button', {name:'Close welcome screen'}); if (await welcome.isVisible()) await welcome.click();
  await page.evaluate(async () => {
    const {Editor} = await import('/src/editor.mjs');
    const {createDemo} = await import('/src/demo.mjs');
    const {librarySnapshot, libraryPreview, saveLibraryFile} = await import('/src/library-files.mjs');
    const {library} = window.styk;
    await library.desktop.createLibraryFolder({folder:'', name:'Characters'});
    await library.desktop.createLibraryFolder({folder:'', name:'Archive'});
    for (const [name, color, clip] of [['White walk',[255,255,255],true], ['Black figure',[0,0,0],false], ['Blue walk',[40,140,240],true]]) {
      const source = new Editor(), document = createDemo();
      document.figure_types[0].name = name;
      for (const segment of document.figure_types[0].segments) segment.color_rgb = color;
      source.load(document); source.select(1);
      if (clip) source.createMovieclip({start:0,end:24,name});
      const report = librarySnapshot(source), format = clip ? 'stykmov' : 'stkz';
      const thumbnail = await libraryPreview(report), blob = await library.exporter.export(report,{format,figureUids:report.keyframes[0].objects.map(o=>o.unique_id)});
      await saveLibraryFile(library.desktop,blob,{folder:'',name,kind:report._styk.libraryKind,extension:`.${format}`,thumbnail});
    }
    library.show();
  });
  await page.waitForSelector('[data-library-path="White walk.stykmov"] img');
  await page.waitForFunction(() => [...document.querySelectorAll('.library-card:not(.folder)')].every(card => card.dataset.matte));
  const white = page.locator('[data-library-path="White walk.stykmov"]'), black = page.locator('[data-library-path="Black figure.stkz"]');
  check('White artwork automatically uses a dark matte', await white.getAttribute('data-matte') === '#343b47');
  check('Black artwork automatically uses a light matte', await black.getAttribute('data-matte') === '#edf0f4');
  const background = async name => { await page.getByRole('button',{name:'Library options',exact:true}).click(); await page.getByRole('menuitem',{name:'Preview background'}).click(); await page.getByRole('menuitemradio',{name,exact:true}).click(); };
  await background('Dark');
  check('Manual background override applies to every artwork preview', await black.locator('.library-thumbnail').evaluate(node=>getComputedStyle(node).backgroundColor) === 'rgb(52, 59, 71)');
  await background('Automatic');
  await page.screenshot({path:path.join(run,'library-light.png')});
  await page.evaluate(async () => (await import('/src/theme.mjs')).applyEditorTheme('dark'));
  await page.screenshot({path:path.join(run,'library-dark.png')});
  await page.evaluate(async () => (await import('/src/theme.mjs')).applyEditorTheme('light'));
  const sceneBefore = await page.evaluate(()=>({tick:window.styk.editor.tick, undo:window.styk.editor._undo.length, count:window.styk.editor.selectionFrame.objects.length}));
  // Scrolling stops a preview, so the card is brought into view before hovering.
  await white.scrollIntoViewIfNeeded(); await page.waitForTimeout(250); await white.hover(); await white.locator('canvas').waitFor();
  await page.evaluate(() => {
    window.hoverFrames = [];
    const session = window.styk.library.hoverPreview.current;
    session.worker.addEventListener('message', ({data}) => {
      if (data.tick !== undefined) window.hoverFrames.push({tick:data.tick, pixels:session.canvas?.toDataURL()});
    });
  });
  await page.waitForFunction(() => window.hoverFrames.length > 18 && window.hoverFrames.some((frame,i,frames)=>i && frame.tick < frames[i-1].tick));
  const frames = await page.evaluate(()=>window.hoverFrames);
  check('Hover plays changing native animation frames and loops at clip duration', new Set(frames.map(frame=>frame.pixels)).size > 6 && frames.every(frame=>frame.tick>=0&&frame.tick<24));
  await page.screenshot({path:path.join(run,'library-hover.png')});
  await page.mouse.move(40,40);
  check('Leaving a card releases its worker and canvas', await page.evaluate(()=>!window.styk.library.hoverPreview.current) && await page.locator('.library-animation').count() === 0);
  const sceneAfter = await page.evaluate(()=>({tick:window.styk.editor.tick, undo:window.styk.editor._undo.length, count:window.styk.editor.selectionFrame.objects.length}));
  assert.deepEqual(sceneAfter,sceneBefore); check('Preview never changes the editor playhead, scene, or undo history');
  await white.click({button:'right'});
  check('Right-click selects the asset and opens its action menu', await page.getByRole('menu',{name:'Library actions'}).isVisible() && await page.evaluate(()=>window.styk.library.selected) === 'White walk.stykmov');
  await page.screenshot({path:path.join(run,'library-context-menu.png')});
  await page.keyboard.press('Escape');
  check('Escape dismisses the menu and restores keyboard focus', await white.evaluate(node=>node===document.activeElement));
  await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem',{name:'Rename'}).click();
  await page.getByRole('textbox',{name:'Asset name',exact:true}).fill('White run'); await page.keyboard.press('Enter');
  await page.locator('[data-library-path="White run.stykmov"] img').waitFor();
  check('Keyboard context menu renames the asset and retains its native extension', (await readFile(path.join(run,'library','White run.stykmov.png'))).length > 100);
  const drag = async (source, target, cancel = false) => {
    // The foot is pinned: scroll just enough that the press lands on the dragged card's preview.
    await source.evaluate(card => { const list = card.closest('.library-content'), overflow = card.getBoundingClientRect().top + 60 - list.getBoundingClientRect().bottom; if (overflow > 0) list.scrollTop += overflow; });
    const a = await source.boundingBox(), b = await target.boundingBox();
    await page.mouse.move(a.x+a.width/2,a.y+35); await page.mouse.down();
    await page.mouse.move(b.x+b.width/2,b.y+Math.min(60,b.height/2),{steps:15});
    if (cancel) await page.keyboard.press('Escape');
    else await page.waitForSelector('.library-folder-drop-target');
    await page.mouse.up();
  };
  const renamed = page.locator('[data-library-path="White run.stykmov"]'), folder = page.locator('[data-library-path="Characters"]');
  await drag(renamed,folder,true);
  check('Escape cancels folder moves', await renamed.count()===1 && await page.locator('.library-folder-drop-target').count()===0);
  await drag(renamed,folder);
  await page.waitForFunction(()=>!window.styk.library.busy&&!window.styk.library.entries.some(item=>item.name==='White run'));
  check('Folder drop moves the file and its PNG sidecar', (await readFile(path.join(run,'library','Characters','White run.stykmov.png'))).length>100);
  await folder.dblclick(); await page.locator('[data-library-path="Characters/White run.stykmov"]').waitFor();
  await drag(page.locator('[data-library-path="Characters/White run.stykmov"]'),page.locator('.library-breadcrumbs button').first());
  await page.waitForFunction(()=>!window.styk.library.busy&&window.styk.library.entries.length===0);
  await page.locator('.library-breadcrumbs button').first().click(); await page.locator('[data-library-path="White run.stykmov"]').waitFor();
  check('Breadcrumb drops move assets back to the parent library');
  await drag(page.locator('[data-library-path="Characters"]'),page.locator('[data-library-path="Archive"]'));
  await page.waitForFunction(()=>!window.styk.library.busy&&!window.styk.library.entries.some(item=>item.path==='Characters'));
  check('Folders can be reorganized with the same drag gesture');
  await page.locator('[data-library-path="White run.stykmov"]').hover(); await page.locator('.library-animation').waitFor();
  await page.getByRole('tab',{name:'Properties',exact:true}).click();
  check('Switching panels releases hover preview resources', await page.evaluate(()=>!window.styk.library.hoverPreview.current));
  await page.getByRole('tab',{name:'Library',exact:true}).click();
  check('Library has no horizontal overflow', await page.locator('#user-library').evaluate(node=>node.scrollWidth<=node.clientWidth));
  const actionButton = page.locator('[data-library-path="Black figure.stkz"] .library-more');
  await actionButton.focus(); await page.keyboard.press('Enter');
  check('Keyboard activation of the card action button opens the menu without inserting', await page.getByRole('menu',{name:'Library actions'}).isVisible() && await page.evaluate(()=>window.styk.editor.selectionFrame.objects.length) === sceneBefore.count);
  await page.getByRole('menuitem',{name:'Move to Recycle Bin'}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  check('Context-menu removal can be cancelled with the asset preserved', await black.count() === 1);
  await page.evaluate(async () => {
    const {defaultFigure, createObject, createFrame, emptyDocument} = await import('/src/demo.mjs');
    const {movieclipFigure} = await import('/src/movieclips.mjs');
    const {libraryPreview, saveLibraryFile} = await import('/src/library-files.mjs');
    const figure = defaultFigure(301), local = emptyDocument(); local.figure_types = [figure];
    local.keyframes = [0,1,2].map(frame => createFrame(Array.from({length:400},(_,i)=>createObject(figure,i+1,(i%20)*150+frame*40,Math.floor(i/20)*300)),12));
    const clip = movieclipFigure(302,'Dense crowd',local,{duration:24}), report = {...emptyDocument(),figure_types:[clip],keyframes:[createFrame([createObject(clip,1,0,0,{angles:[0],_stykMovieclip:{start:0,end:24,offset:0,speed:1,mode:'loop'}})])]};
    const library = window.styk.library, thumbnail = await libraryPreview(report), blob = await library.exporter.export(report,{format:'stykmov',figureUids:[1]});
    await saveLibraryFile(library.desktop,blob,{folder:'',name:'Dense crowd',kind:'movieclip',extension:'.stykmov',thumbnail});
    await library.refresh();
  });
  const dense = page.locator('[data-library-path="Dense crowd.stykmov"]'); await dense.locator('img').waitFor();
  await page.evaluate(() => {
    window.denseMetrics = {longTasks:[], gaps:[], started:performance.now()};
    window.denseObserver = new PerformanceObserver(list=>window.denseMetrics.longTasks.push(...list.getEntries().map(entry=>entry.duration)));
    window.denseObserver.observe({type:'longtask'});
    let last = performance.now(); window.denseTimer = setInterval(()=>{const now=performance.now();window.denseMetrics.gaps.push(now-last);last=now;},16);
  });
  await dense.hover(); await dense.locator('canvas').waitFor({timeout:30000});
  await page.waitForFunction(()=>Number(document.querySelector('[data-library-path="Dense crowd.stykmov"] canvas')?.dataset.tick)>3);
  const denseMetrics = await page.evaluate(() => {
    clearInterval(window.denseTimer);window.denseObserver.disconnect();
    return {...window.denseMetrics,elapsed:performance.now()-window.denseMetrics.started,workers:window.styk.library.hoverPreview.current.worker ? 1 : 0,canvases:document.querySelectorAll('.library-animation').length};
  });
  check('A dense 400-figure movieclip plays with only one active preview canvas', denseMetrics.workers===1&&denseMetrics.canvases===1);
  await page.screenshot({path:path.join(run,'library-dense.png')});
  await page.locator('.library-content').evaluate(node=>{node.scrollTop=node.scrollTop?0:node.scrollHeight;});
  await page.waitForFunction(()=>!window.styk.library.hoverPreview.current);
  check('Scrolling cancels a dense hover and releases the worker');
  assert.deepEqual(errors,[]); check('No browser errors');
  await writeFile(path.join(run,'evidence.json'),JSON.stringify({checks,errors,sceneBefore,sceneAfter,hoverTicks:frames.map(frame=>frame.tick),denseMetrics},null,2));
  console.log(JSON.stringify({run,checks:checks.length,errors},null,2));
} catch (error) { await page?.screenshot({path:path.join(run,'failure.png')}).catch(()=>{}); throw error; }
finally { if(app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); }
