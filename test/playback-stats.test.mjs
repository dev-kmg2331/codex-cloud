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

function diagnostics(rendered = 0, dropped = 0, bboxReceived = 0, lateBbox = 0) {
  return { ...stats(rendered + dropped, rendered, (rendered + dropped) * 1000),
    decodedFrames: rendered + dropped, droppedFrames: dropped, bboxReceived, lateBbox };
}

function recentRates(sample) {
  assert.ok(sample);
  return { dropRatePercent: sample.dropRatePercent, lateBboxRatePercent: sample.lateBboxRatePercent,
    droppedFps: sample.droppedFps, recentWindowMs: sample.recentWindowMs };
}

const zeroRecent = { dropRatePercent: 0, lateBboxRatePercent: 0, droppedFps: 0, recentWindowMs: 0 };

test('recent percentages use counter changes rather than lifetime totals', () => {
  const sampler = createPlaybackSampler();
  assert.deepEqual(recentRates(sampler.sample(diagnostics(1000, 500, 100, 80), 0)), zeroRecent);
  assert.deepEqual(recentRates(sampler.sample(diagnostics(1090, 510, 105, 81), 1000)), {
    dropRatePercent: 10, lateBboxRatePercent: 20, droppedFps: 10, recentWindowMs: 1000,
  });
});

test('an old loss burst leaves the rolling window while lifetime counters stay unchanged', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(diagnostics(), 0);
  sampler.sample(diagnostics(80, 20, 10, 2), 1000);
  const second = sampler.sample(diagnostics(180, 20, 20, 2), 2000);
  assert.equal(second.renderFps, 100, 'FPS still uses the most recent one-second interval');
  assert.deepEqual(recentRates(second), {
    dropRatePercent: 10, lateBboxRatePercent: 10, droppedFps: 10, recentWindowMs: 2000,
  });
  for (let second = 3; second <= 5; second++) {
    sampler.sample(diagnostics(second * 100 - 20, 20, second * 10, 2), second * 1000);
  }
  const recovered = sampler.sample(diagnostics(580, 20, 60, 2), 6000);
  assert.deepEqual(recentRates(recovered), { ...zeroRecent, recentWindowMs: 5000 });
  assert.equal(recovered.droppedFrames, 20);
  assert.equal(recovered.lateBbox, 2);
});

test('reports the actual rolling window and ignores calls before the sampling interval', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(diagnostics(), 0);
  sampler.sample(diagnostics(90, 10, 5, 1), 1100);
  assert.equal(sampler.sample(diagnostics(90, 10, 5, 1), 1200), null);
  for (let step = 2; step <= 5; step++) {
    sampler.sample(diagnostics(step * 90, step * 10, step * 5, step), step * 1000 + 100);
  }
  const recent = sampler.sample(diagnostics(540, 60, 30, 6), 6200);
  assert.equal(recent.recentWindowMs, 5100);
  assert.equal(recent.dropRatePercent, 10);
  assert.equal(recent.lateBboxRatePercent, 20);
  assert.ok(Math.abs(recent.droppedFps - 50_000 / 5100) < 1e-9);
});

test('idle or legacy snapshots with no BBox counter have finite zero denominators', () => {
  const sampler = createPlaybackSampler();
  sampler.sample(stats(), 0);
  assert.deepEqual(recentRates(sampler.sample(stats(), 1000)), { ...zeroRecent, recentWindowMs: 1000 });
  const legacy = sampler.sample({ ...stats(25, 20, 2000), droppedFrames: 5, lateBbox: 3 }, 2000);
  assert.equal(legacy.dropRatePercent, 20);
  assert.equal(legacy.lateBboxRatePercent, 0);
  assert.equal(legacy.droppedFps, 2.5);
  assert.equal(legacy.recentWindowMs, 2000);
});

test('a rewind in loss or BBox counters clears the recent window as well as FPS baselines', () => {
  for (const key of ['droppedFrames', 'bboxReceived', 'lateBbox']) {
    const sampler = createPlaybackSampler();
    sampler.sample(diagnostics(100, 20, 10, 3), 0);
    sampler.sample(diagnostics(120, 25, 12, 4), 1000);
    const rewound = { ...diagnostics(150, 30, 15, 5), [key]: 0 };
    const rebased = sampler.sample(rewound, 2000);
    assert.deepEqual(recentRates(rebased), zeroRecent);
    assert.deepEqual(rates(rebased), zeroRates);
    const next = { ...rewound, receivedFrames: rewound.receivedFrames + 20,
      decodedFrames: rewound.decodedFrames + 20, renderedFrames: rewound.renderedFrames + 18,
      receivedBytes: rewound.receivedBytes + 5000, droppedFrames: rewound.droppedFrames + 2,
      bboxReceived: rewound.bboxReceived + 5, lateBbox: rewound.lateBbox + 1 };
    assert.deepEqual(recentRates(sampler.sample(next, 3000)), {
      dropRatePercent: 10, lateBboxRatePercent: 20, droppedFps: 2, recentWindowMs: 1000,
    });
  }
});

test('explicit resets, invalid clocks and long gaps discard stale recent loss history', () => {
  for (const reset of ['explicit', 'clock', 'gap']) {
    const sampler = createPlaybackSampler();
    sampler.sample(diagnostics(), 0);
    sampler.sample(diagnostics(80, 20, 10, 2), 1000);
    if (reset === 'explicit') sampler.reset();
    if (reset === 'clock') assert.deepEqual(recentRates(sampler.sample(diagnostics(), NaN)), zeroRecent);
    assert.deepEqual(recentRates(sampler.sample(diagnostics(100, 30, 15, 5), 8000)), zeroRecent);
    assert.deepEqual(recentRates(sampler.sample(diagnostics(120, 30, 20, 5), 9000)),
      { ...zeroRecent, recentWindowMs: 1000 });
  }
});

test('passes through loss reasons without mutating the input snapshot or nested object', () => {
  const reasons = Object.freeze({ coalesced: 3, expired: 2, overflow: 1, reset: 5, renderSkipped: 0 });
  const snapshot = Object.freeze({ ...diagnostics(89, 11, 10, 2), droppedFrameReasons: reasons });
  const sampler = createPlaybackSampler();
  sampler.sample(diagnostics(), 0);
  const result = sampler.sample(snapshot, 1000);
  assert.notEqual(result, snapshot);
  assert.equal(result.droppedFrameReasons, reasons);
  assert.deepEqual(snapshot, { ...diagnostics(89, 11, 10, 2), droppedFrameReasons: reasons });
});

test('keeps the recent sample history bounded even with very short custom intervals', () => {
  const sampler = createPlaybackSampler({ intervalMs: 1 });
  sampler.sample(diagnostics(), 0);
  let latest;
  for (let step = 1; step <= 200; step++) {
    latest = sampler.sample(diagnostics(step * 9, step, step * 5, step), step);
  }
  assert.ok(latest.recentWindowMs > 0 && latest.recentWindowMs <= 32);
  assert.equal(latest.dropRatePercent, 10);
  assert.equal(latest.lateBboxRatePercent, 20);
  assert.equal(latest.droppedFps, 1000);
});
