import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const canvas = useRef(null);
  const session = useRef(null);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('대기 중');
  const [active, setActive] = useState(false);
  const [stats, setStats] = useState({ frames: 0, bytes: 0 });
  const [supported, setSupported] = useState(false);

  function stop(update = true) {
    const current = session.current;
    session.current = null;
    if (current) {
      current.ws.close();
      if (current.decoder?.state !== 'closed') current.decoder?.close();
      clearInterval(current.interval);
    }
    if (update) { setActive(false); setStatus('연결 종료'); }
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!isSecureContext || !('VideoDecoder' in window)) throw new Error('WebCodecs를 지원하는 Chrome/Edge에서 HTTPS 또는 localhost로 접속하세요.');
        const result = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' });
        if (!result.supported) throw new Error('H.264 디코딩을 지원하지 않는 브라우저입니다.');
        if (!cancelled) { setSupported(true); setStatus('연결 준비 완료'); }
      } catch (error) { if (!cancelled) setStatus(error.message); }
    })();
    return () => { cancelled = true; stop(false); };
  }, []);

  function connect(demo) {
    stop(false);
    setStats({ frames: 0, bytes: 0 });
    setStatus('연결 중…');
    setActive(true);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream`);
    ws.binaryType = 'arraybuffer';
    const current = { ws, decoder: null, frames: 0, bytes: 0, needsKey: true, config: null, failed: false };
    session.current = current;
    const valid = () => session.current === current;
    function fail(message) {
      if (!valid()) return;
      stop(false);
      setActive(false);
      setStatus(message);
    }
    current.interval = setInterval(() => {
      if (valid()) setStats({ frames: current.frames, bytes: current.bytes });
    }, 500);
    ws.onopen = () => {
      if (valid()) ws.send(JSON.stringify({ url: demo ? '' : url.trim(), demo }));
    };
    ws.onerror = () => fail('WebSocket 연결에 실패했습니다. 서버 상태를 확인하세요.');
    ws.onclose = () => { if (valid()) fail('서버 연결이 종료되었습니다. 다시 연결할 수 있습니다.'); };
    ws.onmessage = ({ data }) => {
      if (!valid()) return;
      try {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (message.type === 'error') { fail(message.message); return; }
          if (message.type === 'config') {
            current.config = { codec: message.codec };
            current.decoder = new VideoDecoder({
              output(frame) {
                try {
                  if (valid()) {
                    const target = canvas.current;
                    if (target.width !== frame.displayWidth || target.height !== frame.displayHeight) {
                      target.width = frame.displayWidth; target.height = frame.displayHeight;
                    }
                    target.getContext('2d').drawImage(frame, 0, 0);
                    current.frames++;
                    if (current.frames === 1) setStatus('실시간 재생 중');
                  }
                } finally { frame.close(); }
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
        if (current.decoder.decodeQueueSize > 10) {
          current.decoder.reset();
          current.decoder.configure(current.config);
          current.needsKey = true;
        }
        if (current.needsKey && !key) return;
        current.needsKey = false;
        current.bytes += data.byteLength;
        current.decoder.decode(new EncodedVideoChunk({
          type: key ? 'key' : 'delta', timestamp: Number(header.getBigInt64(1)), data: new Uint8Array(data, 9),
        }));
      } catch (error) { fail(error.message); }
    };
  }

  return <main>
    <header><span className="eyebrow">RTSP → WEBSOCKET → WEBCODECS</span><h1>RTSP Live</h1><p>카메라 스트림을 브라우저에서 바로 확인하세요.</p></header>
    <form onSubmit={event => { event.preventDefault(); connect(false); }}>
      <label htmlFor="rtsp">RTSP 주소</label>
      <div className="input-row"><input id="rtsp" type="password" autoComplete="off" spellCheck="false" value={url} onChange={event => setUrl(event.target.value)} placeholder="rtsp://user:password@camera:554/stream" disabled={active}/><button disabled={!supported || active}>연결</button></div>
      <p className="hint">주소를 비워두면 서버의 RTSP_URL 설정을 사용합니다. 입력한 주소는 저장하지 않습니다.</p>
      <div className="actions"><button type="button" className="secondary" disabled={!supported || active} onClick={() => connect(true)}>테스트 영상</button><button type="button" className="secondary" disabled={!active} onClick={() => stop()}>연결 종료</button></div>
    </form>
    <section className="player"><canvas ref={canvas} width="960" height="540" aria-label="실시간 카메라 영상"/></section>
    <footer><p role="status"><span className={active ? 'dot active' : 'dot'}/> {status}</p><p>{stats.frames.toLocaleString()} 프레임 <span className="divider">/</span> {(stats.bytes / 1024 / 1024).toFixed(2)} MB</p></footer>
    <p className="hint">Python · React / H.264 원본 NAL 전송 · 재인코딩 없음 / 영상 전용</p>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
