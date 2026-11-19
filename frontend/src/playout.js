const bboxPlayoutDelayMs = 100;
const maxPendingFrames = 8;
const maxPendingBoxes = 32;
const maxPendingFrameAgeMs = 250;

export function createFramePlayout(render) {
  const frames = [];
  const boxes = new Map();
  const stats = { renderedFrames: 0, droppedFrames: 0, bboxApplied: 0, lateBbox: 0, playoutWaitMs: 0,
    lastPresentedPtsUs: null, appliedBboxPtsUs: null, frameId: null, heldBboxAgeMs: null };
  let wakeTimer;
  let animation;
  let lastPresentedPts = -Infinity;
  let displayedBbox;

  function discard(entry) {
    entry.frame.close();
    stats.droppedFrames++;
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
      // This is the age of the held result on the video timeline, not network latency.
      stats.heldBboxAgeMs = stats.appliedBboxPtsUs === null ? null : (pts - stats.appliedBboxPtsUs) / 1000;
    } finally {
      frame.close();
    }
  }

  function renderDue() {
    animation = undefined;
    const now = performance.now();
    let latest;
    while (frames.length > 0 && frames[0].deadline <= now) {
      if (latest) discard(latest);
      latest = frames.shift();
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

  return {
    addFrame(frame, waitForBbox) {
      const now = performance.now();
      while (frames.length > 0 && now - frames[0].receivedAt > maxPendingFrameAgeMs) {
        discard(frames.shift());
      }
      frames.push({ frame, receivedAt: now, deadline: now + (waitForBbox ? bboxPlayoutDelayMs : 0) });
      // Retain the next due candidate so continuous overload cannot defer playback forever.
      if (frames.length > maxPendingFrames) discard(frames.splice(1, 1)[0]);
      schedule();
    },
    addBbox(bbox) {
      if (bbox.ptsUs <= lastPresentedPts) {
        stats.lateBbox++;
        return;
      }
      boxes.set(bbox.ptsUs, bbox);
      if (boxes.size > maxPendingBoxes) boxes.delete(boxes.keys().next().value);
    },
    reset(showLatestFrame = false) {
      clearTimeout(wakeTimer);
      cancelAnimationFrame(animation);
      wakeTimer = undefined;
      animation = undefined;
      boxes.clear();
      lastPresentedPts = -Infinity;
      displayedBbox = undefined;
      stats.lastPresentedPtsUs = null;
      stats.appliedBboxPtsUs = null;
      stats.frameId = null;
      stats.heldBboxAgeMs = null;
      const latest = showLatestFrame ? frames.pop() : undefined;
      for (const entry of frames.splice(0)) discard(entry);
      if (latest) present(latest);
    },
    getStats() {
      return { ...stats, pendingFrames: frames.length, pendingBbox: boxes.size,
        oldestFrameAgeMs: frames.length ? performance.now() - frames[0].receivedAt : 0 };
    },
  };
}
