"""Forward live detection coordinates from the OMEYE broker."""
import asyncio
from contextlib import suppress
import json
import math
import os
from pathlib import Path
import struct
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis
from redis.exceptions import RedisError

from backend.cameras import selective_stream_id
from backend.selective import DEFAULT_MASTER
from backend.shm_frames import shm_frame_signature

router = APIRouter()
MAX_METADATA = 1024 * 1024
MAX_PAYLOAD = 8 * 1024 * 1024
bbox_sources = {}

# A short lease expires even when the server exits unexpectedly. Refresh only
# keys owned by WebCodecs, and never change an existing external value.
ENABLE_LIVE = """
if redis.call('GET', KEYS[2]) == 'webcodecs' and redis.call('GET', KEYS[1]) == 'true' then
    redis.call('EXPIRE', KEYS[1], 6)
    redis.call('EXPIRE', KEYS[2], 6)
    return 1
end
if redis.call('SET', KEYS[1], 'true', 'NX', 'EX', 6) then
    redis.call('SET', KEYS[2], 'webcodecs', 'EX', 6)
    return 1
end
if redis.call('GET', KEYS[1]) == 'true' then return 1 end
return 0
"""


def read_config():
    path = Path(os.getenv('SELECTIVE_MASTER_CONFIG', DEFAULT_MASTER))
    return json.loads(path.read_text(encoding='utf-8'))


def boxes_for(detections):
    if isinstance(detections, dict):
        entries = ((label, box) for label, boxes in detections.items()
                   if isinstance(boxes, list) for box in boxes)
    elif isinstance(detections, list):
        entries = ((item.get('class_id'), item.get('bbox')) for item in detections if isinstance(item, dict))
    else:
        return []
    return [
        {'label': label[:80], 'rect': box[:4]}
        for label, box in entries
        if isinstance(label, str) and isinstance(box, list) and len(box) >= 4
        and all(type(value) in (int, float) and abs(value) < 1e7 and math.isfinite(value) for value in box[:4])
        and box[2] > box[0] and box[3] > box[1]
    ][:200]


async def receive_frames(reader, send_bbox, stream_id, width, height, *, synchronize=False):
    while True:
        size, = struct.unpack('!I', await reader.readexactly(4))
        if not 0 < size <= MAX_METADATA:
            raise ValueError('Invalid broker metadata size')
        meta = json.loads(await reader.readexactly(size))
        size, = struct.unpack('!I', await reader.readexactly(4))
        if size > MAX_PAYLOAD:
            raise ValueError('Invalid broker payload size')
        while size:
            size -= len(await reader.readexactly(min(size, 65536)))
        if isinstance(meta, dict) and meta.get('stream_id') == stream_id:
            message = {
                'type': 'bbox', 'width': width, 'height': height,
                'boxes': boxes_for(meta.get('detection_result')),
            }
            should_synchronize = synchronize() if callable(synchronize) else synchronize
            if should_synchronize:
                signature = await asyncio.to_thread(shm_frame_signature, meta)
                if signature is not None:
                    message['frameSignature'] = signature
                    message['frameId'] = meta['frame_id']
            await send_bbox(message)


async def refresh_lease(redis, stream_id):
    while True:
        if not await redis.eval(ENABLE_LIVE, 2, stream_id, f'webcodecs:bbox-lease:{stream_id}'):
            raise ValueError('라이브 탐지 상태를 켤 수 없습니다.')
        await asyncio.sleep(2)


async def _run_bbox_source(stream_id, send_bbox, *, synchronize=False):
    socket_path = os.getenv('SELECTIVE_BBOX_SOCKET')
    if not socket_path:
        raise ValueError('bbox 브로커 주소가 설정되지 않았습니다.')
    open_connection = getattr(asyncio, 'open_unix_connection', None)
    if open_connection is None:
        raise ValueError('현재 환경에서 bbox 브로커 소켓을 사용할 수 없습니다.')
    writer = None
    try:
        config = await asyncio.to_thread(read_config)
        if not isinstance(config, dict):
            raise ValueError('선별관제 설정이 올바르지 않습니다.')
        width, height = config.get('width', 1280), config.get('height', 768)
        if any(type(value) is not int or value <= 0 for value in (width, height)):
            raise ValueError('탐지 영상 크기가 올바르지 않습니다.')
        reader, writer = await asyncio.wait_for(open_connection(socket_path), 3)
        subscription = json.dumps({'v': 1, 'action': 'subscribe', 'streams': [stream_id]}).encode()
        writer.write(struct.pack('!I', len(subscription)) + subscription)
        await asyncio.wait_for(writer.drain(), 3)
        ack = json.loads(await asyncio.wait_for(reader.readline(), 3))
        if not isinstance(ack, dict) or ack.get('ok') is not True:
            raise ValueError('브로커 구독이 거절됐습니다.')
        async with Redis(
            host=config.get('redisHost', 'localhost'), port=config.get('redisPort', 6379),
            db=config.get('redisDb', config.get('redisDB', 0)), password=config.get('redisPassword'),
            socket_connect_timeout=3, socket_timeout=3,
        ) as redis:
            tasks = [
                asyncio.create_task(refresh_lease(redis, stream_id)),
                asyncio.create_task(receive_frames(reader, send_bbox, stream_id, width, height, synchronize=synchronize)),
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        if writer is not None:
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()


class BBoxSubscriber:
    def __init__(self, synchronize):
        self.synchronize = synchronize
        self.messages = asyncio.Queue(maxsize=1)


class BBoxFailure:
    def __init__(self, error):
        self.error = error


class SharedBBoxSource:
    def __init__(self, stream_id):
        self.stream_id = stream_id
        self.subscribers = set()
        self.stopping = asyncio.Event()
        self.updates = 0
        self.signature_matches = 0
        self.coalesced = 0
        self.task = asyncio.create_task(self.run())

    def needs_signature(self):
        return any(subscriber.synchronize for subscriber in self.subscribers)

    async def publish(self, message):
        if isinstance(message, dict):
            self.updates += 1
            self.signature_matches += int('frameSignature' in message)
        for subscriber in self.subscribers:
            if subscriber.messages.full():
                subscriber.messages.get_nowait()
                self.coalesced += 1
            subscriber.messages.put_nowait(message)

    def remove(self, subscriber):
        self.subscribers.discard(subscriber)
        if not self.subscribers:
            self.stopping.set()

    async def run(self):
        error = OSError('BBox source stopped')
        producer = asyncio.create_task(_run_bbox_source(
            self.stream_id, self.publish, synchronize=self.needs_signature,
        ))
        stop = asyncio.create_task(self.stopping.wait())
        tasks = [producer, stop]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if producer in done and not producer.cancelled():
                producer.result()
        except Exception as failure:
            error = failure if isinstance(failure, (OSError, ValueError, RedisError)) else OSError('BBox source failed')
        finally:
            self.stopping.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.publish(BBoxFailure(error))
            if bbox_sources.get(self.stream_id) is self:
                del bbox_sources[self.stream_id]


async def _subscribe_bbox(camera_id, send_bbox, *, synchronize=False):
    stream_id = await asyncio.to_thread(selective_stream_id, camera_id)
    if not stream_id:
        raise ValueError('선별관제 카메라에서 bbox를 켤 수 있습니다.')
    while True:
        source = bbox_sources.get(stream_id)
        if source is None:
            source = bbox_sources[stream_id] = SharedBBoxSource(stream_id)
        if not source.stopping.is_set():
            break
        await asyncio.shield(source.task)

    subscriber = BBoxSubscriber(synchronize)
    source.subscribers.add(subscriber)
    try:
        while True:
            message = await subscriber.messages.get()
            if isinstance(message, BBoxFailure):
                raise message.error
            if not synchronize:
                message = {key: value for key, value in message.items()
                           if key not in ('frameSignature', 'frameId')}
            await send_bbox(message)
    finally:
        source.remove(subscriber)
        if source.stopping.is_set():
            await asyncio.shield(source.task)


def bbox_source_stats():
    sources = tuple(bbox_sources.values())
    return {
        'sources': len(sources),
        'subscribers': sum(len(source.subscribers) for source in sources),
        'updates': sum(source.updates for source in sources),
        'matchedFrames': sum(source.signature_matches for source in sources),
        'coalescedUpdates': sum(source.coalesced for source in sources),
    }


async def subscribe_bbox(camera_id, on_bbox, *, synchronize=False):
    """Receive BBox updates without waiting for the caller's outbound transport."""
    async def send_bbox(message):
        on_bbox(message)

    await _subscribe_bbox(camera_id, send_bbox, synchronize=synchronize)


async def wait_for_disconnect(ws):
    while (await ws.receive())['type'] != 'websocket.disconnect':
        pass


@router.websocket('/ws/bbox/{camera_id}')
async def bbox_socket(ws: WebSocket, camera_id: int):
    origin = ws.headers.get('origin')
    if not os.getenv('SELECTIVE_BBOX_SOCKET') or not 0 < camera_id < 2**63 or (origin and urlsplit(origin).netloc != ws.headers.get('host')):
        await ws.close(code=1008)
        return
    await ws.accept()

    async def send_bbox(message):
        await asyncio.wait_for(ws.send_json(message), 3)

    tasks = [
        asyncio.create_task(_subscribe_bbox(camera_id, send_bbox)),
        asyncio.create_task(wait_for_disconnect(ws)),
    ]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (OSError, ValueError, RedisError, asyncio.IncompleteReadError, WebSocketDisconnect):
        with suppress(Exception):
            await ws.send_json({'type': 'error', 'message': 'bbox를 받지 못했습니다. 선별관제 상태를 확인하세요.'})
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with suppress(Exception):
            await ws.close()
