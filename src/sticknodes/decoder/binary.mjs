import {DecodeError,asBytes} from './decoder.mjs';
export const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export function colorAt(b,o){const [a,bl,g,r]=b.subarray(o,o+4);return {r,g,b:bl,a,hex:'#'+[r,g,bl,a].map(x=>x.toString(16).padStart(2,'0')).join('')};}
export class BinaryReader {
 constructor(input,offset=0){this.bytes=asBytes(input);this.view=new DataView(this.bytes.buffer,this.bytes.byteOffset,this.bytes.length);this.offset=offset;}
 fail(code,message,path='',at=this.offset){throw new DecodeError(code,message,at,path);}
 need(n,path=''){if(!Number.isSafeInteger(n)||n<0||this.offset+n>this.bytes.length)this.fail('TRUNCATED',`Need ${n} bytes at ${this.offset}; ${this.bytes.length-this.offset} remain.`,path);}
 skip(n,path=''){this.need(n,path);const s=this.offset;this.offset+=n;return {start:s,end:this.offset};}
 i32(){this.need(4);let v=this.view.getInt32(this.offset);this.offset+=4;return v;}
 i8(){this.need(1);return this.view.getInt8(this.offset++);}
 i16(){this.need(2);const v=this.view.getInt16(this.offset);this.offset+=2;return v;}
 u8(){this.need(1);return this.bytes[this.offset++];}
 flag(){let v=this.u8();if(v>1)this.fail('NON_CANONICAL_BOOL',`Expected 0 or 1; got ${v}.`,'',this.offset-1);return v===1;}
 f32(){this.need(4);let v=this.view.getFloat32(this.offset);this.offset+=4;if(!Number.isFinite(v))this.fail('NON_FINITE','Non-finite floating point number.','',this.offset-4);return v;}
 color(){this.need(4);const c=colorAt(this.bytes,this.offset);this.offset+=4;return c;}
 count(path,max=100000){const p=this.offset;let n=this.i32();if(n<0||n>max)this.fail('COUNT_LIMIT',`${path}: ${n} outside 0..${max}.`,path,p);return n;}
 string(path='string'){let n=this.count(path+'.byteLength',1048576);this.need(n,path);const s=this.offset;this.offset+=n;try{return new TextDecoder('utf-8',{fatal:true}).decode(this.bytes.subarray(s,s+n));}catch{this.fail('INVALID_UTF8',`Invalid UTF-8 in ${path}`,path,s);}}
 raw(n){const r=this.skip(n);return {range:r,hex:hex(this.bytes.subarray(r.start,r.end)),status:'preserved-uninterpreted'};}
}
export const range=(start,end)=>({start,end});
export function f32At(b,o){const v=new DataView(b.buffer,b.byteOffset,b.length).getFloat32(o);if(!Number.isFinite(v))throw new DecodeError('NON_FINITE','Non-finite float',o);return v;}
export const i32At=(b,o)=>new DataView(b.buffer,b.byteOffset,b.length).getInt32(o);
