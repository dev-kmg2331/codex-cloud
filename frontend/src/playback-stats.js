const counterKeys = ['receivedFrames', 'decodedFrames', 'renderedFrames', 'receivedBytes',
  'droppedFrames', 'lateBbox', 'bboxReceived'];
const recentDurationMs = 5000;
const maxRecentSnapshots = 32;

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
  const recent = [];

  function rebase(at, counters) {
    previous = { at, counters };
    recent.splice(0, recent.length, previous);
  }

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
      const zero = () => ({ ...snapshot, receiveFps: 0, decodeFps: 0, renderFps: 0,
        bitrateBps: 0, sampleDurationMs: 0, dropRatePercent: 0, lateBboxRatePercent: 0,
        droppedFps: 0, recentWindowMs: 0 });
      if (invalid) {
        previous = undefined;
        recent.length = 0;
        return zero();
      }
      const elapsed = previous === undefined ? 0 : now - previous.at;
      if (previous === undefined || elapsed < 0 || elapsed > maxGapMs
          || counterKeys.some(key => counters[key] < previous.counters[key])) {
        rebase(now, counters);
        return zero();
      }
      if (elapsed < intervalMs) return null;
      const current = { at: now, counters };
      recent.push(current);
      // Retain the sample immediately before the five-second boundary. Sampling
      // can drift, so report the actual window rather than assuming five seconds.
      while (recent.length > 1 && recent[1].at <= now - recentDurationMs) recent.shift();
      if (recent.length > maxRecentSnapshots) recent.splice(0, recent.length - maxRecentSnapshots);
      const baseline = recent[0];
      const recentWindowMs = now - baseline.at;
      const dropped = counters.droppedFrames - baseline.counters.droppedFrames;
      const painted = counters.renderedFrames - baseline.counters.renderedFrames;
      const late = counters.lateBbox - baseline.counters.lateBbox;
      const receivedBbox = counters.bboxReceived - baseline.counters.bboxReceived;
      const result = {
        ...snapshot,
        receiveFps: finiteRate((counters.receivedFrames - previous.counters.receivedFrames) * 1000 / elapsed),
        decodeFps: finiteRate((counters.decodedFrames - previous.counters.decodedFrames) * 1000 / elapsed),
        renderFps: finiteRate((counters.renderedFrames - previous.counters.renderedFrames) * 1000 / elapsed),
        bitrateBps: finiteRate((counters.receivedBytes - previous.counters.receivedBytes) / elapsed * 8000),
        sampleDurationMs: elapsed,
        dropRatePercent: painted + dropped > 0 ? finiteRate(dropped / (painted + dropped) * 100) : 0,
        lateBboxRatePercent: receivedBbox > 0 ? finiteRate(late / receivedBbox * 100) : 0,
        droppedFps: recentWindowMs > 0 ? finiteRate(dropped * 1000 / recentWindowMs) : 0,
        recentWindowMs,
      };
      previous = current;
      return result;
    },
    reset() {
      previous = undefined;
      recent.length = 0;
    },
  };
}
