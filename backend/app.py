"""RTSP -> PyAV demux -> original H.264 Annex B -> WebSocket."""
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import struct
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
app = FastAPI()
MAX_FRAME_BYTES = 8 * 1024 * 1024


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


async def pump(process, ws):
    while True:
        message = await read_frame(process.stdout)
        if message[0] == 0:
            config = json.loads(message[1:])
            await asyncio.wait_for(ws.send_json(config), 5)
            if config.get('type') == 'error':
                return
        elif message[0] == 1:
            # Preserve original NAL bytes and source PTS. No codec transformation.
            await asyncio.wait_for(ws.send_bytes(message[1:]), 5)
        else:
            raise ValueError('잘못된 메시지 종류')


async def discard_output(reader):
    while await reader.read(65536):
        pass


async def receive_until_disconnect(ws):
    while True:
        message = await ws.receive()
        if message['type'] == 'websocket.disconnect':
            return


@app.get('/api/health')
async def health():
    return {'status': 'ok', 'ffmpeg': shutil.which('ffmpeg') is not None}


@app.websocket('/ws/stream')
async def stream(ws: WebSocket):
    origin = ws.headers.get('origin')
    if origin and urlsplit(origin).netloc != ws.headers.get('host'):
        await ws.close(code=1008)
        return
    await ws.accept()
    process = None
    tasks = []
    try:
        message = await asyncio.wait_for(ws.receive_text(), 10)
        if len(message) > 4096:
            raise ValueError('요청이 너무 큽니다.')
        request = json.loads(message)
        if not isinstance(request, dict):
            raise ValueError('잘못된 요청입니다.')
        url = request.get('url') or os.getenv('RTSP_URL', '')
        if not isinstance(url, str):
            raise ValueError('RTSP 주소는 문자열이어야 합니다.')
        relay_request = worker_request(url, demo=request.get('demo') is True)
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-m', 'backend.relay_worker',
            cwd=ROOT, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            start_new_session=True,
            # Camera credentials can appear in FFmpeg errors. Do not forward/log stderr.
            stderr=asyncio.subprocess.DEVNULL,
        )
        process.stdin.write((json.dumps(relay_request) + '\n').encode())
        await process.stdin.drain()
        process.stdin.close()
        tasks = [asyncio.create_task(pump(process, ws)), asyncio.create_task(receive_until_disconnect(ws))]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, RuntimeError):
        pass
    except ValueError as error:
        with suppress(Exception):
            await ws.send_json({'type': 'error', 'message': str(error)})
    except (asyncio.IncompleteReadError, TimeoutError, FileNotFoundError):
        with suppress(Exception):
            await ws.send_json({'type': 'error', 'message': '영상을 받을 수 없습니다. RTSP 주소, 인증, H.264 설정 및 네트워크 연결을 확인하세요.'})
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if process:
            # A stopped consumer can leave the subprocess pipe paused at its limit.
            # Drain it while reaping so process.wait() cannot deadlock on buffered output.
            drain = asyncio.create_task(discard_output(process.stdout))
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 3)
                except TimeoutError:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            else:
                await process.wait()
            await drain
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
