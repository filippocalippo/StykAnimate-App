/** Construct a stress document in memory. Imported PIV bytes are never saved. */
export async function scaleBenchmarkScene(page,factor=Number(process.env.STYK_DENSE_MULTIPLIER||1)){
  if(!Number.isInteger(factor)||factor<1||factor>10)throw new Error('STYK_DENSE_MULTIPLIER must be an integer from 1 to 10.');
  if(factor===1)return;
  await page.evaluate(async factor=>{
    const e=styk.editor,report=structuredClone(e.report);
    const stride=1+Math.max(...report.keyframes.flatMap(f=>f.objects.map(o=>o.unique_id)));
    for(const frame of report.keyframes){
      const base=[...frame.objects],order=frame.object_draw_order||base.map((_,i)=>i),count=base.length;
      for(let copy=1;copy<factor;copy++)for(const original of base){
        const object=structuredClone(original);object.unique_id+=copy*stride;
        object.object_slot=frame.objects.length;object.root_x+=copy*2;object.root_y+=copy*2;
        if(object.join){object.join.target_object_slot+=copy*count;if(object.join.target_unique_id!=null)object.join.target_unique_id+=copy*stride;}
        frame.objects.push(object);
      }
      frame.object_draw_order=Array.from({length:factor},(_,copy)=>order.map(slot=>slot+copy*count)).flat();
      frame.object_draw_order_unique_ids=frame.object_draw_order.map(slot=>frame.objects[slot].unique_id);
    }
    await e.loadAsync(report,`${e.name}-${factor}x`);e.markSaved();styk.fit();
    window.dispatchEvent(new Event('resize'));
  },factor);
  await page.waitForTimeout(600);
}
