import assert from 'node:assert/strict';
import test from 'node:test';
import { createFramePlayout } from '../frontend/src/playout.js';

function fakePlayback(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const animations = new Map();
  const frames = [];
  const rendered = [];
  const globals = {
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) {
      const id = ++nextId;
      animations.set(id, callback);
      return id;
    },
    cancelAnimationFrame: id => animations.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const playout = createFramePlayout((frame, bbox) => rendered.push({ pts: frame.timestamp, bbox }));
  return {
    playout, rendered,
    frame(timestamp) {
      const frame = { timestamp, closeCount: 0, close() { this.closeCount++; } };
      frames.push(frame);
      return frame;
    },
    advanceTo(time) {
      assert.ok(time >= now);
      now = time;
      for (let due = true; due;) {
        due = false;
        for (const [id, event] of timers) {
          if (event.at <= now) {
            timers.delete(id);
            event.callback();
            due = true;
          }
        }
      }
    },
    paint() {
      const callbacks = [...animations.values()];
      animations.clear();
      callbacks.forEach(callback => callback(now));
    },
    assertIdle() {
      assert.equal(playout.getStats().pendingFrames, 0);
      assert.equal(timers.size, 0);
      assert.equal(animations.size, 0);
      frames.forEach(frame => assert.equal(frame.closeCount, 1));
    },
  };
}

test('waits 100ms, then presents only the newest due frame at the next paint', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.advanceTo(20);
  clock.playout.addFrame(clock.frame(2000), true);
  clock.advanceTo(99);
  clock.paint();
  assert.equal(clock.rendered.length, 0);
  clock.advanceTo(120);
  assert.equal(clock.rendered.length, 0);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [2000]);
  assert.equal(clock.playout.getStats().droppedFrames, 1);
  clock.assertIdle();
});

test('uses BBox updates from skipped frames, holds them and applies a later empty result', t => {
  const clock = fakePlayback(t);
  const bbox = { ptsUs: 1000, boxes: [{ label: 'person' }] };
  const empty = { ptsUs: 3000, boxes: [] };
  const future = { ptsUs: 9000, boxes: [{ label: 'future' }] };
  clock.playout.addBbox(future);
  clock.playout.addBbox(bbox);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.playout.addFrame(clock.frame(2000), true);
  clock.advanceTo(100);
  clock.paint();
  assert.equal(clock.rendered[0].bbox, bbox);
  clock.playout.addFrame(clock.frame(2500), true);
  clock.advanceTo(200);
  clock.paint();
  assert.equal(clock.rendered[1].bbox, bbox);
  clock.playout.addBbox(empty);
  clock.playout.addFrame(clock.frame(3000), true);
  clock.playout.addFrame(clock.frame(4000), true);
  clock.advanceTo(300);
  clock.paint();
  assert.equal(clock.rendered[2].bbox, empty);
  clock.playout.addBbox({ ptsUs: 3000, boxes: [{ label: 'late' }] });
  clock.playout.addFrame(clock.frame(5000), true);
  clock.advanceTo(400);
  clock.paint();
  assert.equal(clock.rendered[3].bbox, empty);
  assert.equal(clock.playout.getStats().lateBbox, 1);
  clock.assertIdle();
});

test('BBox off coalesces decoded output until the next paint without a delay timer', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(1000), false);
  clock.playout.addFrame(clock.frame(2000), false);
  assert.equal(clock.rendered.length, 0);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [2000]);
  clock.assertIdle();
});

test('hidden/reset cleanup cancels the timer and paint, closes frames and clears held metadata', t => {
  const clock = fakePlayback(t);
  clock.playout.addBbox({ ptsUs: 1000, boxes: [{ label: 'old' }] });
  clock.playout.addFrame(clock.frame(1000), true);
  clock.playout.reset();
  clock.assertIdle();
  clock.advanceTo(200);
  clock.paint();
  assert.equal(clock.rendered.length, 0);
  clock.playout.addFrame(clock.frame(2000), false);
  clock.playout.reset();
  clock.paint();
  assert.equal(clock.rendered.length, 0);
  clock.assertIdle();
  clock.playout.addFrame(clock.frame(3000), false);
  clock.paint();
  assert.equal(clock.rendered[0].bbox, undefined);
  clock.assertIdle();
});

test('disabling BBox can release the latest queued frame immediately', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.playout.addFrame(clock.frame(2000), true);
  clock.playout.reset(true);
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [2000]);
  clock.assertIdle();
});

test('caps surfaces at eight and keeps presenting during sustained input overload', t => {
  const clock = fakePlayback(t);
  for (let ms = 0; ms <= 1000; ms++) {
    clock.advanceTo(ms);
    clock.playout.addFrame(clock.frame(ms * 1000), true);
    assert.ok(clock.playout.getStats().pendingFrames <= 8);
    if (ms % 16 === 0) clock.paint();
  }
  assert.ok(clock.rendered.length >= 5, 'continuous arrivals must not starve the due candidate');
  assert.ok(clock.playout.getStats().droppedFrames > 0);
  clock.playout.reset();
  clock.assertIdle();
});

test('discards aged surfaces when rendering was suspended', t => {
  const clock = fakePlayback(t);
  const stale = clock.frame(1000);
  clock.playout.addFrame(stale, true);
  clock.advanceTo(300);
  clock.playout.addFrame(clock.frame(2000), true);
  assert.equal(stale.closeCount, 1);
  assert.equal(clock.playout.getStats().pendingFrames, 1);
  assert.equal(clock.playout.getStats().oldestFrameAgeMs, 0);
  clock.paint();
  assert.equal(clock.rendered.length, 0);
  clock.advanceTo(400);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [2000]);
  clock.assertIdle();
});
