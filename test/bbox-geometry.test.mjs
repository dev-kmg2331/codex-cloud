import assert from 'node:assert/strict';
import test from 'node:test';
import { getBboxLabelRect, projectBboxRect } from '../frontend/src/bbox-geometry.js';

test('projects the exact stream-295 truck result after removing both 24px padding bands', () => {
  assert.deepEqual(projectBboxRect([1050, 439, 1138, 495], 1280, 768, 1920, 1080),
    [1575, 622.5, 1707, 706.5]);
});

test('maps the complete unpadded image to the complete output image', () => {
  assert.deepEqual(projectBboxRect([0, 24, 1280, 744], 1280, 768, 1920, 1080),
    [0, 0, 1920, 1080]);
});

test('removes fixed padding even when metadata and output resolutions are identical', () => {
  assert.deepEqual(projectBboxRect([0, 24, 1280, 744], 1280, 768, 1280, 768),
    [0, 0, 1280, 768]);
});

test('preserves horizontal proportions while restoring vertical content coordinates', () => {
  assert.deepEqual(projectBboxRect([100, 24, 200, 744], 1280, 768, 640, 360),
    [50, 0, 100, 360]);
});

test('clips a box crossing image edges and padding to visible image bounds', () => {
  assert.deepEqual(projectBboxRect([-10, 0, 1300, 768], 1280, 768, 1920, 1080),
    [0, 0, 1920, 1080]);
});

test('omits detections wholly inside padding or outside the horizontal image', () => {
  for (const rect of [[20, 0, 80, 24], [20, 744, 80, 768],
    [-20, 100, 0, 200], [1280, 100, 1320, 200]]) {
    assert.equal(projectBboxRect(rect, 1280, 768, 1920, 1080), null);
  }
});

test('omits degenerate, reversed, malformed, or nonfinite rectangles', () => {
  for (const rect of [[50, 100, 50, 200], [50, 100, 100, 100],
    [100, 100, 50, 200], [50, 200, 100, 100], [50, NaN, 100, 200],
    [50, 100, Infinity, 200], [50, 100, 100], null, {}]) {
    assert.equal(projectBboxRect(rect, 1280, 768, 1920, 1080), null);
  }
});

test('rejects invalid dimensions and metadata with no content between padding bands', () => {
  for (const dimensions of [[0, 768, 1920, 1080], [1280, 48, 1920, 1080],
    [1280, 47, 1920, 1080], [1280, 768, 0, 1080], [1280, 768, 1920, -1],
    [NaN, 768, 1920, 1080], [1280, Infinity, 1920, 1080]]) {
    assert.equal(projectBboxRect([50, 100, 100, 200], ...dimensions), null);
  }
});

test('does not mutate broker rectangle coordinates', () => {
  const rect = Object.freeze([1050, 439, 1138, 495]);
  projectBboxRect(rect, 1280, 768, 1920, 1080);
  assert.deepEqual(rect, [1050, 439, 1138, 495]);
});

function assertLabelBounds(label, width, height) {
  assert.ok(label);
  const [x, y, w, h] = label;
  assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
  assert.ok(x + w <= width && y + h <= height);
}

test('places an object label above its box whenever there is space', () => {
  const label = getBboxLabelRect([100, 80, 200, 160], 120, 20, 400, 300);
  assertLabelBounds(label, 400, 300);
  assert.deepEqual(label.slice(2), [120, 20]);
  assert.ok(label[1] + label[3] < 80, 'Label must remain outside the object');
});

test('places a label below the box when the top edge has no room', () => {
  const label = getBboxLabelRect([100, 5, 200, 100], 120, 20, 400, 300);
  assertLabelBounds(label, 400, 300);
  assert.ok(label[1] > 100);
});

test('clamps a top label horizontally so it stays on screen near the right edge', () => {
  const label = getBboxLabelRect([380, 100, 399, 180], 120, 20, 400, 300);
  assertLabelBounds(label, 400, 300);
  assert.equal(label[0] + label[2], 400);
  assert.ok(label[1] + label[3] < 100);
});

test('uses the right side when neither vertical side has enough room', () => {
  const label = getBboxLabelRect([100, 5, 150, 95], 60, 20, 300, 100);
  assertLabelBounds(label, 300, 100);
  assert.ok(label[0] > 150);
});

test('uses the left side when top, bottom and right have no room', () => {
  const label = getBboxLabelRect([200, 5, 295, 95], 100, 20, 300, 100);
  assertLabelBounds(label, 300, 100);
  assert.ok(label[0] + label[2] < 200);
});

test('omits a label instead of drawing over an object that fills the image', () => {
  assert.equal(getBboxLabelRect([0, 0, 300, 100], 80, 20, 300, 100), null);
});

test('omits labels whose size cannot fit the image', () => {
  for (const [width, height] of [[301, 20], [80, 101], [0, 20], [80, -1],
    [NaN, 20], [80, Infinity]]) {
    assert.equal(getBboxLabelRect([100, 30, 200, 70], width, height, 300, 100), null);
  }
});
