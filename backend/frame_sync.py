"""Join detection results to the identical H.264 frame in a viewer's stream."""
from collections import deque
from time import monotonic

MAX_FRAME_HISTORY = 128
MAX_WAITING_BOXES = 32
MATCH_WINDOW_SECONDS = 2


class FrameMatcher:
    def __init__(self):
        self.frames = deque(maxlen=MAX_FRAME_HISTORY)
        self.boxes = {}

    def clear(self):
        self.frames.clear()
        self.boxes.clear()

    def add_frame(self, signature, pts_us):
        self.frames.append((signature, pts_us, monotonic()))
        pending = self.boxes.pop(signature, None)
        if pending is not None:
            message, received = pending
            if monotonic() - received <= MATCH_WINDOW_SECONDS:
                return self.add_bbox(signature, message)
        return None

    def add_bbox(self, signature, message):
        now = monotonic()
        matches = {pts for digest, pts, seen in self.frames
                   if digest == signature and now - seen <= MATCH_WINDOW_SECONDS}
        if len(matches) == 1:
            return {**message, 'ptsUs': matches.pop()}
        if not matches:
            if signature not in self.boxes and len(self.boxes) >= MAX_WAITING_BOXES:
                del self.boxes[next(iter(self.boxes))]
            self.boxes[signature] = (message, now)
        return None
