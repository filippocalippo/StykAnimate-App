/** Full field equality for the user's dense animation; a correctness audit, not a timing benchmark. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {unpackNativeFrameResponse,materializeNativeFrames} from '../src/import-wire.mjs';
const app=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(app,'artifacts/import-wire-akane');await mkdir(output,{recursive:true});
const source=process.env.STYK_WIRE_SOURCE||'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const files=['validated.wire','expected-header.json','expected-frames.jsonl'].map(name=>path.join(output,name));
const script=String.raw`
import json,sys,time,hashlib
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
source=Path(sys.argv[1]); out=Path(sys.argv[2]); data=source.read_bytes()
store=server.ProjectStore(server.WORKSPACE)
wire=store.import_bytes(data,source.name,prefer_native=True,as_json=True)
(out/'validated.wire').write_bytes(wire)
doc=server.piv_codec.decode_piv_bytes(data,source_path=source.name)
for key in ['editable_paths','_codec','_stykWeb']:doc.pop(key,None)
server.compact_media_aliases(doc)
header=dict(doc);header['keyframes']=[]
(out/'expected-header.json').write_bytes(server.encoded_json(header,validated=True))
with (out/'expected-frames.jsonl').open('wb') as stream:
    for frame in doc['keyframes']:stream.write(server.encoded_json(frame,validated=True)+b'\n')
print(json.dumps({'source_sha256':hashlib.sha256(data).hexdigest(),'source_bytes':len(data),
    'wire_bytes':len(wire),'frames':len(doc['keyframes']),'objects':sum(len(f['objects']) for f in doc['keyframes'])}))
`;
const candidate=backend.pythonCandidates()[0];
try {
  const generated=await new Promise((resolve,reject)=>{
    const child=spawn(candidate.command,[...candidate.args,'-c',script,source,output],{cwd:app,windowsHide:true});let stdout='',stderr='';
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);
    child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr||`Python failed: ${code}`)));
  });
  const raw=await readFile(files[0]), buffer=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength), packet=unpackNativeFrameResponse(buffer);
  const actual=await materializeNativeFrames(packet.result,buffer,packet.offset);
  const header=JSON.parse(await readFile(files[1],'utf8'));
  assert.deepEqual({...actual.document,keyframes:[]},header);
  let index=0,objects=0;
  const lines=createInterface({input:createReadStream(files[2]),crlfDelay:Infinity});
  for await(const line of lines) {
    const expected=JSON.parse(line), frame=actual.document.keyframes[index];
    assert.deepEqual(frame,expected,`Frame ${index} has changed fields`);
    assert.equal(JSON.stringify(frame),JSON.stringify(expected),`Frame ${index} field ordering changed`);
    objects+=frame.objects.length;index++;
  }
  assert.equal(index,generated.frames);assert.equal(objects,generated.objects);
  const result={...generated,framesCompared:index,objectsCompared:objects,allFieldsExact:true,
    originalPropertyOrder:true,method:'Canonical full decoder versus native scanner wire materialized by production JS; every frame and header field.',timings:actual.timings};
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {
  for(const file of files) await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
