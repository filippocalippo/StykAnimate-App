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

function appScheme(t,options={}) {
  const registered=[],handlers=new Map();
  const protocol={registerSchemesAsPrivileged:list=>registered.push(...list),handle:(scheme,handler)=>handlers.set(scheme,handler)};
  hostModule.registerAppScheme(protocol);
  return fixture(t).then(async f=>{
    const host=await hostModule.handleAppProtocol({protocol,appRoot:f.root,...options});
    const fetch=(pathname,{method='GET',headers={}}={})=>handlers.get('styk-app')(new Request(`styk-app://app${pathname}`,{method,headers}));
    return {...f,host,registered,fetch};
  });
}

test('the app scheme is privileged: a secure standard origin with the code cache',async t=>{
  const f=await appScheme(t);
  assert.equal(f.registered.length,1);
  const {scheme,privileges}=f.registered[0];
  assert.equal(scheme,'styk-app');
  for(const privilege of ['standard','secure','supportFetchAPI','corsEnabled','stream','codeCache'])assert.equal(privileges[privilege],true,privilege);
  assert.equal(f.host.origin,'styk-app://app');
});

test('the app scheme serves the shell and modules cross-origin isolated, with HEAD and revalidation',async t=>{
  const f=await appScheme(t);
  const first=await f.fetch('/');
  assert.equal(first.status,200);assert.equal(await first.text(),'<h1>Editor shell</h1>');
  assert.equal(first.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.equal(first.headers.get('cross-origin-embedder-policy'),'require-corp');
  assert.equal(first.headers.get('cross-origin-resource-policy'),'same-origin');
  const head=await f.fetch('/',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal(head.headers.get('content-length'),first.headers.get('content-length'));
  assert.equal((await f.fetch('/',{headers:{'If-None-Match':first.headers.get('etag')}})).status,304);
  const module=await f.fetch('/src/worker.mjs');
  assert.equal(module.headers.get('content-type'),'text/javascript');
  assert.match(await module.text(),/ready/);
});

test('the app scheme serves WebAssembly with its own type and leaves development artifacts out when packaged',async t=>{
  const f=await appScheme(t);
  for(const directory of ['tests','artifacts'])await mkdir(path.join(f.root,directory));
  await writeFile(path.join(f.root,'src','codec.wasm'),Buffer.from([0,97,115,109]));
  await writeFile(path.join(f.root,'tests','private.json'),'{}');
  assert.equal((await f.fetch('/src/codec.wasm')).headers.get('content-type'),'application/wasm');
  const protocol={registerSchemesAsPrivileged(){},handle:(scheme,handler)=>{protocol.handler=handler;}};
  await hostModule.handleAppProtocol({protocol,appRoot:path.join(f.directory,'missing-app'),resourcesPath:f.directory,packaged:true});
  const packaged=pathname=>protocol.handler(new Request(`styk-app://app${pathname}`));
  assert.equal((await packaged('/')).status,200);
  assert.equal((await packaged('/tests/private.json')).status,403);
});

test('the app scheme refuses writes, other hosts, traversal and bad escapes, and recognises only its own pages',async t=>{
  const f=await appScheme(t);
  await symlink(f.directory,path.join(f.root,'src','escape'),process.platform==='win32'?'junction':'dir');
  const post=await f.fetch('/index.html',{method:'POST'});
  assert.equal(post.status,405);assert.equal((await post.json()).code,'method_not_allowed');
  for(const pathname of ['/package.json','/desktop/main.cjs','/src/escape/secret.json','/src/..%5csecret.json','/.desktop-data/preferences.json']){
    const response=await f.fetch(pathname);assert.equal(response.status,403,pathname);assert.notEqual(await response.text(),'private');
  }
  assert.equal((await f.fetch('/src/%xx')).status,400);
  assert.equal((await f.fetch('/nothing.html')).status,404);
  const handler=await (async()=>{const protocol={registerSchemesAsPrivileged(){},handle:(scheme,fn)=>{protocol.fn=fn;}};await hostModule.handleAppProtocol({protocol,appRoot:f.root});return protocol.fn;})();
  assert.equal((await handler(new Request('styk-app://elsewhere/'))).status,403);
  assert.equal(f.host.owns('styk-app://app/'),true);assert.equal(f.host.owns('styk-app://app/src/x.mjs'),true);
  for(const url of ['styk-app://elsewhere/','http://app/','http://127.0.0.1:1/','https://example.test/','',undefined])assert.equal(f.host.owns(url),false,String(url));
});
