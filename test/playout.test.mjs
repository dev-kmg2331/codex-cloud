import assert from 'node:assert/strict';
import test from 'node:test';
import { createFramePlayout } from '../frontend/src/playout.js';

const reasonNames = ['coalesced', 'expired', 'overflow', 'reset', 'renderSkipped'];

function assertDropReasons(stats, expected = {}) {
  assert.deepEqual(Object.keys(stats.droppedFrameReasons).sort(), [...reasonNames].sort());
  for (const reason of reasonNames) {
    assert.ok(Number.isInteger(stats.droppedFrameReasons[reason]) && stats.droppedFrameReasons[reason] >= 0);
    if (reason in expected) assert.equal(stats.droppedFrameReasons[reason], expected[reason], reason);
  }
  assert.equal(Object.values(stats.droppedFrameReasons).reduce((sum, count) => sum + count, 0), stats.droppedFrames);
}

function fakePlayback(t, canRender = () => true) {
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
  const playout = createFramePlayout((frame, bbox) => {
    if (!canRender()) return false;
    rendered.push({ pts: frame.timestamp, bbox });
  });
  return {
    playout, rendered,
    now: () => now,
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
      const stats = playout.getStats();
      assert.equal(stats.pendingFrames, 0);
      assertDropReasons(stats);
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

test('identity and held BBox age follow the painted frame while a newer frame is still queued', t => {
  const clock = fakePlayback(t);
  const bbox = { ptsUs: 100_000, frameId: 'detected-frame', boxes: [{ label: 'person' }] };
  clock.playout.addBbox(bbox);
  clock.playout.addBbox({ ptsUs: 900_000, frameId: 'future-frame', boxes: [] });
  clock.playout.addFrame(clock.frame(100_000), true);
  clock.advanceTo(100);
  clock.paint();
  let stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, 100_000);
  assert.equal(stats.appliedBboxPtsUs, 100_000);
  assert.equal(stats.frameId, 'detected-frame');
  assert.equal(stats.heldBboxAgeMs, 0);
  assert.equal(stats.pendingBbox, 1);

  clock.playout.addFrame(clock.frame(200_000), true);
  clock.advanceTo(200);
  clock.paint();
  clock.playout.addFrame(clock.frame(900_000), true);
  stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, 200_000);
  assert.equal(stats.appliedBboxPtsUs, 100_000);
  assert.equal(stats.frameId, 'detected-frame');
  assert.equal(stats.heldBboxAgeMs, 100);

  clock.playout.reset();
  stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, null);
  assert.equal(stats.appliedBboxPtsUs, null);
  assert.equal(stats.frameId, null);
  assert.equal(stats.heldBboxAgeMs, null);
  assert.equal(stats.pendingBbox, 0);
  clock.assertIdle();
});

test('empty BBox results replace identity and zero PTS or frame IDs remain valid', t => {
  const clock = fakePlayback(t);
  clock.playout.addBbox({ ptsUs: 0, frameId: 0, boxes: [{ label: 'person' }] });
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  let stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, 0);
  assert.equal(stats.appliedBboxPtsUs, 0);
  assert.equal(stats.frameId, 0);
  assert.equal(stats.heldBboxAgeMs, 0);

  const empty = { ptsUs: 100_000, frameId: 'empty-result', boxes: [] };
  clock.playout.addBbox(empty);
  clock.playout.addFrame(clock.frame(100_000), true);
  clock.advanceTo(200);
  clock.paint();
  stats = clock.playout.getStats();
  assert.equal(clock.rendered.at(-1).bbox, empty);
  assert.equal(stats.appliedBboxPtsUs, 100_000);
  assert.equal(stats.frameId, 'empty-result');
  assert.equal(stats.heldBboxAgeMs, 0);

  clock.playout.addFrame(clock.frame(200_000), true);
  clock.advanceTo(300);
  clock.paint();
  stats = clock.playout.getStats();
  assert.equal(stats.frameId, 'empty-result');
  assert.equal(stats.heldBboxAgeMs, 100);
  clock.assertIdle();
});

test('a suppressed paint closes its frame without advancing identity or consuming pending BBox', t => {
  let canRender = false;
  const clock = fakePlayback(t, () => canRender);
  const bbox = { ptsUs: 0, frameId: 'retained-result', boxes: [{ label: 'person' }] };
  clock.playout.addBbox(bbox);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  let stats = clock.playout.getStats();
  assert.equal(clock.rendered.length, 0);
  assert.equal(stats.renderedFrames, 0);
  assert.equal(stats.droppedFrames, 1);
  assert.equal(stats.bboxApplied, 0);
  assert.equal(stats.playoutWaitMs, 0);
  assert.equal(stats.lastPresentedPtsUs, null);
  assert.equal(stats.appliedBboxPtsUs, null);
  assert.equal(stats.frameId, null);
  assert.equal(stats.pendingBbox, 1);

  canRender = true;
  clock.playout.addFrame(clock.frame(100_000), true);
  clock.advanceTo(200);
  clock.paint();
  stats = clock.playout.getStats();
  assert.equal(clock.rendered[0].bbox, bbox);
  assert.equal(stats.lastPresentedPtsUs, 100_000);
  assert.equal(stats.frameId, 'retained-result');
  assert.equal(stats.heldBboxAgeMs, 100);
  assert.equal(stats.bboxApplied, 1);
  assert.equal(stats.pendingBbox, 0);
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
  const stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, 2000);
  assert.equal(stats.appliedBboxPtsUs, null);
  assert.equal(stats.frameId, null);
  assert.equal(stats.heldBboxAgeMs, null);
  clock.assertIdle();
});

test('caps surfaces at twelve and keeps presenting during sustained input overload', t => {
  const clock = fakePlayback(t);
  for (let ms = 0; ms <= 1000; ms++) {
    clock.advanceTo(ms);
    clock.playout.addFrame(clock.frame(ms * 1000), true);
    assert.ok(clock.playout.getStats().pendingFrames <= 12);
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
  clock.advanceTo(450);
  clock.playout.addFrame(clock.frame(2000), true);
  assert.equal(stale.closeCount, 1);
  assert.equal(clock.playout.getStats().pendingFrames, 1);
  assert.equal(clock.playout.getStats().oldestFrameAgeMs, 0);
  clock.paint();
  assert.equal(clock.rendered.length, 0);
  clock.advanceTo(550);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [2000]);
  clock.assertIdle();
});

test('learns from a late BBox after its frame has painted and delays future output', t => {
  const clock = fakePlayback(t);
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 100);
  assert.equal(clock.playout.getStats().bboxReceived, 0);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(200);
  clock.playout.addBbox({ ptsUs: 1000, boxes: [] });
  let stats = clock.playout.getStats();
  assert.equal(stats.bboxReceived, 1);
  assert.equal(stats.lateBbox, 1);
  assert.equal(stats.bboxDelaySamples, 1);
  assert.equal(stats.bboxDelayP95Ms, 200);
  assert.equal(stats.bboxPlayoutDelayMs, 220);
  assert.equal(stats.appliedBboxPtsUs, null, 'late results train timing without changing displayed coordinates');

  clock.playout.addFrame(clock.frame(2000), true);
  clock.advanceTo(419);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [1000]);
  clock.advanceTo(420);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [1000, 2000]);
  clock.assertIdle();
});

test('matches BBox-first arrivals while counting each PTS as only one timing sample', t => {
  const clock = fakePlayback(t);
  const bbox = { ptsUs: 0, frameId: 0, boxes: [] };
  clock.playout.addBbox(bbox);
  assert.equal(clock.playout.getStats().bboxDelaySamples, 0);
  clock.advanceTo(50);
  clock.playout.addFrame(clock.frame(0), true);
  let stats = clock.playout.getStats();
  assert.equal(stats.bboxDelaySamples, 1);
  assert.ok(stats.bboxDelayP95Ms <= 0, 'an already available result needs no positive waiting time');
  assert.equal(stats.bboxPlayoutDelayMs, 100, 'lowering needs at least eight feedback samples');
  clock.advanceTo(150);
  clock.paint();
  assert.equal(clock.rendered[0].bbox, bbox);
  clock.advanceTo(260);
  clock.playout.addBbox({ ...bbox });
  stats = clock.playout.getStats();
  assert.equal(stats.bboxReceived, 2);
  assert.equal(stats.bboxDelaySamples, 1);
  assert.ok(stats.bboxDelayP95Ms <= 0, 'a repeated late result must not replace its first arrival sample');
  clock.assertIdle();
});

test('caps adaptive wait at 300ms and still outputs video without another BBox', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(500);
  clock.playout.addBbox({ ptsUs: 0, boxes: [] });
  assert.equal(clock.playout.getStats().bboxDelayP95Ms, 500);
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 300);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.advanceTo(799);
  clock.paint();
  assert.equal(clock.rendered.length, 1);
  clock.advanceTo(800);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [0, 1000]);
  clock.playout.addFrame(clock.frame(2000), false);
  clock.paint();
  assert.equal(clock.rendered.at(-1).pts, 2000, 'BBox OFF must bypass even an already raised adaptive wait');
  assert.equal(clock.playout.getStats().playoutWaitMs, 0);
  clock.assertIdle();
});

test('raising the adaptive target reschedules already pending decoded frames', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(150);
  clock.playout.addFrame(clock.frame(1000), true);
  clock.advanceTo(200);
  clock.playout.addBbox({ ptsUs: 0, boxes: [] });
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 220);
  clock.advanceTo(369);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [0]);
  clock.advanceTo(370);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [0, 1000]);
  clock.assertIdle();
});

test('unmatched BBox traffic does not prevent the two-second feedback reset', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(200);
  clock.playout.addBbox({ ptsUs: 0, boxes: [] });
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 220);
  clock.advanceTo(2100);
  clock.playout.addBbox({ ptsUs: 999_000, boxes: [] });
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 220);
  clock.advanceTo(2201);
  clock.playout.addFrame(clock.frame(1000), true);
  const stats = clock.playout.getStats();
  assert.equal(stats.bboxReceived, 2);
  assert.equal(stats.bboxDelaySamples, 0);
  assert.equal(stats.bboxDelayP95Ms, null);
  assert.equal(stats.bboxPlayoutDelayMs, 100);
  clock.advanceTo(2301);
  clock.paint();
  assert.deepEqual(clock.rendered.map(frame => frame.pts), [0, 1000]);
  clock.assertIdle();
});

test('reset removes old timing identities before a reused PTS in a new epoch', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(200);
  clock.playout.addBbox({ ptsUs: 0, boxes: [] });
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 220);
  clock.playout.reset();
  let stats = clock.playout.getStats();
  assert.equal(stats.bboxDelaySamples, 0);
  assert.equal(stats.bboxDelayP95Ms, null);
  assert.equal(stats.bboxPlayoutDelayMs, 100);
  assert.equal(stats.bboxReceived, 1, 'reset keeps cumulative received-result diagnostics');
  clock.advanceTo(250);
  const fresh = { ptsUs: 0, frameId: 'new-generation', boxes: [] };
  clock.playout.addBbox(fresh);
  assert.equal(clock.playout.getStats().bboxDelaySamples, 0, 'old decoder arrival must not match new metadata');
  clock.advanceTo(260);
  clock.playout.addFrame(clock.frame(0), true);
  stats = clock.playout.getStats();
  assert.equal(stats.bboxDelaySamples, 1);
  assert.ok(stats.bboxDelayP95Ms <= 0);
  clock.advanceTo(360);
  clock.paint();
  assert.equal(clock.rendered.at(-1).bbox, fresh);
  clock.assertIdle();
});

test('a backward output PTS resets old surfaces, BBox identity, and adaptive feedback', t => {
  const clock = fakePlayback(t);
  const old = { ptsUs: 100_000_000, frameId: 'old-timeline', boxes: [{ label: 'old' }] };
  clock.playout.addBbox(old);
  clock.playout.addFrame(clock.frame(old.ptsUs), true);
  clock.advanceTo(100);
  clock.paint();
  assert.equal(clock.playout.getStats().frameId, 'old-timeline');
  const pending = clock.frame(110_000_000);
  clock.playout.addFrame(pending, true);
  clock.playout.addBbox({ ptsUs: pending.timestamp, frameId: 'old-pending', boxes: [] });
  clock.advanceTo(120);
  clock.playout.addFrame(clock.frame(0), true);
  let stats = clock.playout.getStats();
  assert.equal(stats.timelineResets, 1);
  assert.equal(pending.closeCount, 1);
  assert.equal(stats.pendingFrames, 1);
  assert.equal(stats.pendingBbox, 0);
  assert.equal(stats.lastPresentedPtsUs, null);
  assert.equal(stats.frameId, null);
  assert.equal(stats.bboxDelaySamples, 0);
  assert.equal(stats.bboxDelayP95Ms, null);
  assert.equal(stats.bboxPlayoutDelayMs, 100);
  assertDropReasons(stats, { reset: 1 });
  clock.advanceTo(130);
  const fresh = { ptsUs: 0, frameId: 'new-timeline', boxes: [] };
  clock.playout.addBbox(fresh);
  clock.advanceTo(220);
  clock.paint();
  stats = clock.playout.getStats();
  assert.equal(stats.lastPresentedPtsUs, 0);
  assert.equal(stats.frameId, 'new-timeline');
  assert.equal(stats.timelineResets, 1);
  assert.equal(stats.bboxReceived, 3);
  assert.equal(clock.rendered.at(-1).bbox, fresh);
  clock.assertIdle();
});

test('keeps at most 64 samples, waits after raising, and lowers no faster than 5ms per second', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(100);
  clock.paint();
  clock.advanceTo(500);
  clock.playout.addBbox({ ptsUs: 0, boxes: [] });
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 300);
  let nextPts = 1000;
  function feedbackAt(time) {
    clock.advanceTo(time);
    const pts = nextPts++;
    clock.playout.addFrame(clock.frame(pts), true);
    clock.playout.addBbox({ ptsUs: pts, boxes: [] });
    clock.paint();
  }
  for (let index = 0; index < 65; index++) feedbackAt(500);
  let stats = clock.playout.getStats();
  assert.equal(stats.bboxDelaySamples, 64);
  assert.equal(stats.bboxDelayP95Ms, 0);
  assert.equal(stats.bboxPlayoutDelayMs, 300, 'fresh low delays must not immediately undo a raised target');
  feedbackAt(2499);
  assert.equal(clock.playout.getStats().bboxPlayoutDelayMs, 300, 'the two-second raise cooldown is still active');
  feedbackAt(3000);
  const afterCooldown = clock.playout.getStats().bboxPlayoutDelayMs;
  assert.ok(afterCooldown >= 297.495 && afterCooldown <= 300, 'elapsed cooldown must not become an instant reduction budget');
  feedbackAt(4000);
  stats = clock.playout.getStats();
  assert.ok(stats.bboxPlayoutDelayMs < afterCooldown);
  assert.ok(stats.bboxPlayoutDelayMs >= afterCooldown - 5.001);
  for (let time = 4500; time <= 52_000; time += 500) feedbackAt(time);
  stats = clock.playout.getStats();
  assert.equal(stats.bboxPlayoutDelayMs, 80, 'long-term low delay must respect the minimum wait');
  assert.ok(stats.bboxDelaySamples <= 64);
  clock.playout.reset();
  clock.assertIdle();
});

test('expires samples older than fifteen seconds while feedback continues', t => {
  const clock = fakePlayback(t);
  for (let index = 0; index <= 40; index++) {
    clock.advanceTo(index * 500);
    clock.playout.addFrame(clock.frame(index * 1000), true);
    clock.advanceTo(index * 500 + 10);
    clock.playout.addBbox({ ptsUs: index * 1000, boxes: [] });
    clock.paint();
  }
  const stats = clock.playout.getStats();
  assert.ok(stats.bboxDelaySamples >= 30 && stats.bboxDelaySamples <= 31);
  assert.equal(stats.bboxDelayP95Ms, 10);
  assert.ok(stats.bboxPlayoutDelayMs >= 80 && stats.bboxPlayoutDelayMs <= 100);
  clock.playout.reset();
  clock.assertIdle();
});

test('counts coalescing, overflow, and reset separately and closes every frame once', t => {
  const clock = fakePlayback(t);
  clock.playout.addFrame(clock.frame(0), false);
  clock.playout.addFrame(clock.frame(1000), false);
  clock.paint();
  assertDropReasons(clock.playout.getStats(), { coalesced: 1, overflow: 0, expired: 0, reset: 0, renderSkipped: 0 });
  for (let index = 0; index < 13; index++) clock.playout.addFrame(clock.frame(2000 + index), true);
  assert.equal(clock.playout.getStats().pendingFrames, 12);
  assertDropReasons(clock.playout.getStats(), { coalesced: 1, overflow: 1 });
  clock.playout.reset(true);
  assert.equal(clock.rendered.at(-1).pts, 2012);
  assertDropReasons(clock.playout.getStats(), { coalesced: 1, overflow: 1, expired: 0, reset: 11, renderSkipped: 0 });
  clock.assertIdle();
});

test('counts suspended-expiry and rejected rendering without double closing surfaces', t => {
  let canRender = true;
  const clock = fakePlayback(t, () => canRender);
  clock.playout.addFrame(clock.frame(0), true);
  clock.advanceTo(401);
  clock.paint();
  assert.equal(clock.rendered.length, 0, 'a surface past the 400ms bound must not be painted');
  assertDropReasons(clock.playout.getStats(), { expired: 1, renderSkipped: 0 });
  canRender = false;
  clock.playout.addFrame(clock.frame(1000), false);
  clock.paint();
  assertDropReasons(clock.playout.getStats(), { coalesced: 0, overflow: 0, expired: 1, reset: 0, renderSkipped: 1 });
  clock.assertIdle();
});
