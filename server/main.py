"""Run with: python -m uvicorn server.main:app --host 127.0.0.1 --port 8000."""

import asyncio
import logging
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .video import RTSPStream, SourceEnded, UnsupportedCodec

STATIC = Path(__file__).resolve().parent.parent / "static"
logger = logging.getLogger(__name__)
app = FastAPI(title="WebCodecs Lab", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
slots = asyncio.Semaphore(4)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    return {"status": "ok", "codec": "h264", "transport": "websocket"}


@app.get("/api/config")
async def config():
    return {
        "codec": "h264", "mode": "passthrough", "format": "annexb",
        "transport": "websocket", "maxStreams": 4,
    }


@app.websocket("/ws/stream")
async def stream(websocket: WebSocket):
    await websocket.accept()
    try:
        start = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(start, dict) or start.get("type") != "start":
            raise ValueError
        url = start.get("rtspUrl", "")
        if not isinstance(url, str) or not url or len(url) > 2048 or any(c.isspace() for c in url):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme not in ("rtsp", "rtsps") or not parsed.hostname:
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
    except (ValueError, TypeError, KeyError, TimeoutError):
        await websocket.send_json({"type": "error", "message": "스트림 설정 또는 RTSP 주소를 확인하세요."})
        await websocket.close(code=1008)
        return
    except WebSocketDisconnect:
        return
    try:
        await asyncio.wait_for(slots.acquire(), timeout=0.1)
    except TimeoutError:
        await websocket.send_json({"type": "error", "message": "서버가 사용 중입니다. 잠시 후 다시 시도하세요."})
        await websocket.close(code=1013)
        return

    video = None
    pending = None
    try:
        # Shield worker jobs so disconnect/shutdown cannot release a context in use.
        pending = asyncio.create_task(asyncio.to_thread(RTSPStream, url))
        video = await asyncio.shield(pending)
        pending = None
        await websocket.send_json({
            "type": "config", "codec": video.codec, "width": video.width,
            "height": video.height, "frameRate": video.fps,
            "mode": "passthrough", "format": "annexb",
            "headerBytes": 9,
        })
        ready = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(ready, dict) or ready.get("type") != "ready":
            raise SourceEnded("Decoder was not ready")
        while True:
            pending = asyncio.create_task(asyncio.to_thread(video.next_packets))
            packets = await asyncio.shield(pending)
            pending = None
            for packet in packets:
                await websocket.send_bytes(packet)
    except WebSocketDisconnect:
        pass
    except UnsupportedCodec:
        try:
            await websocket.send_json({"type": "error", "message": "원본 NAL 전송은 H.264 RTSP를 지원합니다. 카메라의 영상 코덱을 H.264로 설정하세요."})
            await websocket.close(code=1003)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
    except (OSError, SourceEnded):
        try:
            await websocket.send_json({"type": "error", "message": "영상 소스에 연결할 수 없거나 연결이 종료되었습니다. RTSP 주소와 서버의 접근 권한을 확인하세요."})
            await websocket.close(code=1011)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
    except Exception:
        # Avoid logging RTSP URLs, which may contain camera credentials.
        logger.error("Video stream failed")
        try:
            await websocket.send_json({"type": "error", "message": "영상 스트림을 생성하지 못했습니다."})
            await websocket.close(code=1011)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
    finally:
        if pending is not None and not pending.done():
            try:
                result = await pending
                if video is None:
                    video = result
            except Exception:
                logger.error("RTSP worker failed during cleanup")
        elif pending is not None and video is None and not pending.cancelled() and pending.exception() is None:
            video = pending.result()
        if video is not None:
            video.close()
        slots.release()
