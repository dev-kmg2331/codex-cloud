const counterKeys = ['receivedFrames', 'decodedFrames', 'renderedFrames', 'receivedBytes'];

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteRate(value) {
  return Number.isFinite(value) ? value : 0;
}

// No timer or DOM work: the optional information overlay owns the sampling cadence.
export function createPlaybackSampler({ intervalMs = 1000, maxGapMs = 5000 } = {}) {
  intervalMs = positive(intervalMs, 1000);
  maxGapMs = Math.max(intervalMs, positive(maxGapMs, 5000));
  let previous;

  return {
    sample(stats, now = performance.now()) {
      const snapshot = stats && typeof stats === 'object' ? stats : {};
      const counters = {};
      let invalid = !Number.isFinite(now);
      for (const key of counterKeys) {
        const value = snapshot[key] ?? 0;
        if (!Number.isFinite(value) || value < 0) invalid = true;
        counters[key] = Number.isFinite(value) && value >= 0 ? value : 0;
      }
      const zero = () => ({ ...snapshot, receiveFps: 0, decodeFps: 0, renderFps: 0, bitrateBps: 0, sampleDurationMs: 0 });
      if (invalid) {
        previous = undefined;
        return zero();
      }
      const elapsed = previous === undefined ? 0 : now - previous.at;
      if (previous === undefined || elapsed < 0 || elapsed > maxGapMs
          || counterKeys.some(key => counters[key] < previous.counters[key])) {
        previous = { at: now, counters };
        return zero();
      }
      if (elapsed < intervalMs) return null;
      const result = {
        ...snapshot,
        receiveFps: finiteRate((counters.receivedFrames - previous.counters.receivedFrames) * 1000 / elapsed),
        decodeFps: finiteRate((counters.decodedFrames - previous.counters.decodedFrames) * 1000 / elapsed),
        renderFps: finiteRate((counters.renderedFrames - previous.counters.renderedFrames) * 1000 / elapsed),
        bitrateBps: finiteRate((counters.receivedBytes - previous.counters.receivedBytes) / elapsed * 8000),
        sampleDurationMs: elapsed,
      };
      previous = { at: now, counters };
      return result;
    },
    reset() {
      previous = undefined;
    },
  };
}
