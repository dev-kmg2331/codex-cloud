// Detection coordinates always include 24px at both the top and bottom.
const verticalPadding = 24;
const positive = value => Number.isFinite(value) && value > 0;
const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
const validRect = rect => Array.isArray(rect) && rect.length === 4
  && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1];

export function projectBboxRect(rect, bboxWidth, bboxHeight, videoWidth, videoHeight) {
  if (!validRect(rect) || ![bboxWidth, bboxHeight, videoWidth, videoHeight].every(positive)
      || bboxHeight <= verticalPadding * 2) return null;
  const scaleX = videoWidth / bboxWidth;
  const scaleY = videoHeight / (bboxHeight - verticalPadding * 2);
  const projected = [
    clamp(rect[0] * scaleX, videoWidth),
    clamp((rect[1] - verticalPadding) * scaleY, videoHeight),
    clamp(rect[2] * scaleX, videoWidth),
    clamp((rect[3] - verticalPadding) * scaleY, videoHeight),
  ];
  return validRect(projected) ? projected : null;
}

export function getBboxLabelRect(rect, labelWidth, labelHeight, videoWidth, videoHeight) {
  if (!validRect(rect) || ![labelWidth, labelHeight, videoWidth, videoHeight].every(positive)
      || labelWidth > videoWidth || labelHeight > videoHeight) return null;
  const [x1, y1, x2, y2] = rect;
  // Keep the label background clear of the box stroke as well as its interior.
  const gap = Math.max(2, videoWidth / 320);
  const x = clamp(x1, videoWidth - labelWidth);
  if (y1 - gap - labelHeight >= 0) return [x, y1 - gap - labelHeight, labelWidth, labelHeight];
  if (y2 + gap + labelHeight <= videoHeight) return [x, y2 + gap, labelWidth, labelHeight];
  const y = clamp(y1, videoHeight - labelHeight);
  if (x2 + gap + labelWidth <= videoWidth) return [x2 + gap, y, labelWidth, labelHeight];
  if (x1 - gap - labelWidth >= 0) return [x1 - gap - labelWidth, y, labelWidth, labelHeight];
  return null;
}
