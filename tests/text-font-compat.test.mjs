import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Font,Glyph,Path,parse} from '../vendor/text/opentype.mjs';
import {parseTextFont,compileTextFigure} from '../src/text-authoring.mjs';
import {compileEmbeddedTextFigure} from '../src/native-text-authoring.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import backend from '../desktop/backend.cjs';
import installedFonts from '../desktop/font-service.cjs';

function fontBytes({symbol=true,direct=false}={}){
  const path=new Path();path.moveTo(0,0);path.lineTo(450,0);path.lineTo(225,600);path.close();
  const glyphs=[new Glyph({name:'.notdef',advanceWidth:500,path:new Path()}),
    new Glyph({name:'space',unicode:0xf020,advanceWidth:250,path:new Path()}),
    new Glyph({name:'symbol-b',unicode:0xf062,advanceWidth:500,path})];
  if(direct)glyphs.push(new Glyph({name:'direct-b',unicode:0x62,advanceWidth:650,path}));
  const font=new Font({familyName:'Test Symbols',styleName:'Regular',unitsPerEm:1000,ascender:800,descender:-200,glyphs}),
    buffer=font.toArrayBuffer(),view=new DataView(buffer);
  for(let i=0;i<view.getUint16(4);i++){
    const row=12+i*16;if(view.getUint32(row)!==0x636d6170)continue;
    const offset=view.getUint32(row+8);
    for(let j=0;j<view.getUint16(offset+2);j++){
      const record=offset+4+j*8;
      if(view.getUint16(record)===3)view.setUint16(record+2,symbol?0:1);
    }
  }
  return buffer;
}

test('explicit Windows symbol cmap resolves typed characters while preserving original text and bytes',()=>{
  const bytes=fontBytes(),before=new Uint8Array(bytes).slice(),raw=parse(bytes),{font}=parseTextFont(bytes);
  assert.equal(raw.charToGlyph('b').index,0);
  assert.equal(font.charToGlyph('b').index,font.charToGlyph('\uf062').index);
  assert.equal(font.charToGlyph(' ').index,font.charToGlyph('\uf020').index);
  assert.deepEqual(new Uint8Array(bytes),before);
  const figure=compileTextFigure({text:'b b',fontSize:40},font),asset=figure.text_assets[0];
  assert.equal(asset.text,'b b');assert.deepEqual(asset.glyphs.map(g=>g.utf16_code_unit),[98,32]);
  assert.equal(asset.placements[2].glyph_index,asset.placements[0].glyph_index);
  assert.ok(asset.glyphs[0].commands.length);assert.equal(asset.placements[1].visible,false);
  const embedded=compileEmbeddedTextFigure({text:'bb b'},figure);
  assert.equal(embedded.text_assets[0].text,'bb b');
  assert.deepEqual(embedded.text_assets[0].glyphs[0].commands,asset.glyphs[0].commands);
});

test('Unicode private-use glyphs never imply symbol remapping and existing direct mappings win',()=>{
  const unicode=parseTextFont(fontBytes({symbol:false})).font;
  assert.equal(unicode.charToGlyph('b').index,0);assert.ok(unicode.charToGlyph('\uf062').index);
  assert.throws(()=>compileTextFigure({text:'b'},unicode),/does not contain/);
  const direct=parseTextFont(fontBytes({direct:true})).font;
  assert.notEqual(direct.charToGlyph('b').index,direct.charToGlyph('\uf062').index);
  assert.equal(direct.charToGlyph('b').advanceWidth,650);
});

function roundtrip(figure){
  const report=emptyDocument();report.figure_types=[figure];report.keyframes=[createFrame([createObject(figure,1,100,200)],1)];
  const script=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
report=json.loads(sys.stdin.buffer.read().decode('utf-8'));store=server.ProjectStore(server.WORKSPACE);results={}
for kind in ('piv','stk'):
 raw,name=store.export({'document':report,'format':kind,'figureTypeId':1})
 results[kind]=store.import_bytes(raw,name)['document']
print(json.dumps(results))
`;
  const python=backend.pythonCandidates()[0],result=spawnSync(python.command,[...python.args,'-c',script],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify(report),encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.error?.message||result.stderr);return JSON.parse(result.stdout);
}

test('typed symbol glyphs survive real native PIV and STK writer/decoder without a font dependency',()=>{
  const figure=compileTextFigure({text:'b b'},parseTextFont(fontBytes()).font),expected=figure.text_assets[0],results=roundtrip(figure);
  for(const report of Object.values(results)){
    const actual=report.figure_types.find(f=>f.text_assets?.some(a=>a.font_name==='Test Symbols')).text_assets[0];
    assert.equal(actual.text,expected.text);assert.deepEqual(actual.glyphs.map(g=>g.utf16_code_unit),expected.glyphs.map(g=>g.utf16_code_unit));
    assert.deepEqual(actual.glyphs.map(g=>g.commands),expected.glyphs.map(g=>g.commands));
    assert.deepEqual(actual.placements,expected.placements);
  }
});

test('installed Webdings accepts Pivot bicycle and speech-bubble keyboard characters',{skip:process.platform!=='win32'},async()=>{
  const bytes=await readFile('C:/Windows/Fonts/webdings.ttf'),{font}=parseTextFont(bytes),figure=compileTextFigure({text:'b()[]{}'},font);
  const asset=figure.text_assets[0];assert.equal(asset.text,'b()[]{}');assert.equal(asset.glyphs.length,7);
  for(const glyph of asset.glyphs){assert.ok(glyph.commands.length);assert.equal(font.charToGlyph(String.fromCharCode(glyph.utf16_code_unit)).index,
    font.charToGlyph(String.fromCharCode(0xf000+glyph.utf16_code_unit)).index);}
});

test('installed TTC families are independently selectable and compile portable BMP text',{skip:process.platform!=='win32'},async()=>{
  const service=new installedFonts.FontService({directories:['C:/Windows/Fonts'],maxDepth:0}),rows=await service.listFonts();
  for(const[family,text]of[['Cambria','Cambria'],['MS Gothic','水 日本語'],['MS PGothic','水 日本語']]){
    const entry=rows.find(row=>row.family===family&&row.style==='Regular');
    assert.ok(entry,`${family} is listed`);assert.equal(entry.collection,true);
    const bytes=await service.readFont(entry.id);assert.notEqual(bytes.toString('latin1',0,4),'ttcf');
    const face=parseTextFont(bytes),figure=compileTextFigure({text,fontFamily:entry.family},face.font);
    assert.equal(face.family,family);assert.equal(figure.text_assets[0].text,text);
    assert.ok(figure.text_assets[0].glyphs.filter(g=>g.commands.length).length>=3);
    if(family==='MS Gothic'){
      const expected=figure.text_assets[0];
      for(const report of Object.values(roundtrip(figure))){
        const actual=report.figure_types.find(f=>f.text_assets?.some(a=>a.font_name===family)).text_assets[0];
        assert.equal(actual.text,text);assert.deepEqual(actual.glyphs.map(g=>g.commands),expected.glyphs.map(g=>g.commands));
      }
    }
  }
});
