import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
// Execute the established semantic regression assertions against this app's
// optimized copies. Never rewrite the parent workspace's reference sources.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const generated=path.join(root,'artifacts','reference-tests');
await mkdir(generated,{recursive:true});
const paths=[];
for(const name of ['test_geometry.mjs','test_studio_model.mjs','test_background.mjs','test_native_easing.mjs','test_native_stroke.mjs']){
 const source=path.join(root,'..','tests',name);
 const body=(await readFile(source,'utf8'))
   .replace(/(['"])\.\.\/studio\/([^'"]+)\1/g,(_,quote,file)=>quote+pathToFileURL(path.join(root,'src','pivot',file)).href+quote)
   .replace(/(['"])\.\.\/reports\/([^'"]+)\1/g,(_,quote,file)=>quote+pathToFileURL(path.join(root,'..','reports',file)).href+quote);
 const destination=path.join(generated,name);await writeFile(destination,body);paths.push(destination);
}
try{const result=spawnSync(process.execPath,['--test',...paths],{cwd:root,encoding:'utf8',windowsHide:true});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;}
finally{for(const file of paths)await unlink(file);}
