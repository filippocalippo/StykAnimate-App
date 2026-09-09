import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackMetrics} from '../src/playback-metrics.mjs';

test('shows no rate before a playback session starts',()=>{
  assert.equal(new PlaybackMetrics().snapshot(50000).fps,null);
});

test('reports scene cadence independently of display refresh and CPU render duration', () => {
  const m = new PlaybackMetrics();m.reset(0,24);
  for(let i=0;i<24;i++)m.present(i*1000/24);
  const s=m.snapshot(999);
  assert.ok(Math.abs(s.fps-24)<.1);
  assert.equal(s.coherent,true);
  assert.equal(s.totalFrames,24);
});
test('buffering lowers FPS even when the animation loop continues without rendering', () => {
  const m=new PlaybackMetrics();m.reset(0,24);
  m.buffering(true,0);
  assert.equal(m.snapshot(499).fps,null);
  assert.equal(m.snapshot(600).fps,0);
  assert.equal(m.snapshot(600).coherent,false);
  m.buffering(false,650);m.present(650);m.present(850);
  assert.equal(m.snapshot(1000).startupMs,650);
  assert.equal(m.snapshot(1000).bufferingMs,650);
  assert.equal(m.snapshot(1000).bufferingEvents,1);
  assert.equal(m.snapshot(1000).fps,2);
  assert.equal(m.snapshot(1900).fps,0);
});
test('pausing freezes the session and restarting clears previous measurements', () => {
  const m=new PlaybackMetrics();m.reset(100,12);m.present(120);m.present(220);
  m.buffering(true,250);m.stop(700);
  assert.deepEqual(m.snapshot(700),m.snapshot(4000));
  assert.equal(m.snapshot(4000).bufferingMs,450);
  m.reset(5000,30);
  assert.equal(m.snapshot(5100).totalFrames,0);
  assert.equal(m.snapshot(5100).targetFps,30);
});
test('bounds stored samples and flags a sustained frame deficit', () => {
  const m=new PlaybackMetrics();m.reset(0,24);
  for(let i=0;i<2000;i++)m.present(i*100);
  assert.ok(m.presentations.length<=11);
  assert.equal(m.intervals.length,300);
  assert.equal(m.snapshot(199999).coherent,false);
  assert.equal(m.snapshot(199999).fps,10);
});
test('a repeated one-frame loop still counts each scheduled presentation', () => {
  const m=new PlaybackMetrics();m.reset(0,10);
  for(let i=0;i<10;i++)m.present(i*100);
  assert.equal(m.snapshot(999).totalFrames,10);
  assert.equal(m.snapshot(999).coherent,true);
});
