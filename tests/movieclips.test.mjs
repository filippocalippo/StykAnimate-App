import test from 'node:test';
import assert from 'node:assert/strict';
import {movieclipTime, playbackSettings} from '../src/movieclips.mjs';


test('movieclip sampling is deterministic at loop, once, hold, offset and FPS boundaries',()=>{
  const asset={duration:12,document:{fps:24}},base=playbackSettings(null,{start:12});
  assert.equal(movieclipTime(asset,base,11,24),null);assert.equal(movieclipTime(asset,base,12,24),0);
  assert.equal(movieclipTime(asset,base,23,24),11);assert.equal(movieclipTime(asset,base,24,24),0);
  assert.equal(movieclipTime(asset,{...base,mode:'once'},24,24),null);
  assert.equal(movieclipTime(asset,{...base,mode:'hold'},80,24),11);
  assert.equal(movieclipTime(asset,{...base,mode:'single',offset:7},80,24),7);
  assert.equal(movieclipTime(asset,base,14,48),1);
});

