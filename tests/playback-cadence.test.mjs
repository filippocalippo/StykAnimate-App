import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackCadence} from '../src/playback-cadence.mjs';

// The display's refresh interval as the frame loop observes it (statistics' late-frame threshold, src/stats/frames.mjs).
test('cadence stays bounded, rejects pauses and resets before measuring a new run',()=>{
  const cadence=new PlaybackCadence();for(let i=0;i<100;i++)cadence.observe(i*1000/60);
  assert.equal(cadence.count,32);assert.ok(Math.abs(cadence.interval-1000/60)<1e-6);
  cadence.observe(10000);assert.ok(cadence.interval<17);
  cadence.reset();assert.equal(cadence.interval,null);assert.equal(cadence.count,0);
});

test('a stall or a missed refresh does not lower the observed refresh rate',()=>{
  const cadence=new PlaybackCadence();let now=0;
  for(let i=0;i<40;i++){now+=i%5===4?2000/144:1000/144;cadence.observe(now);}
  assert.ok(Math.abs(cadence.interval-1000/144)<1e-6,'a 144 Hz display that misses a refresh now and then is still 144 Hz');
});
