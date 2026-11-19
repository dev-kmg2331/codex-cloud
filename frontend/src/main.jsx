import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createFramePlayout } from './playout.js';
import { createPlaybackSampler } from './playback-stats.js';
import { getBboxLabelRect, projectBboxRect } from './bbox-geometry.js';
import './style.css';

const layouts = [4, 9, 16];
const cameraDragType = 'application/x-rtsp-camera';
const accelerationStorageKey = 'rtsp-live.hardwareAcceleration';
const infoOverlayStorageKey = 'rtsp-live.infoOverlay';
const cameraTime = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

function PlaybackInfo({ session, number, bboxAvailable, bboxEnabled, bboxError, compact }) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    const sampler = createPlaybackSampler();
    function sample() {
      const current = session.current;
      if (!current) return;
      const snapshot = sampler.sample(current.getStats());
      if (snapshot) setStats(snapshot);
    }
    sample();
    const timer = setInterval(sample, 1000);
    return () => clearInterval(timer);
  }, [session, bboxAvailable, bboxEnabled, bboxError]);

  const numeric = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const percent = (value, digits = 1) => Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
  const pts = value => Number.isFinite(value) ? `${(value / 1_000_000).toFixed(3)}s` : '—';
  const bitrate = Number.isFinite(stats?.bitrateBps)
    ? stats.bitrateBps >= 1_000_000 ? `${(stats.bitrateBps / 1_000_000).toFixed(2)} Mbps`
      : `${Math.round(stats.bitrateBps / 1000)} kbps` : '—';
  const bboxActive = bboxAvailable && bboxEnabled && !bboxError;
  const bboxState = !bboxAvailable ? '미지원' : bboxError ? '오류' : !bboxEnabled ? 'OFF'
    : stats?.appliedBboxPtsUs == null ? '대기' : 'ON';
  const frameId = bboxActive && stats?.frameId != null ? String(stats.frameId) : '—';
  const automaticWait = bboxActive ? `${numeric(stats?.bboxPlayoutDelayMs)}ms` : bboxState;
  const reasons = stats?.droppedFrameReasons;

  if (compact) return <div className="tile-info" data-compact="true" role="group"
    aria-label={`${number}번 타일 재생 정보 요약`} aria-live="off">
    <div className="tile-info-line" aria-label="FPS 수신/디코딩/표시">
      <span>FPS 수/디/표</span><b>{numeric(stats?.receiveFps)}/{numeric(stats?.decodeFps)}/{numeric(stats?.renderFps)}</b>
    </div>
    <div className="tile-info-line">
      <span>자동 <b>{automaticWait}</b></span>
      <span>큐/대기 <b>{numeric(stats?.decodeQueueSize)}/{numeric(stats?.pendingFrames)}</b></span>
    </div>
    <div className="tile-info-line" aria-label="최근 5초 표시 버림률과 늦은 BBox 비율">
      <span>최근 버림 <b>{percent(stats?.dropRatePercent, 0)}</b></span>
      <span>늦음 <b>{percent(stats?.lateBboxRatePercent, 0)}</b></span>
    </div>
    <div className="tile-info-line tile-info-frame"><span>BBox ID</span><b>{frameId}</b></div>
  </div>;

  return <div className="tile-info" role="group" aria-label={`${number}번 타일 재생 정보`} aria-live="off">
    <div className="tile-info-line">
      <span>FPS 수신/디코드/표시</span>
      <b>{numeric(stats?.receiveFps)}/{numeric(stats?.decodeFps)}/{numeric(stats?.renderFps)}</b>
    </div>
    <div className="tile-info-line tile-info-media">
      <span>{stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '—'}</span>
      <span>{stats?.codec || '—'}</span>
      <span>{bitrate}</span>
    </div>
    <div className="tile-info-line" title="디코드 소요는 패킷의 디코딩 제출부터 출력까지, 그리기 소요는 화면에 그리는 작업 시간입니다.">
      <span>디코드 <b>{numeric(stats?.decodeLatencyMs, 1)} ms</b></span>
      <span>그리기 <b>{numeric(stats?.renderDurationMs, 1)} ms</b></span>
    </div>
    <div className="tile-info-line">
      <span>자동 대기 <b>{automaticWait}</b></span>
      <span>큐/표시 대기 <b>{numeric(stats?.decodeQueueSize)}/{numeric(stats?.pendingFrames)}</b></span>
    </div>
    <div className="tile-info-line tile-info-rates">
      <span>표시 버림 최근 5초 <b>{percent(stats?.dropRatePercent)}</b></span>
      <span>누적 <b>{numeric(stats?.droppedFrames)}</b></span>
    </div>
    <div className="tile-info-line tile-info-rates">
      <span>늦은 BBox 최근 5초 <b>{percent(stats?.lateBboxRatePercent)}</b></span>
      <span>누적 <b>{numeric(stats?.lateBbox)}</b></span>
    </div>
    <div className="tile-info-line tile-info-reasons">
      <span>원인 최신선택 <b>{numeric(reasons?.coalesced)}</b></span>
      <span>기한 <b>{numeric(reasons?.expired)}</b></span>
      <span>큐초과 <b>{numeric(reasons?.overflow)}</b></span>
    </div>
    <div className="tile-info-line tile-info-reasons">
      <span>초기화 <b>{numeric(reasons?.reset)}</b></span>
      <span>그리기 취소 <b>{numeric(reasons?.renderSkipped)}</b></span>
    </div>
    <div className="tile-info-line">
      <span>디코더 큐 복구 <b>{numeric(stats?.decoderResets)}</b></span>
      <span>키대기 생략 <b>{numeric(stats?.keyframeWaitFrames)}</b></span>
    </div>
    <div className="tile-info-line tile-info-pts">
      <span>영상 PTS <b>{pts(stats?.lastPresentedPtsUs)}</b></span>
      <span>BBox PTS <b>{bboxActive ? pts(stats?.appliedBboxPtsUs) : '—'}</b> <em>{bboxState}</em></span>
    </div>
    <div className="tile-info-line">
      <span>영상−BBox <b>{bboxActive && Number.isFinite(stats?.heldBboxAgeMs) ? `${numeric(stats.heldBboxAgeMs, 1)} ms` : '—'}</b></span>
      <span className="tile-info-note">좌표 기준 시차</span>
    </div>
    <div className="tile-info-line tile-info-frame">
      <span>BBox frame ID</span><b>{frameId}</b>
    </div>
  </div>;
}

function drawBbox(canvas, frame, bbox, colors) {
  if (!bbox?.boxes.length) {
    if (canvas.width > 0) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  const fontSize = Math.max(12, width / 64);
  const pad = fontSize * 0.25;
  context.font = `${fontSize}px system-ui, sans-serif`;
  context.textBaseline = 'top';
  context.strokeStyle = colors.accent;
  context.lineWidth = Math.max(2, width / 320);

  for (const { label, rect } of bbox.boxes) {
    const projected = projectBboxRect(rect, bbox.width, bbox.height, width, height);
    if (!projected) continue;
    const [x1, y1, x2, y2] = projected;
    context.strokeRect(x1, y1, x2 - x1, y2 - y1);
    if (label) {
      const labelRect = getBboxLabelRect(projected, context.measureText(label).width + pad * 2,
        fontSize + pad * 2, width, height);
      if (!labelRect) continue;
      const [x, y, labelWidth, labelHeight] = labelRect;
      context.fillStyle = colors.accent;
      context.fillRect(x, y, labelWidth, labelHeight);
      context.fillStyle = colors.background;
      context.fillText(label, x + pad, y + pad);
    }
  }
}

function Camera({ ref, number, visible, selected, onSelect, onCameraDrop, supported, hardwareAcceleration, infoOverlay, compactInfo }) {
  const canvas = useRef(null);
  const overlay = useRef(null);
  const session = useRef(null);
  const isVisible = useRef(visible);
  isVisible.current = visible;
  const [camera, setCamera] = useState(null);
  const [bboxEnabled, setBboxEnabled] = useState(false);
  const [bboxError, setBboxError] = useState('');
  const [videoSize, setVideoSize] = useState(null);
  const [status, setStatus] = useState('');
  const [active, setActive] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const playing = active && videoSize !== null;
  const channelName = camera?.name || '빈 타일';
  const channelNumber = String(number).padStart(2, '0');
  const tileState = playing ? 'LIVE' : active ? '연결 중' : camera ? '연결 실패' : '';

  function stop(update = true) {
    const current = session.current;
    session.current = null;
    if (current) {
      current.playout.reset();
      current.ws.close();
      if (current.decoder?.state !== 'closed') current.decoder?.close();
    }
    if (update) {
      resetBbox();
      setActive(false);
      setCamera(null);
      setVideoSize(null);
      setStatus('');
      const target = canvas.current;
      target.getContext('2d').clearRect(0, 0, target.width, target.height);
    }
  }
  useEffect(() => () => stop(false), []);

  useEffect(() => {
    if (!visible && session.current) {
      session.current.playout.reset();
      drawBbox(overlay.current);
      session.current.overlayDirty = true;
    }
  }, [visible]);

  function resetBbox(enabled = false) {
    overlay.current.width = 0;
    overlay.current.height = 0;
    if (session.current) session.current.overlayDirty = true;
    setBboxEnabled(enabled);
    setBboxError('');
  }

  function changeBbox(enabled) {
    const current = session.current;
    if (!current?.camera.bboxAvailable || current.bboxEnabled === enabled) return;
    current.bboxEnabled = enabled;
    current.bboxRevision++;
    resetBbox(enabled);
    current.playout.reset(!enabled);
    if (current.ws.readyState === WebSocket.OPEN) {
      current.ws.send(JSON.stringify({ type: 'bbox', enabled, bboxRevision: current.bboxRevision }));
    }
  }

  useEffect(() => {
    const current = session.current;
    if (!current || current.hardwareAcceleration === hardwareAcceleration) return;
    current.hardwareAcceleration = hardwareAcceleration;
    if (!current.decoder || !current.config) return;
    try {
      current.playout.reset();
      current.decodeStarts.clear();
      drawBbox(overlay.current);
      current.overlayDirty = true;
      current.decoder.reset();
      current.config = { ...current.config, hardwareAcceleration };
      current.decoder.configure(current.config);
      current.needsKey = true;
      current.waitingForFrame = true;
      setStatus('가속 설정 변경 · 키프레임 대기 중…');
    } catch (error) {
      current.fail(error.message);
    }
  }, [hardwareAcceleration]);

  useImperativeHandle(ref, () => ({ play: connect, changeBbox,
    getStats: () => session.current?.getStats() ?? null }));

  function connect(source, enableBbox) {
    stop(false);
    const initialBbox = Boolean(source.bboxAvailable && enableBbox);
    resetBbox(initialBbox);
    setCamera(source);
    setVideoSize(null);
    const target = canvas.current;
    target.getContext('2d').clearRect(0, 0, target.width, target.height);
    setStatus('연결 중…');
    setActive(true);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream`);
    ws.binaryType = 'arraybuffer';
    const current = {
      ws, camera: source, decoder: null, needsKey: true, config: null, hardwareAcceleration,
      bboxEnabled: initialBbox, bboxRevision: 0,
      metrics: { receivedFrames: 0, receivedBytes: 0, decodedFrames: 0, hiddenFrames: 0,
        decodeLatencyMs: 0, renderDurationMs: 0, decoderResets: 0, keyframeWaitFrames: 0 },
      decodeStarts: new Map(), overlayDirty: true, lastStatsAt: -Infinity,
    };
    session.current = current;
    const valid = () => session.current === current;
    function fail(message) {
      if (!valid()) return;
      stop(false);
      resetBbox();
      setActive(false);
      setStatus(message);
    }
    current.fail = fail;
    current.getStats = () => ({ ...current.metrics, ...current.playout.getStats(),
      decodeQueueSize: current.decoder?.decodeQueueSize ?? 0,
      width: current.videoWidth ?? null, height: current.videoHeight ?? null,
      codec: current.config?.codec ?? null, bboxAvailable: Boolean(current.camera.bboxAvailable),
      bboxEnabled: current.bboxEnabled });
    function updateStats() {
      const now = performance.now();
      if (now - current.lastStatsAt < 1000) return;
      current.lastStatsAt = now;
      target.dataset.playbackStats = JSON.stringify(current.getStats());
    }
    const style = getComputedStyle(target);
    const colors = {
      accent: style.getPropertyValue('--accent').trim(),
      background: style.getPropertyValue('--video').trim(),
    };
    current.playout = createFramePlayout((frame, bbox) => {
      if (!valid() || !isVisible.current) return false;
      try {
        const renderStart = performance.now();
        const sizeChanged = target.width !== frame.displayWidth || target.height !== frame.displayHeight;
        if (sizeChanged) {
          target.width = frame.displayWidth;
          target.height = frame.displayHeight;
        }
        if (current.videoWidth !== frame.displayWidth || current.videoHeight !== frame.displayHeight) {
          current.videoWidth = frame.displayWidth;
          current.videoHeight = frame.displayHeight;
          setVideoSize({ width: frame.displayWidth, height: frame.displayHeight });
        }
        target.getContext('2d').drawImage(frame, 0, 0);
        if (current.overlayDirty || sizeChanged || current.lastDrawnBbox !== bbox) {
          drawBbox(overlay.current, frame, bbox, colors);
          current.lastDrawnBbox = bbox;
          current.overlayDirty = false;
        }
        current.metrics.renderDurationMs = performance.now() - renderStart;
        updateStats();
        if (current.waitingForFrame) {
          current.waitingForFrame = false;
          setStatus('');
        }
      } catch (error) {
        fail(error.message);
        return false;
      }
    });
    ws.onopen = () => {
      if (valid()) ws.send(JSON.stringify({
        cameraId: source.id, bbox: current.bboxEnabled, bboxRevision: current.bboxRevision,
      }));
    };
    ws.onerror = () => fail('WebSocket 연결에 실패했습니다. 서버 상태를 확인하세요.');
    ws.onclose = () => { if (valid()) fail('서버 연결이 종료되었습니다. 다시 연결할 수 있습니다.'); };
    ws.onmessage = ({ data }) => {
      if (!valid()) return;
      try {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (message.type === 'error') { fail(message.message); return; }
          if (message.type === 'bbox' || message.type === 'bbox_error') {
            if (!current.bboxEnabled || message.bboxRevision !== current.bboxRevision) return;
            if (message.type === 'bbox_error') {
              current.bboxEnabled = false;
              resetBbox();
              current.playout.reset(true);
              setBboxError(message.message);
              return;
            }
            if (!Number.isSafeInteger(message.ptsUs) || !Array.isArray(message.boxes)
                || !Number.isFinite(message.width) || message.width <= 0
                || !Number.isFinite(message.height) || message.height <= 0
                || message.boxes.some(box => !Array.isArray(box?.rect) || box.rect.length !== 4
                  || !box.rect.every(Number.isFinite) || typeof box.label !== 'string')) return;
            current.playout.addBbox(message);
            return;
          }
          if (message.type === 'config') {
            if (current.decoder) {
              current.playout.reset();
              current.decodeStarts.clear();
              drawBbox(overlay.current);
              current.overlayDirty = true;
              if (current.decoder.state !== 'closed') current.decoder.close();
            }
            current.config = { codec: message.codec, hardwareAcceleration: current.hardwareAcceleration, optimizeForLatency: true };
            current.needsKey = true;
            current.waitingForFrame = true;
            current.decoder = new VideoDecoder({
              output(frame) {
                if (!valid()) { frame.close(); return; }
                current.metrics.decodedFrames++;
                const startedAt = current.decodeStarts.get(frame.timestamp);
                current.decodeStarts.delete(frame.timestamp);
                if (startedAt !== undefined) current.metrics.decodeLatencyMs = performance.now() - startedAt;
                if (isVisible.current) current.playout.addFrame(frame, current.bboxEnabled);
                else {
                  current.metrics.hiddenFrames++;
                  frame.close();
                  updateStats();
                }
              },
              error: () => fail('영상 디코딩 오류가 발생했습니다. 다시 연결하세요.'),
            });
            current.decoder.configure(current.config);
            setStatus('첫 프레임 대기 중…');
          }
          return;
        }
        if (data.byteLength <= 9 || !current.decoder) throw new Error('잘못된 영상 패킷입니다.');
        const header = new DataView(data);
        const key = header.getUint8(0) === 1;
        current.metrics.receivedFrames++;
        current.metrics.receivedBytes += data.byteLength - 9;
        if (current.decoder.decodeQueueSize > 10) {
          current.metrics.decoderResets++;
          current.playout.reset();
          current.decodeStarts.clear();
          drawBbox(overlay.current);
          current.overlayDirty = true;
          current.decoder.reset();
          current.decoder.configure(current.config);
          current.needsKey = true;
        }
        if (current.needsKey && !key) {
          current.metrics.keyframeWaitFrames++;
          return;
        }
        current.needsKey = false;
        const timestamp = Number(header.getBigInt64(1));
        current.decodeStarts.set(timestamp, performance.now());
        if (current.decodeStarts.size > 32) current.decodeStarts.delete(current.decodeStarts.keys().next().value);
        current.decoder.decode(new EncodedVideoChunk({
          type: key ? 'key' : 'delta', timestamp, data: new Uint8Array(data, 9),
        }));
      } catch (error) { fail(error.message); }
    };
  }

  return <div className="tile" hidden={!visible} data-empty={!camera}>
    <button type="button" className="player" aria-pressed={selected}
      aria-label={`${number}번 타일 · ${channelName}`} aria-describedby={bboxError || status ? `tile-status-${number}` : undefined}
      title={bboxError || status || camera?.name} data-drop-target={dropTarget} onClick={onSelect}
      onDragOver={event => {
        if (supported && event.dataTransfer.types.includes(cameraDragType)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropTarget(true);
        }
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={event => {
        setDropTarget(false);
        if (!event.dataTransfer.types.includes(cameraDragType)) return;
        event.preventDefault();
        try {
          const ids = JSON.parse(event.dataTransfer.getData(cameraDragType));
          if (Array.isArray(ids)) onCameraDrop(ids);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }}>
      <span className="tile-video">
        <canvas ref={canvas} width="960" height="540" aria-hidden="true" />
        <canvas ref={overlay} width="0" height="0" hidden={!bboxEnabled} aria-hidden="true" />
        {!playing && <span className="tile-placeholder" aria-hidden="true">
          <span className="camera-icon" />
        </span>}
        <span className={`tile-badge${playing ? ' live' : ''}`} aria-hidden="true">
          {tileState || channelNumber}
        </span>
      </span>
      {camera && <span className="tile-caption" aria-hidden="true">
        <span className="tile-index">{channelNumber}</span><span className="tile-name">{channelName}</span>
      </span>}
    </button>
    {infoOverlay && visible && playing && <PlaybackInfo session={session} number={number}
      bboxAvailable={Boolean(camera?.bboxAvailable)} bboxEnabled={bboxEnabled} bboxError={bboxError} compact={compactInfo} />}
    {camera && <div className="tile-actions" role="group" aria-label={`${number}번 타일 설정`}>
      {camera.bboxAvailable && active && <button type="button" className="tile-bbox" aria-label={`bbox ${bboxEnabled ? 'ON' : 'OFF'}`}
        aria-pressed={bboxEnabled} title={bboxEnabled ? 'bbox 숨기기' : 'bbox 표시하기'}
        onClick={() => changeBbox(!bboxEnabled)}>
        <span className="bbox-icon" aria-hidden="true" /><span aria-hidden="true">{bboxEnabled ? 'ON' : 'OFF'}</span>
      </button>}
      <button type="button" className="disconnect" aria-label="연결 종료" title="연결 종료" onClick={() => stop()}>×</button>
    </div>}
    {(bboxError || status) && <p id={`tile-status-${number}`} className="tile-status"
      role={bboxError || !active ? 'alert' : 'status'}>{bboxError || status}</p>}
  </div>;
}

function parseCameraLines(value) {
  const cameras = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const separator = tab >= 0 ? tab : line.indexOf(',');
    const name = line.slice(0, separator).trim();
    const rtsp_url = line.slice(separator + 1).trim();
    if (separator < 0 || !name || !rtsp_url) {
      throw new Error(`${index + 1}줄에 카메라 이름과 RTSP 주소를 입력하세요.`);
    }
    cameras.push({ name, rtsp_url });
  }
  if (!cameras.length || cameras.length > 100) throw new Error('카메라를 1대에서 100대까지 입력하세요.');
  return cameras;
}

function CameraRegistration({ dialog, nameInput, onRegister }) {
  const [bulk, setBulk] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [lines, setLines] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setBulk(false);
    setName('');
    setUrl('');
    setLines('');
    setError('');
  }

  async function register(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const body = bulk ? { cameras: parseCameraLines(lines) } : { name: name.trim(), rtsp_url: url.trim() };
      const response = await fetch(bulk ? '/api/cameras/bulk' : '/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '카메라 등록에 실패했습니다.');
      onRegister(bulk ? result : [result]);
      dialog.current.close();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }

  return <dialog ref={dialog} className="registration-dialog" aria-labelledby="registration-title"
    onClose={reset} onCancel={event => { if (pending) event.preventDefault(); }}>
    <form className="registration" onSubmit={register}>
      <header className="registration-heading">
        <h2 id="registration-title">카메라 등록</h2>
        <button type="button" className="close-dialog" aria-label="등록 창 닫기" title="닫기"
          disabled={pending} onClick={() => dialog.current.close()}>×</button>
      </header>
      <div className="registration-modes segmented" role="group" aria-label="등록 방식">
        {[false, true].map(mode => <button key={String(mode)} type="button" aria-pressed={bulk === mode} disabled={pending}
          onClick={() => { setBulk(mode); setError(''); }}>{mode ? '일괄 등록' : '한 대 등록'}</button>)}
      </div>
      {bulk ? <>
        <label htmlFor="camera-lines">카메라 목록</label>
        <p className="hint" id="camera-lines-hint">한 줄에 이름과 RTSP 주소를 쉼표 또는 탭으로 구분하세요. 최대 100대까지 등록할 수 있습니다.</p>
        <textarea id="camera-lines" aria-describedby="camera-lines-hint" value={lines} rows={7} required disabled={pending}
          spellCheck="false" placeholder={'출입구,rtsp://camera-1/stream\n주차장,rtsp://camera-2/stream'} onChange={event => setLines(event.target.value)} />
      </> : <>
        <label htmlFor="camera-name">이름</label>
        <input id="camera-name" ref={nameInput} value={name} onChange={event => setName(event.target.value)}
          placeholder="예: 정문 출입구" maxLength={100} required disabled={pending} />
        <label htmlFor="camera-url">RTSP 주소</label>
        <input id="camera-url" type="text" autoComplete="off" spellCheck="false" value={url}
          onChange={event => setUrl(event.target.value)} placeholder="rtsp://camera/stream" maxLength={4096} required disabled={pending} />
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="registration-actions">
        <button type="button" disabled={pending} onClick={() => dialog.current.close()}>취소</button>
        <button className="primary" disabled={pending}>{pending ? '등록 중…' : '등록'}</button>
      </div>
    </form>
  </dialog>;
}

function CameraLibrary({ cameras, selected, supported, onPlay, onRegister, loadError, lastRefresh, onRetry, placementMessage }) {
  const [query, setQuery] = useState('');
  const [checkedIds, setCheckedIds] = useState(new Set());
  const dialog = useRef(null);
  const nameInput = useRef(null);
  const visibleCameras = cameras.filter(camera => camera.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const checkedCameras = cameras.filter(camera => checkedIds.has(camera.id));
  const checkedVisibleCount = visibleCameras.filter(camera => checkedIds.has(camera.id)).length;
  const allVisibleChecked = visibleCameras.length > 0 && checkedVisibleCount === visibleCameras.length;

  function setChecked(items, checked) {
    setCheckedIds(current => {
      const next = new Set(current);
      for (const { id } of items) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function dragCamera(event, camera) {
    const ids = checkedIds.has(camera.id) ? checkedCameras.map(item => item.id) : [camera.id];
    event.dataTransfer.setData(cameraDragType, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'copy';
  }

  const loading = !lastRefresh && !loadError;
  const filtering = query.trim().length > 0;

  return <aside className="library" aria-labelledby="library-title">
    <div className="library-heading">
      <h2 id="library-title">카메라 목록</h2>
      {lastRefresh && <span className="camera-count">{cameras.length}대</span>}
      <button type="button" className="add-camera" aria-label="카메라 등록" aria-haspopup="dialog"
        title="카메라 등록" onClick={() => { dialog.current.showModal(); nameInput.current?.focus(); }}>+</button>
    </div>
    <div className="search-field">
      <span className="search-icon" aria-hidden="true" />
      <input className="camera-search" type="search" aria-label="카메라 이름 검색" placeholder="카메라 이름 검색"
        value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="camera-selection">
      <label><input type="checkbox" checked={allVisibleChecked} disabled={!visibleCameras.length}
        ref={input => { if (input) input.indeterminate = checkedVisibleCount > 0 && !allVisibleChecked; }}
        onChange={event => setChecked(visibleCameras, event.target.checked)} />
        {filtering ? '검색 결과 전체 선택' : '전체 선택'}</label>
      <span>{filtering && `결과 ${visibleCameras.length}대`}</span>
    </div>
    {loadError && <div className="library-error">
      <p role="alert">{loadError}</p>
      {lastRefresh && <span className="hint">마지막 갱신 {cameraTime.format(lastRefresh)}</span>}
      <button type="button" onClick={onRetry}>다시 시도</button>
    </div>}
    {loading && <p className="list-feedback" role="status">카메라 목록을 불러오는 중…</p>}
    <ul className="camera-list" aria-label="검색 결과" aria-busy={loading}>
      {visibleCameras.map(camera => <li key={camera.id}>
        <input type="checkbox" aria-label={`${camera.name} 선택`} checked={checkedIds.has(camera.id)}
          onChange={event => setChecked([camera], event.target.checked)} />
        <button type="button" disabled={!supported} draggable={supported} onClick={() => onPlay([camera.id])}
          onDragStart={event => dragCamera(event, camera)} title={camera.name}>
          <span className="camera-icon" aria-hidden="true" /><span className="camera-name">{camera.name}</span>
          <span className="play-icon" aria-hidden="true" />
        </button>
      </li>)}
      {!loading && !loadError && visibleCameras.length === 0 &&
        <li className="empty-list list-feedback">{cameras.length ? '검색 결과가 없습니다.' : '등록된 카메라가 없습니다. + 버튼으로 등록하세요.'}</li>}
    </ul>
    <footer className="library-footer">
      {checkedCameras.length > 0 ? <>
        <div className="selection-actions">
          <span>{checkedCameras.length}대 선택</span>
          <button type="button" onClick={() => setCheckedIds(new Set())}>해제</button>
          <button type="button" className="primary" disabled={!supported}
            onClick={() => onPlay(checkedCameras.map(camera => camera.id))}>선택 배치</button>
        </div>
        <p className="hint">{selected}번 타일부터 배치하거나 목록에서 끌어 놓으세요.</p>
      </> : <p className="hint">카메라를 클릭하면 {selected}번 타일에서 재생합니다. 원하는 타일로 끌어 놓을 수도 있습니다.</p>}
      <p className="hint placement-message" role="status" hidden={!placementMessage}>{placementMessage}</p>
    </footer>
    <CameraRegistration dialog={dialog} nameInput={nameInput} onRegister={onRegister} />
  </aside>;
}

function App() {
  const [compactViewport, setCompactViewport] = useState(() => matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 900px)');
    const update = event => setCompactViewport(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [layout, setLayout] = useState(4);
  const [enableBboxOnPlay, setEnableBboxOnPlay] = useState(false);
  const [accelerationEnabled, setAccelerationEnabled] = useState(() => {
    try { return localStorage.getItem(accelerationStorageKey) !== 'off'; }
    catch { return true; }
  });
  const [infoOverlay, setInfoOverlay] = useState(() => {
    try { return localStorage.getItem(infoOverlayStorageKey) === 'on'; }
    catch { return false; }
  });
  const [selected, setSelected] = useState(1);
  const [supported, setSupported] = useState(false);
  const [supportError, setSupportError] = useState('');
  const [cameras, setCameras] = useState([]);
  const [cameraListRevision, setCameraListRevision] = useState(0);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [placementMessage, setPlacementMessage] = useState('');
  const players = useRef({});

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refreshCameras() {
      try {
        const response = await fetch('/api/cameras', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const list = await response.json();
        if (!controller.signal.aborted) {
          setCameras(list);
          setLastRefresh(new Date());
          setLoadError('');
        }
      } catch {
        if (!controller.signal.aborted) setLoadError('카메라 목록을 불러오지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refreshCameras, 3000);
      }
    }
    refreshCameras();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [cameraListRevision]);

  function addRegisteredCameras(registered) {
    setCameras(current => [...current, ...registered.filter(camera => !current.some(item => item.id === camera.id))]);
    setCameraListRevision(revision => revision + 1);
    setPlacementMessage(`카메라 ${registered.length}대를 등록했습니다.`);
  }

  useEffect(() => {
    async function checkSupport() {
      try {
        if (!isSecureContext || !('VideoDecoder' in window)) throw new Error('WebCodecs를 지원하는 Chrome/Edge에서 HTTPS 또는 localhost로 접속하세요.');
        const result = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' });
        if (!result.supported) throw new Error('H.264 디코딩을 지원하지 않는 브라우저입니다.');
        setSupported(true);
      } catch (error) {
        setSupportError(error.message);
      }
    }
    checkSupport();
  }, []);

  function changeLayout(count) {
    setLayout(count);
    if (selected > count) setSelected(1);
  }

  function changeAllBbox(enabled) {
    setEnableBboxOnPlay(enabled);
    for (const player of Object.values(players.current)) player?.changeBbox(enabled);
  }

  function changeAcceleration(enabled) {
    setAccelerationEnabled(enabled);
    try { localStorage.setItem(accelerationStorageKey, enabled ? 'on' : 'off'); }
    catch { /* Keep the setting for this page if browser storage is unavailable. */ }
  }

  function changeInfoOverlay() {
    const enabled = !infoOverlay;
    setInfoOverlay(enabled);
    try { localStorage.setItem(infoOverlayStorageKey, enabled ? 'on' : 'off'); }
    catch { /* Keep the setting for this page if browser storage is unavailable. */ }
  }

  function playCameras(cameraIds, target) {
    if (!supported) return;
    const requested = new Set(cameraIds);
    const matching = cameras.filter(camera => requested.has(camera.id));
    const placement = matching.slice(0, layout - target + 1);
    if (!placement.length) return;
    setSelected(target);
    placement.forEach((camera, index) => players.current[target + index]?.play(camera, enableBboxOnPlay));
    const skipped = matching.length - placement.length;
    const summary = `${target}번 타일부터 ${placement.length}대 연결을 시작했습니다.`;
    setPlacementMessage(matching.length === 1 ? '' : skipped ? `${summary} 타일이 부족해 ${skipped}대는 배치하지 못했습니다.` : summary);
  }

  return <main>
    <header className="app-bar">
      <div className="app-brand">
        <span className="app-icon" aria-hidden="true"><span className="camera-icon" /></span>
        <h1>RTSP Live</h1>
      </div>
      <div className="app-controls">
        <div className="bbox-all" role="group" aria-label="전체 bbox">
          <span className="control-label">전체 bbox</span>
          <div className="segmented" title="전체 타일에 적용하고 새 재생의 기본값을 설정합니다.">
            <button type="button" aria-label="전체 bbox 켜기" aria-pressed={enableBboxOnPlay} onClick={() => changeAllBbox(true)}>ON</button>
            <button type="button" aria-label="전체 bbox 끄기" aria-pressed={!enableBboxOnPlay} onClick={() => changeAllBbox(false)}>OFF</button>
          </div>
        </div>
        <label className="acceleration-switch" title="ON은 브라우저가 선택하고 OFF는 소프트웨어 디코딩을 우선합니다.">
          <span className="control-label">하드웨어 가속</span>
          <input type="checkbox" role="switch" checked={accelerationEnabled}
            onChange={event => changeAcceleration(event.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
        </label>
        <button type="button" className="info-overlay-toggle" aria-pressed={infoOverlay}
          title="재생 정보를 초당 한 번 표시합니다. 디코드는 패킷의 디코딩 제출부터 출력까지, 그리기는 화면에 그리는 소요 시간입니다. 영상−BBox는 마지막 탐지 결과의 좌표 기준 시차이며, 네트워크 전체 지연이 아닙니다."
          onClick={changeInfoOverlay}>
          <span className="info-icon" aria-hidden="true">i</span>정보 오버레이 <span>{infoOverlay ? 'ON' : 'OFF'}</span>
        </button>
      </div>
    </header>
    {supportError && <p className="support-error" role="alert">{supportError}</p>}
    <div className="workspace">
      <section className="monitor" aria-labelledby="monitor-title">
        <div className="monitor-toolbar">
          <div className="monitor-heading">
            <h2 id="monitor-title">실시간 모니터링</h2>
            <span className="selected-tile"><strong>{String(selected).padStart(2, '0')}</strong>번 타일 선택</span>
          </div>
          <div className="layouts segmented" role="group" aria-label="화면 분할">
            {layouts.map(count => <button key={count} type="button" aria-label={`${count}분할`} title={`${count}분할`} aria-pressed={layout === count} onClick={() => changeLayout(count)}>
              <span className="layout-icon" style={{ '--size': Math.sqrt(count) }} aria-hidden="true">
                {Array.from({ length: count }, (_, index) => <span key={index} />)}
              </span>
              {count}
            </button>)}
          </div>
        </div>
        <div className="wall" style={{ '--columns': Math.sqrt(layout) }} data-info-overlay={infoOverlay}>
          {Array.from({ length: 16 }, (_, index) => {
            const number = index + 1;
            return <Camera key={number} ref={player => { players.current[number] = player; }} number={number}
              visible={number <= layout} selected={number === selected} onSelect={() => setSelected(number)}
              onCameraDrop={ids => playCameras(ids, number)} supported={supported}
              hardwareAcceleration={accelerationEnabled ? 'no-preference' : 'prefer-software'} infoOverlay={infoOverlay}
              compactInfo={layout >= 9 || compactViewport} />;
          })}
        </div>
      </section>
      <CameraLibrary cameras={cameras} selected={selected} supported={supported} loadError={loadError}
        lastRefresh={lastRefresh} onRetry={() => setCameraListRevision(revision => revision + 1)}
        placementMessage={placementMessage} onPlay={ids => playCameras(ids, selected)} onRegister={addRegisteredCameras} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
