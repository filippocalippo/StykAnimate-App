// Usage: node scripts/benchmark-spatial-posing.browser.mjs <served-document.json> <IK-joint-name>
// The document is loaded locally through STYK_URL; no project data leaves the app.
import {chromium} from '../tests/support/playwright.mjs';
const [fixture, joint] = process.argv.slice(2);
if (!fixture || !joint) throw new Error('Provide a served JSON document path and the name of its IK joint.');
const browser = await chromium.launch({channel:'chrome', headless:true});
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.STYK_URL ?? 'http://127.0.0.1:47861'}/tests/fixtures/blank.html`);
  const result = await page.evaluate(async ({fixture, joint}) => {
    const {Editor} = await import('/src/editor.mjs');
    const {drawGeometry, buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {objectBounds} = await import('/src/renderer-geometry.mjs');
    const response = await fetch(fixture);
    if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
    const doc = await response.json(), editor = new Editor({demo:false});
    editor.load(doc);
    const index = editor.figure.segments.findIndex(s => s.name === joint);
    if (index < 0) throw new Error('The requested joint is missing.');
    editor.select(editor.object.unique_id, index);
    const geometry = editor.geometry.objects.get(0), point = {...geometry.segments[index].end};
    const ctx = new OffscreenCanvas(900,1000).getContext('2d'), samples = [], fresh = [];
    editor.beginDrag('Performance sample');
    for (let i=0;i<150;i++) {
      const start = performance.now();
      editor.poseIKTarget(point.x+25*Math.sin(i*.08),point.y-25+20*Math.cos(i*.08));
      const g=editor.geometry, evaluated=performance.now();
      objectBounds(g.drawables);
      const bounded=performance.now();
      ctx.clearRect(0,0,900,1000);drawGeometry(ctx,g);
      const end=performance.now();
      if (i>=30) samples.push({geometry:evaluated-start,bounds:bounded-evaluated,paint:end-bounded,total:end-start});
      if (i%10===0) await new Promise(resolve=>setTimeout(resolve,0));
    }
    editor.cancelDrag();
    for (let i=0;i<40;i++) {
      const start=performance.now(),g=buildGeometry(doc,doc.keyframes[0]);
      ctx.clearRect(0,0,900,1000);drawGeometry(ctx,g);
      if (i>=10) fresh.push(performance.now()-start);
    }
    const stats=values=>{values.sort((a,b)=>a-b);return{medianMs:values[values.length>>1],p95Ms:values[Math.floor(values.length*.95)]};};
    return {nodes:geometry.segments.length,faces:geometry.polys.length,canvas:[900,1000],
      drag:Object.fromEntries(Object.keys(samples[0]).map(k=>[k,stats(samples.map(s=>s[k]))])),freshFrame:stats(fresh),
      scope:'Command, evaluated geometry, bounds and Canvas depth rendering; excludes compositor scheduling and playback cache delivery.'};
  }, {fixture,joint});
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); }
