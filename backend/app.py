"""RTSP -> PyAV demux -> original H.264 Annex B -> WebSocket."""
import asyncio
from collections import deque
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
from time import monotonic
import shutil
import signal
import sqlite3
import sys
import struct
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from redis.exceptions import RedisError

from backend.cameras import camera_url, router as cameras_router
from backend.bbox import router as bbox_router, subscribe_bbox, bbox_source_stats
from backend.frame_sync import FrameMatcher
from backend.selective import start_monitor
from backend.shm_frames import vcl_fingerprint

ROOT = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app):
    monitor = start_monitor()
    try:
        yield
    finally:
        if monitor is not None:
            monitor.cancel()
            with suppress(asyncio.CancelledError):
                await monitor


app = FastAPI(lifespan=lifespan)
app.include_router(cameras_router)
app.include_router(bbox_router)
MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_PENDING_MESSAGES = 16
MAX_QUEUE_SECONDS = .15
MAX_PENDING_BYTES = 8 * 1024 * 1024
VIDEO_BURST = 4
STREAM_ERROR = '영상을 받을 수 없습니다. RTSP 주소, 인증, H.264 설정 및 네트워크 연결을 확인하세요.'
relays = {}


def worker_request(url: str, demo: bool = False):
    if not demo:
        parsed = urlsplit(url)
        if parsed.scheme not in ('rtsp', 'rtsps') or not parsed.hostname:
            raise ValueError('유효한 rtsp:// 또는 rtsps:// 주소를 입력하세요.')
    return {'url': url, 'demo': demo}


async def read_frame(reader):
    header = await asyncio.wait_for(reader.readexactly(4), 20)
    size = struct.unpack('>I', header)[0]
    if not 1 < size <= MAX_FRAME_BYTES:
        raise ValueError('잘못된 메시지 크기')
    return await asyncio.wait_for(reader.readexactly(size), 15)


class StreamQueue(asyncio.Queue):
    def __init__(self):
        super().__init__()
        self.timestamps = deque()
        self.pending_bytes = 0

    @property
    def age_seconds(self):
        return monotonic() - self.timestamps[0] if self.timestamps else 0

    @property
    def has_control(self):
        return any(isinstance(message, dict) for message in self._queue)

    def _put(self, message):
        super()._put(message)
        self.timestamps.append(monotonic())
        if isinstance(message, bytes):
            self.pending_bytes += len(message)

    def _get(self):
        message = super()._get()
        self.timestamps.popleft()
        if isinstance(message, bytes):
            self.pending_bytes -= len(message)
        return message


class Viewer:
    def __init__(self):
        self.messages = StreamQueue()
        self.needs_key = True
        self.config = None
        self.bbox_messages = deque(maxlen=MAX_PENDING_MESSAGES)
        self.matcher = None
        self.ready = asyncio.Event()
        self.metrics = {'videoSent': 0, 'bboxSent': 0, 'resyncs': 0, 'framesDropped': 0,
                        'queueWaitMs': 0, 'maxQueueWaitMs': 0}

    def enqueue(self, message):
        self.messages.put_nowait(message)
        self.ready.set()

    def reset_bbox(self, keep_error=False):
        error = next((item for item in self.bbox_messages if item['type'] == 'bbox_error'), None) if keep_error else None
        self.bbox_messages.clear()
        if error is not None:
            self.bbox_messages.append(error)
        if self.matcher is not None:
            self.matcher.clear()

    def enqueue_bbox(self, message):
        self.bbox_messages.append(message)
        self.ready.set()

    def resync(self):
        error = None
        while not self.messages.empty():
            message = self.messages.get_nowait()
            if isinstance(message, bytes):
                self.metrics['framesDropped'] += 1
            elif message.get('type') == 'error':
                error = message
        self.reset_bbox(keep_error=True)
        self.needs_key = True
        self.metrics['resyncs'] += 1
        if error is not None:
            self.enqueue(error)
        elif self.config is not None:
            self.enqueue(self.config)

    async def send_to(self, ws):
        video_burst = 0
        while True:
            if self.messages.age_seconds > MAX_QUEUE_SECONDS:
                self.resync()
            if (self.bbox_messages and not self.messages.has_control
                    and (video_burst >= VIDEO_BURST or self.messages.empty())):
                message = self.bbox_messages.popleft()
                video_burst = 0
            elif not self.messages.empty():
                queue_wait_ms = self.messages.age_seconds * 1000
                self.metrics['queueWaitMs'] = round(queue_wait_ms, 2)
                self.metrics['maxQueueWaitMs'] = max(self.metrics['maxQueueWaitMs'], round(queue_wait_ms, 2))
                message = self.messages.get_nowait()
                video_burst += 1
            else:
                self.ready.clear()
                await self.ready.wait()
                continue
            if isinstance(message, bytes):
                await asyncio.wait_for(ws.send_bytes(message), 5)
                self.metrics['videoSent'] += 1
            else:
                await asyncio.wait_for(ws.send_json(message), 5)
                if message['type'] == 'bbox':
                    self.metrics['bboxSent'] += 1
                if message['type'] == 'error':
                    return


class SharedRelay:
    def __init__(self, key, request):
        self.key = key
        self.request = request
        self.viewers = set()
        self.config = None
        self.stopping = asyncio.Event()
        self.task = asyncio.create_task(self.run())

    def add_viewer(self):
        viewer = Viewer()
        self.viewers.add(viewer)
        if self.config is not None:
            viewer.config = self.config
            viewer.enqueue(self.config)
        return viewer

    def remove_viewer(self, viewer):
        self.viewers.discard(viewer)
        if not self.viewers:
            self.stopping.set()

    def publish(self, message, signature=None):
        video = isinstance(message, bytes)
        viewers = tuple(self.viewers)
        if signature is None and video and len(message) > 9 and any(viewer.matcher is not None for viewer in viewers):
            signature = vcl_fingerprint(message[9:])
        for viewer in viewers:
            if (viewer.messages.qsize() >= MAX_PENDING_MESSAGES
                    or viewer.messages.age_seconds > MAX_QUEUE_SECONDS
                    or video and viewer.messages.pending_bytes + len(message) > MAX_PENDING_BYTES):
                # Discard stale frames and reset this viewer's decoder before resuming.
                viewer.resync()
            if video:
                if viewer.needs_key and message[0] != 1:
                    viewer.metrics['framesDropped'] += 1
                    continue
                viewer.needs_key = False
            else:
                viewer.needs_key = True
                viewer.reset_bbox(keep_error=True)
                if message.get('type') == 'config':
                    viewer.config = message
            viewer.enqueue(message)
            if signature is not None and viewer.matcher is not None:
                matched = viewer.matcher.add_frame(signature, struct.unpack_from('>q', message, 1)[0])
                if matched is not None:
                    viewer.enqueue_bbox(matched)

    async def pump(self, reader):
        while True:
            message = await read_frame(reader)
            if message[0] == 0:
                config = json.loads(message[1:])
                if config.get('type') == 'error':
                    return config
                self.config = config
                self.publish(config)
            elif message[0] == 1:
                # All viewers receive the same original NAL bytes and PTS.
                self.publish(message[1:])
            elif message[0] == 2 and len(message) > 42:
                self.publish(message[33:], signature=message[1:33])
            else:
                raise ValueError('잘못된 메시지 종류')

    async def run(self):
        process = None
        tasks = []
        try:
            if self.stopping.is_set():
                return
            process = await asyncio.create_subprocess_exec(
                sys.executable, '-m', 'backend.relay_worker',
                cwd=ROOT, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                start_new_session=True,
                # The worker's stderr can contain camera credentials.
                stderr=asyncio.subprocess.DEVNULL,
            )
            process.stdin.write((json.dumps({**self.request, 'fingerprints': True}) + '\n').encode())
            await process.stdin.drain()
            if os.name != 'nt' or not self.request['demo']:
                process.stdin.close()
            pump = asyncio.create_task(self.pump(process.stdout))
            stop = asyncio.create_task(self.stopping.wait())
            tasks = [pump, stop]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if pump in done:
                self.publish(pump.result())
        except (OSError, asyncio.IncompleteReadError, TimeoutError, ValueError):
            self.publish({'type': 'error', 'message': STREAM_ERROR})
        finally:
            self.stopping.set()
            try:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if process is not None:
                    await stop_worker(process, graceful_pipe=os.name == 'nt' and self.request['demo'])
            finally:
                del relays[self.key]


async def subscribe(request):
    key = None if request['demo'] else request['url']
    while True:
        relay = relays.get(key)
        if relay is None:
            relay = relays[key] = SharedRelay(key, request)
        if not relay.stopping.is_set():
            return relay, relay.add_viewer()
        # A new connection must wait for the old worker to release this source.
        await asyncio.shield(relay.task)


async def discard_output(reader):
    while await reader.read(65536):
        pass


async def stop_worker(process, graceful_pipe=False):
    # Drain a possibly paused stdout pipe while reaping the worker.
    drain = asyncio.create_task(discard_output(process.stdout))
    try:
        if graceful_pipe:
            process.stdin.close()
        elif process.returncode is None:
            with suppress(ProcessLookupError):
                if os.name == 'nt':
                    process.terminate()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), 3)
        except TimeoutError:
            with suppress(ProcessLookupError):
                if os.name == 'nt':
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
        await drain
    finally:
        drain.cancel()
        await asyncio.gather(drain, return_exceptions=True)


async def forward_bbox(viewer, camera_id, revision):
    def publish(message):
        signature = message.get('frameSignature')
        if signature is None:
            return
        public = {key: value for key, value in message.items() if key != 'frameSignature'}
        matched = viewer.matcher.add_bbox(signature, {**public, 'bboxRevision': revision})
        if matched is not None:
            viewer.enqueue_bbox(matched)

    try:
        if camera_id is None:
            raise ValueError('등록 카메라가 필요합니다.')
        await subscribe_bbox(camera_id, publish, synchronize=True)
    except (OSError, ValueError, TypeError, RedisError, asyncio.IncompleteReadError, sqlite3.Error):
        pass
    viewer.reset_bbox()
    viewer.matcher = None
    viewer.enqueue_bbox({'type': 'bbox_error', 'bboxRevision': revision,
                         'message': 'bbox를 받지 못했습니다. 선별관제 상태를 확인하세요.'})


async def receive_controls(ws, viewer, camera_id, request):
    task = None
    enabled = request.get('bbox') is True
    revision = request.get('bboxRevision', 0)
    try:
        if enabled and type(revision) is int and revision >= 0:
            viewer.matcher = FrameMatcher()
            task = asyncio.create_task(forward_bbox(viewer, camera_id, revision))
        while True:
            message = await ws.receive()
            if message['type'] == 'websocket.disconnect':
                return
            payload = message.get('text')
            if not payload or len(payload) > 4096:
                continue
            try:
                control = json.loads(payload)
            except ValueError:
                continue
            if not isinstance(control, dict) or control.get('type') != 'bbox':
                continue
            enabled = control.get('enabled')
            revision = control.get('bboxRevision', 0)
            if type(enabled) is not bool or type(revision) is not int or revision < 0:
                continue
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            viewer.reset_bbox()
            viewer.matcher = FrameMatcher() if enabled else None
            task = asyncio.create_task(forward_bbox(viewer, camera_id, revision)) if enabled else None
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@app.get('/api/health')
async def health():
    return {'status': 'ok', 'ffmpeg': shutil.which('ffmpeg') is not None}


@app.get('/api/metrics')
async def metrics():
    viewers = [viewer for relay in relays.values() for viewer in relay.viewers]
    return {
        'activeSources': len(relays),
        'activeViewers': len(viewers),
        'bbox': bbox_source_stats(),
        'viewers': [{**viewer.metrics,
                     'queueFrames': viewer.messages.qsize(),
                     'queueBytes': viewer.messages.pending_bytes,
                     'oldestQueueMs': round(viewer.messages.age_seconds * 1000, 2),
                     'pendingBbox': len(viewer.bbox_messages)}
                    for viewer in viewers],
    }


@app.websocket('/ws/stream')
async def stream(ws: WebSocket):
    origin = ws.headers.get('origin')
    if origin and urlsplit(origin).netloc != ws.headers.get('host'):
        await ws.close(code=1008)
        return
    await ws.accept()
    relay = viewer = None
    tasks = []
    try:
        message = await asyncio.wait_for(ws.receive_text(), 10)
        if len(message) > 4096:
            raise ValueError('요청이 너무 큽니다.')
        request = json.loads(message)
        if not isinstance(request, dict):
            raise ValueError('잘못된 요청입니다.')
        url = request.get('url') or os.getenv('RTSP_URL', '')
        camera_id = None
        if 'cameraId' in request:
            camera_id = request['cameraId']
            if type(camera_id) is not int or not 0 < camera_id < 2**63:
                raise ValueError('잘못된 카메라 번호입니다.')
            url = await asyncio.to_thread(camera_url, camera_id)
        if not isinstance(url, str):
            raise ValueError('RTSP 주소는 문자열이어야 합니다.')
        relay_request = worker_request(url.strip(), demo=request.get('demo') is True)
        relay, viewer = await subscribe(relay_request)
        tasks = [
            asyncio.create_task(viewer.send_to(ws)),
            asyncio.create_task(receive_controls(ws, viewer, None if relay_request['demo'] else camera_id, request)),
        ]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except ValueError as error:
        with suppress(Exception):
            await ws.send_json({'type': 'error', 'message': str(error)})
    except TimeoutError:
        with suppress(Exception):
            await ws.send_json({'type': 'error', 'message': STREAM_ERROR})
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if relay is not None:
            relay.remove_viewer(viewer)
            if relay.stopping.is_set():
                await asyncio.shield(relay.task)
        with suppress(Exception):
            await ws.close()


@app.middleware('http')
async def headers(request, call_next):
    response = await call_next(request)
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    response.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


if (ROOT / 'dist').is_dir():
    app.mount('/', StaticFiles(directory=ROOT / 'dist', html=True), name='react')
else:
    @app.get('/')
    async def build_required():
        return JSONResponse({'message': '먼저 npm ci && npm run build 를 실행하세요.'}, status_code=503)
