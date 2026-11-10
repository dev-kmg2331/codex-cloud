"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("video");
const context = canvas.getContext("2d", { alpha: false });
let active = null;
let supported = false;

function log(message, error = false) {
  const row = document.createElement("div");
  row.className = `log-entry${error ? " log-error" : ""}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const text = document.createElement("span");
  text.textContent = message;
  row.append(time, text);
  $("logs").append(row);
  while ($("logs").children.length > 100) $("logs").firstChild.remove();
  $("logs").scrollTop = $("logs").scrollHeight;
}

function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

function setControls(running) {
  $("settings").disabled = running;
  $("rtsp-url").disabled = running;
  $("toggle-stream").classList.toggle("running", running);
  $("button-icon").textContent = running ? "■" : "▶";
  $("button-text").textContent = running ? "스트리밍 중지" : "스트리밍 시작";
}

function finish(session, message = "스트리밍을 중지했습니다.", error = false) {
  if (active !== session) return;
  active = null;
  clearInterval(session.timer);
  clearTimeout(session.firstFrameTimer);
  session.pending.clear();
  if (session.decoder && session.decoder.state !== "closed")
    session.decoder.close();
  if (session.socket.readyState < WebSocket.CLOSING) session.socket.close();
  setControls(false);
  $("stream-status").textContent = error ? "연결 오류" : "중지됨";
  $("stream-status").classList.remove("live");
  $("video-overlay").hidden = true;
  $("metric-fps").textContent = "—";
  $("metric-bitrate").textContent = "—";
  $("metric-latency").textContent = "—";
  if (error) notice(message);
  log(message, error);
}

function resetMetrics() {
  for (const id of ["metric-fps", "metric-bitrate", "metric-latency"])
    $(id).textContent = "—";
  $("metric-frames").textContent = "0";
  $("elapsed").textContent = "00:00";
}

async function start() {
  if (!supported) return;
  const rtspUrl = $("rtsp-url").value.trim();
  try {
    const url = new URL(rtspUrl);
    if (
      !["rtsp:", "rtsps:"].includes(url.protocol) ||
      !url.hostname ||
      /\s/.test(rtspUrl) ||
      rtspUrl.length > 2048
    )
      throw new Error();
  } catch {
    notice("rtsp:// 또는 rtsps://로 시작하는 올바른 RTSP 주소를 입력하세요.");
    $("rtsp-url").focus();
    return;
  }
  notice();
  resetMetrics();
  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/stream`,
  );
  socket.binaryType = "arraybuffer";
  const session = {
    socket,
    decoder: null,
    pending: new Map(),
    frames: 0,
    intervalFrames: 0,
    bytes: 0,
    latencySum: 0,
    latencySamples: 0,
    needsKeyframe: true,
    started: performance.now(),
    lastTick: performance.now(),
    config: null,
  };
  active = session;
  setControls(true);
  $("stream-status").textContent = "연결 중";
  log("Python 서버를 통해 RTSP 소스에 연결합니다.");
  session.firstFrameTimer = setTimeout(() => {
    finish(
      session,
      "영상 수신 시간이 초과되었습니다. RTSP 주소와 카메라 상태를 확인하세요.",
      true,
    );
  }, 20000);

  socket.onopen = () => {
    if (active !== session) return;
    // Credentials stay in the WebSocket body; never include them in URL query,
    // browser logs, page history, or persistent storage.
    socket.send(JSON.stringify({ type: "start", rtspUrl }));
    log("WebSocket 연결 완료 · RTSP 영상 준비 중");
  };

  socket.onmessage = async (event) => {
    if (active !== session) return;
    try {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "error") {
          finish(session, message.message, true);
          return;
        }
        if (message.type !== "config" || session.decoder)
          throw new Error("Unexpected configuration");
        session.config = {
          codec: message.codec,
          codedWidth: message.width,
          codedHeight: message.height,
          optimizeForLatency: true,
        };
        const support = await VideoDecoder.isConfigSupported(session.config);
        if (active !== session) return;
        if (!support.supported) {
          finish(
            session,
            `이 브라우저에서 카메라의 H.264 프로필(${message.codec})을 디코딩할 수 없습니다.`,
            true,
          );
          return;
        }
        $("source-codec").textContent = "H.264";
        $("source-resolution").textContent =
          `${message.width} × ${message.height}`;
        $("source-fps").textContent = message.frameRate
          ? `${Number(message.frameRate.toFixed(2))} fps`
          : "소스 정보 없음";
        canvas.width = message.width;
        canvas.height = message.height;
        $("video-resolution").textContent =
          `${message.width} × ${message.height}`;
        $("source-caption").textContent = "RTSP LIVE STREAM";
        session.decoder = new VideoDecoder({
          output(frame) {
            try {
              if (active !== session) return;
              if (
                canvas.width !== frame.displayWidth ||
                canvas.height !== frame.displayHeight
              ) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                $("video-resolution").textContent =
                  `${canvas.width} × ${canvas.height}`;
                $("source-resolution").textContent =
                  `${canvas.width} × ${canvas.height}`;
              }
              context.drawImage(frame, 0, 0, canvas.width, canvas.height);
              const received = session.pending.get(frame.timestamp);
              if (received !== undefined) {
                session.latencySum += performance.now() - received;
                session.latencySamples++;
                session.pending.delete(frame.timestamp);
              }
              session.frames++;
              session.intervalFrames++;
              $("metric-frames").textContent =
                session.frames.toLocaleString("ko-KR");
              if (session.frames === 1) {
                clearTimeout(session.firstFrameTimer);
                $("empty-state").hidden = true;
                $("video-overlay").hidden = false;
                $("video-caption").hidden = false;
                $("stream-status").textContent = "스트리밍 중";
                $("stream-status").classList.add("live");
                $("preview-description").textContent =
                  "RTSP 영상을 WebCodecs로 재생하고 있습니다.";
                log(
                  `첫 프레임 디코딩 완료 · H.264 원본 · ${message.width} × ${message.height}`,
                );
              }
            } finally {
              // VideoFrame owns native buffers and must always be released.
              frame.close();
            }
          },
          error() {
            finish(
              session,
              "영상 디코딩에 실패했습니다. 다시 연결해 주세요.",
              true,
            );
          },
        });
        session.decoder.configure(session.config);
        socket.send(JSON.stringify({ type: "ready" }));
        return;
      }
      if (
        !(event.data instanceof ArrayBuffer) ||
        event.data.byteLength <= 9 ||
        !session.decoder
      )
        throw new Error("Invalid packet");
      const view = new DataView(event.data);
      const key = view.getUint8(0) === 1;
      const timestamp = Number(view.getBigInt64(1, false));
      session.bytes += event.data.byteLength - 9;
      if (session.decoder.decodeQueueSize > 5) {
        // Recover at the next keyframe rather than buffering stale live video.
        session.decoder.reset();
        session.decoder.configure(session.config);
        session.pending.clear();
        session.needsKeyframe = true;
        log("디코딩 대기열이 길어져 다음 키프레임에서 재개합니다.");
      }
      if (session.needsKeyframe && !key) return;
      session.needsKeyframe = false;
      session.pending.set(timestamp, performance.now());
      session.decoder.decode(
        new EncodedVideoChunk({
          type: key ? "key" : "delta",
          timestamp,
          data: new Uint8Array(event.data, 9),
        }),
      );
    } catch {
      finish(
        session,
        "영상 데이터를 처리하지 못했습니다. 다시 연결해 주세요.",
        true,
      );
    }
  };
  socket.onerror = () =>
    finish(
      session,
      "서버 연결에 실패했습니다. Python 서버가 실행 중인지 확인하세요.",
      true,
    );
  socket.onclose = () =>
    finish(session, "서버 연결이 종료되었습니다. 다시 연결해 주세요.", true);
  session.timer = setInterval(() => {
    if (active !== session) return;
    const now = performance.now();
    const seconds = (now - session.lastTick) / 1000;
    $("metric-fps").textContent = (session.intervalFrames / seconds).toFixed(1);
    $("metric-bitrate").textContent = (
      (session.bytes * 8) /
      seconds /
      1_000_000
    ).toFixed(2);
    $("metric-latency").textContent = session.latencySamples
      ? (session.latencySum / session.latencySamples).toFixed(1)
      : "—";
    const elapsed = Math.floor((now - session.started) / 1000);
    $("elapsed").textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    session.intervalFrames =
      session.bytes =
      session.latencySum =
      session.latencySamples =
        0;
    session.lastTick = now;
  }, 1000);
}

$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (active) finish(active);
  else start();
});
$("rtsp-url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (!active) start();
  }
});
$("clear-log").addEventListener("click", () => $("logs").replaceChildren());
window.addEventListener("pagehide", () => {
  if (active) finish(active);
});

async function initialize() {
  $("toggle-stream").disabled = true;
  try {
    if (!window.isSecureContext || typeof window.VideoDecoder !== "function")
      throw new Error();
    supported = true;
    $("toggle-stream").disabled = false;
    log("WebCodecs 준비 완료 · 연결 후 원본 H.264 프로필을 확인합니다.");
  } catch {
    notice(
      "이 브라우저에서 WebCodecs를 사용할 수 없습니다. 최신 Chrome 또는 Edge에서 localhost나 HTTPS로 접속하세요.",
    );
    log("WebCodecs를 사용할 수 없습니다.", true);
  }
  try {
    const response = await fetch("/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    $("server-status").textContent = "Python 서버 연결됨";
    $("server-dot").className = "dot online";
    log("Python 서버 상태 정상 · RTSP 주소를 입력하세요.");
  } catch {
    $("server-status").textContent = "서버 연결 안 됨";
    $("server-dot").className = "dot offline";
    log("Python 서버에 연결할 수 없습니다.", true);
  }
}
initialize();
