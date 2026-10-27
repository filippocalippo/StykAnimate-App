import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import hostModule from '../desktop/web-host.cjs';

function request(origin,pathname='/',{method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const client=http.request(origin,{method,path:pathname,headers,agent:false},response=>{
      const chunks=[];response.on('data',data=>chunks.push(data));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    client.on('error',reject);client.end(body);
  });
}
async function fixture(t,options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'styk-web-host-')),root=path.join(directory,'web');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'index.html'),'<h1>Editor shell</h1>');
  await writeFile(path.join(root,'src','worker.mjs'),'export const ready = true;');
  await writeFile(path.join(directory,'secret.json'),'private');
  const host=await hostModule.startDesktopHost({appRoot:root,...options});
  t.after(async()=>{await host.stop();await rm(directory,{recursive:true,force:true});});
  return {host,root,directory};
}

test('static shell, worker modules, HEAD and revalidation are served cross-origin isolated',async t=>{
  const f=await fixture(t);
  const first=await request(f.host.origin);
  assert.equal(first.status,200);assert.equal(first.body.toString(),'<h1>Editor shell</h1>');
  assert.equal(first.headers['cache-control'],'no-cache');
  assert.equal(first.headers['cross-origin-opener-policy'],'same-origin');
  assert.equal(first.headers['cross-origin-embedder-policy'],'require-corp');
  assert.equal(first.headers['x-content-type-options'],'nosniff');
  const head=await request(f.host.origin,'/',{method:'HEAD'});
  assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],first.headers['content-length']);
  assert.equal((await request(f.host.origin,'/',{headers:{'If-None-Match':`W/${first.headers.etag}`}})).status,304);
  const module=await request(f.host.origin,'/src/worker.mjs');
  assert.equal(module.headers['content-type'],'text/javascript');
  assert.match(module.body.toString(),/ready/);
});

test('packaged host uses its web resource root and excludes development artifacts',async t=>{
  const f=await fixture(t);
  for(const directory of ['vendor','assets','tests','artifacts'])await mkdir(path.join(f.root,directory));
  await writeFile(path.join(f.root,'src','codec.wasm'),Buffer.from([0,97,115,109]));
  await writeFile(path.join(f.root,'assets','icon.svg'),'<svg/>');
  await writeFile(path.join(f.root,'tests','private.json'),'{}');
  await writeFile(path.join(f.root,'artifacts','private.json'),'{}');
  const host=await hostModule.startDesktopHost({appRoot:path.join(f.directory,'missing-app'),resourcesPath:f.directory,packaged:true});
  t.after(()=>host.stop());
  assert.equal((await request(host.origin)).status,200);
  assert.equal((await request(host.origin,'/src/codec.wasm')).headers['content-type'],'application/wasm');
  assert.equal((await request(host.origin,'/assets/icon.svg')).status,200);
  for(const pathname of ['/tests/private.json','/artifacts/private.json'])
    assert.equal((await request(host.origin,pathname)).status,403);
});

test('the host converts nothing: the former codec routes and every write are refused',async t=>{
  const f=await fixture(t);
  for(const pathname of ['/api/health','/api/samples','/api/source?id=x'])
    assert.equal((await request(f.host.origin,pathname)).status,403,pathname);
  for(const pathname of ['/api/import?filename=a.piv','/api/export','/api/cancel?id=x','/index.html']){
    const response=await request(f.host.origin,pathname,{method:'POST',headers:{'Content-Length':1},body:'x'});
    assert.equal(response.status,405,pathname);assert.equal(JSON.parse(response.body).code,'method_not_allowed');
  }
});

test('static paths reject traversal, escaped links, private files and remote origins',async t=>{
  const f=await fixture(t);
  await symlink(f.directory,path.join(f.root,'src','escape'),process.platform==='win32'?'junction':'dir');
  for(const pathname of ['/package.json','/desktop/main.cjs','/src/escape/secret.json','/src/%2e%2e/../secret.json',
    '/src/..%5csecret.json','/src/file.json:private','/.desktop-data/preferences.json']){
    const response=await request(f.host.origin,pathname);assert.equal(response.status,403,pathname);
    assert.notEqual(response.body.toString(),'private');
  }
  assert.equal((await request(f.host.origin,'/src/%xx')).status,400);
  assert.equal((await request(f.host.origin,'/',{headers:{Origin:'https://example.test'}})).status,403);
  assert.equal((await request(f.host.origin,'/',{headers:{Host:'example.test'}})).status,403);
  assert.equal((await request(f.host.origin,'/',{headers:{Origin:'null'}})).status,403);
});

test('a fixed port is honoured, as the development server needs',async t=>{
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const f=await fixture(t,{port});
  assert.equal(f.host.port,port);assert.equal(f.host.origin,`http://127.0.0.1:${port}`);
  assert.equal((await request(f.host.origin)).status,200);
});
