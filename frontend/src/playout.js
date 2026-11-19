const initialBboxDelayMs = 100;
const minBboxDelayMs = 80;
const maxBboxDelayMs = 300;
const maxPendingFrames = 12;
const maxPendingBoxes = 32;
const maxPendingFrameAgeMs = 400;

export function createFramePlayout(render) {
  const frames = [];
  const boxes = new Map();
  // Timestamps outlive VideoFrame surfaces so late results can teach the estimator.
  const decodedAt = new Map();
  const bboxArrivedAt = new Map();
  const delaySamples = [];
  const stats = { renderedFrames: 0, droppedFrames: 0, bboxReceived: 0, bboxApplied: 0,
    lateBbox: 0, playoutWaitMs: 0, timelineResets: 0,
    droppedFrameReasons: { coalesced: 0, expired: 0, overflow: 0, reset: 0, renderSkipped: 0 },
    lastPresentedPtsUs: null, appliedBboxPtsUs: null, frameId: null, heldBboxAgeMs: null };
  let wakeTimer;
  let animation;
  let lastPresentedPts = -Infinity;
  let displayedBbox;
  let bboxDelayMs = initialBboxDelayMs;
  let delayP95Ms = null;
  let lastFeedbackAt;
  let lastRaisedAt = -Infinity;
  let lastAdjustmentAt = performance.now();
  let decreaseCreditMs = 0;

  function discard(entry, reason) {
    entry.frame.close();
    stats.droppedFrames++;
    stats.droppedFrameReasons[reason]++;
  }

  function setDelay(value, now) {
    const next = Math.max(minBboxDelayMs, Math.min(maxBboxDelayMs, Math.round(value)));
    if (next === bboxDelayMs) return;
    bboxDelayMs = next;
    lastAdjustmentAt = now;
    for (const entry of frames) {
      if (entry.waitForBbox) entry.deadline = entry.receivedAt + bboxDelayMs;
    }
    clearTimeout(wakeTimer);
    cancelAnimationFrame(animation);
    wakeTimer = undefined;
    animation = undefined;
  }

  function refreshPercentile() {
    const sorted = delaySamples.map(sample => sample.delay).sort((a, b) => a - b);
    delayP95Ms = sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null;
  }

  function updateDelay(now) {
    if (lastFeedbackAt !== undefined && now - lastFeedbackAt > 2000) {
      delaySamples.length = 0;
      delayP95Ms = null;
      lastFeedbackAt = undefined;
      lastRaisedAt = -Infinity;
      decreaseCreditMs = 0;
      setDelay(initialBboxDelayMs, now);
      lastAdjustmentAt = now;
      return;
    }
    const before = delaySamples.length;
    while (delaySamples.length && now - delaySamples[0].at > 15000) delaySamples.shift();
    if (before !== delaySamples.length) refreshPercentile();
    if (delayP95Ms === null) return;
    const target = Math.max(minBboxDelayMs, Math.min(maxBboxDelayMs, Math.ceil(delayP95Ms + 20)));
    if (target > bboxDelayMs) {
      setDelay(target, now);
      lastRaisedAt = now;
      decreaseCreditMs = 0;
    } else if (target < bboxDelayMs && delaySamples.length >= 8 && now - lastRaisedAt >= 2000) {
      // Retain elapsed time between integer steps; decrease at most 5ms/second.
      decreaseCreditMs += Math.max(0, now - lastAdjustmentAt) * .005;
      lastAdjustmentAt = now;
      const step = Math.min(Math.floor(decreaseCreditMs), bboxDelayMs - target);
      if (step > 0) {
        setDelay(bboxDelayMs - step, now);
        decreaseCreditMs -= step;
      }
      if (bboxDelayMs === target) decreaseCreditMs = 0;
    } else {
      lastAdjustmentAt = now;
      decreaseCreditMs = 0;
    }
  }

  function learnDelay(pts, arrived, now) {
    const entry = decodedAt.get(pts);
    if (!entry || entry.sampled) return false;
    entry.sampled = true;
    delaySamples.push({ at: now, delay: Math.max(0, arrived - entry.at) });
    if (delaySamples.length > 64) delaySamples.shift();
    lastFeedbackAt = now;
    refreshPercentile();
    updateDelay(now);
    return true;
  }

  function present(entry) {
    const { frame, receivedAt } = entry;
    const pts = frame.timestamp;
    let latestBoxPts = -Infinity;
    let nextBbox = displayedBbox;
    for (const [boxPts, bbox] of boxes) {
      if (boxPts > pts) continue;
      if (boxPts > latestBoxPts) {
        nextBbox = bbox;
        latestBoxPts = boxPts;
      }
    }
    try {
      if (render(frame, nextBbox) === false) {
        stats.droppedFrames++;
        stats.droppedFrameReasons.renderSkipped++;
        return;
      }
      displayedBbox = nextBbox;
      for (const boxPts of boxes.keys()) {
        if (boxPts <= pts) boxes.delete(boxPts);
      }
      if (latestBoxPts > -Infinity) stats.bboxApplied++;
      lastPresentedPts = Math.max(lastPresentedPts, pts);
      stats.playoutWaitMs = performance.now() - receivedAt;
      stats.renderedFrames++;
      stats.lastPresentedPtsUs = pts;
      stats.appliedBboxPtsUs = displayedBbox?.ptsUs ?? null;
      stats.frameId = displayedBbox?.frameId ?? null;
      stats.heldBboxAgeMs = stats.appliedBboxPtsUs === null ? null : (pts - stats.appliedBboxPtsUs) / 1000;
    } finally {
      frame.close();
    }
  }

  function renderDue() {
    animation = undefined;
    const now = performance.now();
    updateDelay(now);
    let latest;
    while (frames.length > 0 && frames[0].deadline <= now) {
      const entry = frames.shift();
      if (now - entry.receivedAt > maxPendingFrameAgeMs) {
        discard(entry, 'expired');
        continue;
      }
      if (latest) discard(latest, 'coalesced');
      latest = entry;
    }
    if (latest) present(latest);
    schedule();
  }

  function schedule() {
    if (wakeTimer !== undefined || animation !== undefined || frames.length === 0) return;
    const wait = frames[0].deadline - performance.now();
    if (wait > 0) {
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        schedule();
      }, wait);
    } else {
      animation = requestAnimationFrame(renderDue);
    }
  }

  function reset(showLatestFrame = false) {
    clearTimeout(wakeTimer);
    cancelAnimationFrame(animation);
    wakeTimer = undefined;
    animation = undefined;
    boxes.clear();
    decodedAt.clear();
    bboxArrivedAt.clear();
    delaySamples.length = 0;
    delayP95Ms = null;
    bboxDelayMs = initialBboxDelayMs;
    lastFeedbackAt = undefined;
    lastRaisedAt = -Infinity;
    lastAdjustmentAt = performance.now();
    decreaseCreditMs = 0;
    lastPresentedPts = -Infinity;
    displayedBbox = undefined;
    stats.lastPresentedPtsUs = null;
    stats.appliedBboxPtsUs = null;
    stats.frameId = null;
    stats.heldBboxAgeMs = null;
    const latest = showLatestFrame ? frames.pop() : undefined;
    for (const entry of frames.splice(0)) discard(entry, 'reset');
    if (latest) present(latest);
  }

  return {
    addFrame(frame, waitForBbox) {
      const now = performance.now();
      // Rebase a restarted source; old PTS identities must not label the new timeline.
      if (frame.timestamp < lastPresentedPts) {
        reset();
        stats.timelineResets++;
      }
      updateDelay(now);
      if (!decodedAt.has(frame.timestamp)) decodedAt.set(frame.timestamp, { at: now, sampled: false });
      if (decodedAt.size > 128) decodedAt.delete(decodedAt.keys().next().value);
      const arrived = bboxArrivedAt.get(frame.timestamp);
      if (waitForBbox && arrived !== undefined) {
        learnDelay(frame.timestamp, arrived, now);
        bboxArrivedAt.delete(frame.timestamp);
      }
      while (frames.length > 0 && now - frames[0].receivedAt > maxPendingFrameAgeMs) {
        discard(frames.shift(), 'expired');
      }
      frames.push({ frame, receivedAt: now, waitForBbox,
        deadline: now + (waitForBbox ? bboxDelayMs : 0) });
      // Retain the next due candidate so overload cannot defer playback forever.
      if (frames.length > maxPendingFrames) discard(frames.splice(1, 1)[0], 'overflow');
      schedule();
    },
    addBbox(bbox) {
      const now = performance.now();
      stats.bboxReceived++;
      updateDelay(now);
      if (!learnDelay(bbox.ptsUs, now, now) && !decodedAt.has(bbox.ptsUs)) {
        if (!bboxArrivedAt.has(bbox.ptsUs)) bboxArrivedAt.set(bbox.ptsUs, now);
        if (bboxArrivedAt.size > 32) bboxArrivedAt.delete(bboxArrivedAt.keys().next().value);
      }
      if (bbox.ptsUs <= lastPresentedPts) {
        stats.lateBbox++;
        bboxArrivedAt.delete(bbox.ptsUs);
        schedule();
        return;
      }
      boxes.set(bbox.ptsUs, bbox);
      if (boxes.size > maxPendingBoxes) boxes.delete(boxes.keys().next().value);
      schedule();
    },
    reset,
    getStats() {
      return { ...stats, droppedFrameReasons: { ...stats.droppedFrameReasons },
        bboxPlayoutDelayMs: bboxDelayMs, bboxDelayP95Ms: delayP95Ms, bboxDelaySamples: delaySamples.length,
        pendingFrames: frames.length, pendingBbox: boxes.size,
        oldestFrameAgeMs: frames.length ? performance.now() - frames[0].receivedAt : 0 };
    },
  };
}
