import {asBytes,DecodeError,LIMITS,inflateBytes} from './decoder.mjs';
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(input){let c=0xffffffff;for(const v of asBytes(input))c=CRC_TABLE[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function isZip(input){const b=asBytes(input);return b.length>=4&&b[0]===80&&b[1]===75&&((b[2]===3&&b[3]===4)||(b[2]===5&&b[3]===6));}
/** Restricted ZIP reader. No files are written; names and CRC are validated. */
export async function unpackZip(input,{signal,maxOutputBytes=64*1024*1024}={}){
  signal?.throwIfAborted();if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>64*1024*1024)throw new RangeError('Archive output budget must be in 1..67108864 bytes.');
  const b=asBytes(input);if(b.length>LIMITS.inputBytes)throw new DecodeError('ZIP_SIZE','Archivio oltre 32 MiB.');
  const v=new DataView(b.buffer,b.byteOffset,b.length),need=(o,n)=>{if(o<0||n<0||o+n>b.length)throw new DecodeError('ZIP_TRUNCATED','Archivio ZIP troncato.',o);};
  let eocd=-1;
  for(let o=b.length-22;o>=Math.max(0,b.length-65557);o--)if(v.getUint32(o,true)===0x06054b50&&o+22+v.getUint16(o+20,true)===b.length){eocd=o;break;}
  if(eocd<0)throw new DecodeError('ZIP_DIRECTORY','Directory ZIP non trovata.');
  if(v.getUint16(eocd+4,true)!==0||v.getUint16(eocd+6,true)!==0)throw new DecodeError('ZIP_MULTIDISK','ZIP multidisco non supportato.');
  const count=v.getUint16(eocd+10,true),size=v.getUint32(eocd+12,true),offset=v.getUint32(eocd+16,true);
  if(count===65535||offset===0xffffffff||size===0xffffffff)throw new DecodeError('ZIP64','ZIP64 non supportato.');
  if(count>LIMITS.archiveEntries)throw new DecodeError('ZIP_COUNT','Troppi elementi nell’archivio.');
  need(offset,size);if(offset+size>eocd)throw new DecodeError('ZIP_DIRECTORY','Directory ZIP fuori intervallo.');
  let o=offset,total=0;const records=[],names=new Set();
  for(let i=0;i<count;i++) {
    need(o,46);if(v.getUint32(o,true)!==0x02014b50)throw new DecodeError('ZIP_ENTRY','Voce ZIP non valida.',o);
    const flags=v.getUint16(o+8,true),method=v.getUint16(o+10,true),crc=v.getUint32(o+16,true),compressed=v.getUint32(o+20,true),uncompressed=v.getUint32(o+24,true),nameLen=v.getUint16(o+28,true),extraLen=v.getUint16(o+30,true),commentLen=v.getUint16(o+32,true),localOffset=v.getUint32(o+42,true);
    need(o+46,nameLen+extraLen+commentLen);
    const name=new TextDecoder('utf-8',{fatal:false}).decode(b.subarray(o+46,o+46+nameLen));
    if(name.includes('\0')||name.startsWith('/')||/^[a-z]:/i.test(name)||name.includes('\\')||name.split('/').includes('..'))throw new DecodeError('ZIP_UNSAFE_PATH','Percorso ZIP non sicuro.',o);
    if(names.has(name))throw new DecodeError('ZIP_DUPLICATE','Nome duplicato nello ZIP.',o);names.add(name);
    if(flags&1)throw new DecodeError('ZIP_ENCRYPTED','Archivio cifrato non supportato.',o);
    if(method!==0&&method!==8)throw new DecodeError('ZIP_METHOD',`Metodo ZIP ${method} non supportato.`,o);
    total+=uncompressed;if(total>maxOutputBytes)throw new DecodeError('ZIP_OUTPUT_LIMIT','Archive exceeds its expanded byte budget.',o);
    need(localOffset,30);if(v.getUint32(localOffset,true)!==0x04034b50)throw new DecodeError('ZIP_LOCAL_HEADER','Header ZIP locale non valido.',localOffset);
    if(v.getUint16(localOffset+8,true)!==method||(v.getUint16(localOffset+6,true)&1))throw new DecodeError('ZIP_MISMATCH','Header ZIP incoerenti.',localOffset);
    const localNameLen=v.getUint16(localOffset+26,true),localExtraLen=v.getUint16(localOffset+28,true);
    const dataStart=localOffset+30+localNameLen+localExtraLen;need(dataStart,compressed);
    if(dataStart+compressed>offset)throw new DecodeError('ZIP_OVERLAP','Dati ZIP sovrapposti alla directory.',dataStart);
    const localName=b.subarray(localOffset+30,localOffset+30+localNameLen),centralName=b.subarray(o+46,o+46+nameLen);
    if(localName.length!==centralName.length||localName.some((x,i)=>x!==centralName[i]))throw new DecodeError('ZIP_NAME_MISMATCH','Nomi ZIP incoerenti.',localOffset);
    records.push({name,method,crc,compressed,uncompressed,dataStart});o+=46+nameLen+extraLen+commentLen;
  }
  if(o!==offset+size)throw new DecodeError('ZIP_DIRECTORY_SIZE','Lunghezza directory ZIP incoerente.',o);
  const files=[];
  for(const r of records) {
    signal?.throwIfAborted();
    if(r.name.endsWith('/'))continue;
    const raw=b.subarray(r.dataStart,r.dataStart+r.compressed);
    const data=r.method===0?raw.slice():await inflateBytes(raw,'deflate-raw',Math.max(1,r.uncompressed));
    if(data.length!==r.uncompressed||crc32(data)!==r.crc)throw new DecodeError('ZIP_INTEGRITY',`Controllo CRC/dimensione fallito: ${r.name}`,r.dataStart);
    files.push({name:r.name,bytes:data,compressedBytes:r.compressed});
  }
  return files;
}
