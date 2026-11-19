import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSampler } from '../frontend/src/playback-stats.js';

function stats(receivedFrames = 0, renderedFrames = 0, receivedBytes = 0) {
  return { receivedFrames, renderedFrames, receivedBytes };
}

function rates(sample) {
  assert.ok(sample);
  return {
    receiveFps: sample.receiveFps,
    renderFps: sample.renderFps,
    bitrateBps: sample.bitrateBps,
    sampleDurationMs: sample.sampleDurationMs,
  };
}

const zeroRates = { receiveFps: 0, renderFps: 0, bitrateBps: 0, sampleDurationMs: 0 };

test('starts at time zero and measures frame and byte deltas over the sample window', () => {
  const sampler = createPlaybackSampler();
  const initial = { ...stats(100, 90, 10_000), codec: 'avc1.42e01e', width: 1920 };
  const first = sampler.sample(initial, 0);
  assert.deepEqual(rates(first), zeroRates);
  assert.equal(first.codec, initial.codec);
  assert.equal(first.width, initial.width);
  assert.notEqual(first, initial);
  assert.deepEqual(initial, { ...stats(100, 90, 10_000), codec: 'avc1.42e01e', width: 1920 });

  assert.deepEqual(rates(sampler.sample(stats(120, 108, 12_000), 1000)), {
    receiveFps: 20, renderFps: 18, bitrateBps: 16_000, sampleDurationMs: 1000,
  });
  assert.deepEqual(rates(sampler.sample(stats(180, 148, 20_000), 3000)), {
    receiveFps: 30, renderFps: 20, bitrateBps: 32_000, sampleDurationMs: 2000,
  });
});

test('calls before the sample interval preserve the original counter baseline', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(stats(10, 10, 100), 0);
  assert.equal(sampler.sample(stats(17, 14, 500), 500), null);
  assert.equal(sampler.sample(stats(19, 15, 900), 999), null);
  assert.deepEqual(rates(sampler.sample(stats(20, 16, 1100), 1000)), {
    receiveFps: 10, renderFps: 6, bitrateBps: 8000, sampleDurationMs: 1000,
  });
});

test('reports zero FPS and bitrate when an active stream stops producing frames', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(stats(), 0);
  sampler.sample(stats(25, 23, 4000), 1000);
  assert.deepEqual(rates(sampler.sample(stats(25, 23, 4000), 2000)), {
    ...zeroRates, sampleDurationMs: 1000,
  });
});

test('measures decoder output FPS independently from received and painted frames', () => {
  const sampler = createPlaybackSampler();
  const first = sampler.sample({ ...stats(30, 20, 5000), decodedFrames: 25 }, 0);
  assert.equal(first.decodeFps, 0);
  const next = sampler.sample({ ...stats(65, 36, 9000), decodedFrames: 65 }, 1000);
  assert.equal(next.receiveFps, 35);
  assert.equal(next.decodeFps, 40);
  assert.equal(next.renderFps, 16);
  const idle = sampler.sample({ ...stats(65, 36, 9000), decodedFrames: 65 }, 2000);
  assert.equal(idle.decodeFps, 0);
});

test('a decoder counter rewind rebases all rates for the new session', () => {
  const sampler = createPlaybackSampler();
  sampler.sample({ ...stats(100, 80, 20_000), decodedFrames: 90 }, 0);
  const rebased = sampler.sample({ ...stats(120, 90, 25_000), decodedFrames: 2 }, 1000);
  assert.deepEqual(rates(rebased), zeroRates);
  assert.equal(rebased.decodeFps, 0);
  const next = sampler.sample({ ...stats(140, 100, 30_000), decodedFrames: 8 }, 2000);
  assert.equal(next.receiveFps, 20);
  assert.equal(next.decodeFps, 6);
  assert.equal(next.renderFps, 10);
});

test('legacy snapshots without a decoder counter still produce valid FPS samples', () => {
  const sampler = createPlaybackSampler();
  assert.equal(sampler.sample(stats(), 0).decodeFps, 0);
  const next = sampler.sample(stats(20, 18, 2000), 1000);
  assert.equal(next.decodeFps, 0);
  assert.equal(next.receiveFps, 20);
  assert.equal(next.renderFps, 18);
});

test('reset discards previous-session counters and starts a new time-zero baseline', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(stats(1000, 900, 500_000), 10_000);
  sampler.sample(stats(1020, 918, 508_000), 11_000);
  sampler.reset();
  assert.deepEqual(rates(sampler.sample(stats(), 0)), zeroRates);
  assert.deepEqual(rates(sampler.sample(stats(12, 11, 1000), 1000)), {
    receiveFps: 12, renderFps: 11, bitrateBps: 8000, sampleDurationMs: 1000,
  });
});

test('a rewind in any cumulative counter rebases the whole sample instead of emitting negative rates', () => {
  for (const rewind of [stats(0, 40, 3000), stats(60, 0, 3000), stats(60, 40, 0)]) {
    const sampler = createPlaybackSampler();
    sampler.sample(stats(50, 30, 2000), 0);
    assert.deepEqual(rates(sampler.sample(rewind, 1000)), zeroRates);
    const next = stats(rewind.receivedFrames + 10, rewind.renderedFrames + 8, rewind.receivedBytes + 2000);
    assert.deepEqual(rates(sampler.sample(next, 2000)), {
      receiveFps: 10, renderFps: 8, bitrateBps: 16_000, sampleDurationMs: 1000,
    });
  }
});

test('backwards or nonfinite clocks produce a finite zero baseline', () => {
  for (const invalidNow of [500, NaN, Infinity, -Infinity]) {
    const sampler = createPlaybackSampler();
    sampler.sample(stats(20, 18, 2000), 1000);
    assert.deepEqual(rates(sampler.sample(stats(40, 36, 4000), invalidNow)), zeroRates);
  }
});

test('a long sampling gap is rebased and the next normal window resumes fresh rates', () => {
  const sampler = createPlaybackSampler({ maxGapMs: 5000 });
  sampler.sample(stats(), 0);
  assert.deepEqual(rates(sampler.sample(stats(300, 250, 100_000), 6000)), zeroRates);
  assert.deepEqual(rates(sampler.sample(stats(315, 264, 102_000), 7000)), {
    receiveFps: 15, renderFps: 14, bitrateBps: 16_000, sampleDurationMs: 1000,
  });
});

test('respects a custom sampling interval', () => {
  const sampler = createPlaybackSampler({ intervalMs: 250 });
  sampler.sample(stats(), 0);
  assert.equal(sampler.sample(stats(3, 2, 250), 249), null);
  assert.deepEqual(rates(sampler.sample(stats(5, 4, 500), 250)), {
    receiveFps: 20, renderFps: 16, bitrateBps: 16_000, sampleDurationMs: 250,
  });
});
