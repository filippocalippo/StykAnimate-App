/** Persisted import extensions are validated on native save/reopen as well. */
const kinds=new Set(['segment','rounded-segment','circle','triangle','filled-circle','ellipse','trapezoid','polygon']);
const finite=(v,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12)throw new Error(`Invalid Stick Nodes ${label}.`);};
export function validateSticknodesShape(shape){
 if(!shape||typeof shape!=='object'||Array.isArray(shape)||!kinds.has(shape.kind))throw new Error('Invalid Stick Nodes shape.');
 for(const k of ['sagitta','drawRatio','drawLength','trapezoid_top_thickness_ratio','trapezoid_thickness_start','trapezoid_thickness_end','right_triangle_direction'])if(shape[k]!==undefined)finite(shape[k],k);
 if(shape.num_polygon_vertices!==undefined&&(!Number.isInteger(shape.num_polygon_vertices)||shape.num_polygon_vertices<0||shape.num_polygon_vertices>256))throw new Error('Invalid Stick Nodes polygon vertex count.');
 if(shape.outline!==undefined&&(!Array.isArray(shape.outline)||shape.outline.length!==3||shape.outline.some(n=>!Number.isInteger(n)||n<0||n>255)))throw new Error('Invalid Stick Nodes outline color.');
 if(shape.outlineAlpha!==undefined&&(typeof shape.outlineAlpha!=='number'||!Number.isFinite(shape.outlineAlpha)||shape.outlineAlpha<0||shape.outlineAlpha>1))throw new Error('Invalid Stick Nodes outline opacity.');
 if(shape.reversed!==undefined&&typeof shape.reversed!=='boolean')throw new Error('Invalid Stick Nodes shape orientation.');
}
export function validateSticknodesObject(obj,figure){
 if(obj._sticknodesShapes){const ids=new Set(figure.segments.map(s=>String(s.segment_id)));for(const [id,s] of Object.entries(obj._sticknodesShapes)){if(!ids.has(id))throw new Error('Stick Nodes shape refers to a missing handle.');validateSticknodesShape(s);}}
 if(obj._sticknodesSprite){for(const k of ['ratio','pivotX','pivotY'])finite(obj._sticknodesSprite[k],`sprite ${k}`);if(obj._sticknodesSprite.ratio<0)throw new Error('Invalid Stick Nodes sprite aspect ratio.');}
}
