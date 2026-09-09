import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
export function runtimeFingerprint(){
  return Object.fromEntries(readdirSync('src',{recursive:true}).filter(name=>name.endsWith('.mjs')).sort()
    .map(name=>[name,createHash('sha256').update(readFileSync(path.join('src',name))).digest('hex')]));
}
