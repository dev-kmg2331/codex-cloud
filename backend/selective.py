"""Synchronize the configured analysis server's camera list into SQLite."""
import asyncio
import http.client
import json
import logging
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from backend.cameras import CameraRegistration, sync_selective_cameras, validated_camera

logger = logging.getLogger(__name__)
WS_PATH = '/api/v2/selective/websocket'
STATUS_PATH = '/api/v2/selective/status'
DEFAULT_MASTER = '/usr/local/oms/omeye/omeye2/sc/tmp/config/master.json'


def read_cameras(master):
    snapshots = {}

    def read_json(path):
        before = path.stat()
        snapshots[path] = (before.st_ino, before.st_size, before.st_mtime_ns)
        return json.loads(path.read_text(encoding='utf-8'))

    root = master.parent.resolve()
    config = read_json(master)
    paths = config.get('configChildPaths') if isinstance(config, dict) else None
    if not isinstance(paths, list) or not paths:
        raise ValueError('Missing child configurations')
    cameras = {}
    for path in paths:
        if not isinstance(path, str) or not path:
            raise ValueError('Invalid child configuration path')
        child = (root / path).resolve()
        if not child.is_relative_to(root):
            raise ValueError('Child configuration is outside the config directory')
        rows = read_json(child)
        if not isinstance(rows, list):
            raise ValueError('Invalid child configuration')
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Invalid stream configuration')
            stream_id, camera_id = row.get('streamId'), row.get('id')
            if not isinstance(stream_id, str) or not stream_id or stream_id in cameras:
                raise ValueError('Missing or duplicate stream ID')
            if type(camera_id) not in (str, int) or not str(camera_id):
                raise ValueError('Missing camera ID')
            name, url = validated_camera(CameraRegistration(
                name=row.get('name') or stream_id, rtsp_url=row.get('url')
            ))
            cameras[stream_id] = (str(camera_id), name, url)
    if not cameras:
        raise ValueError('No configured streams')
    for path, previous in snapshots.items():
        current = path.stat()
        if previous != (current.st_ino, current.st_size, current.st_mtime_ns):
            raise ValueError('Configuration changed during read')
    return cameras


def status_for_server(rows, server_ip):
    if not isinstance(rows, list):
        return None
    for row in rows:
        if isinstance(row, dict) and row.get('serverIp') == server_ip:
            status = row.get('status')
            return status.get('status') if isinstance(status, dict) else None
    return None


def fetch_status(origin, token):
    connection_type = http.client.HTTPSConnection if origin.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(origin.hostname, origin.port, timeout=5)
    try:
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        connection.request('GET', STATUS_PATH, headers=headers)
        response = connection.getresponse()
        if response.status != 200:
            return None
        payload = json.loads(response.read(1024 * 1024))
        return payload.get('rows') if isinstance(payload, dict) and payload.get('success') is True else None
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


async def monitor(origin_url, server_ip, master, token_file):
    origin = urlsplit(origin_url)
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.path not in ('', '/'):
        logger.error('SELECTIVE_BASE_URL must be an HTTP(S) origin.')
        return
    ws_scheme = 'wss' if origin.scheme == 'https' else 'ws'
    ws_url = f'{ws_scheme}://{origin.netloc}{WS_PATH}'
    applied = None

    async def apply_status(rows):
        nonlocal applied
        state = status_for_server(rows, server_ip)
        if state == 'running':
            try:
                snapshot = await asyncio.to_thread(read_cameras, master)
            except (OSError, ValueError):
                return False
        elif state == 'ready':
            snapshot = {}
        else:
            return True
        if applied != snapshot:
            await asyncio.to_thread(sync_selective_cameras, snapshot)
            applied = snapshot
        return True

    while True:
        try:
            if token_file is None:
                rows = await asyncio.to_thread(fetch_status, origin, None)
                await asyncio.sleep(3 if await apply_status(rows) else 2)
                continue
            token = (await asyncio.to_thread(token_file.read_text, encoding='utf-8')).strip()
            if not token or any(char.isspace() for char in token):
                raise ValueError('Missing or invalid access token')
            async with connect(ws_url, open_timeout=5, close_timeout=2, proxy=None) as socket:
                await socket.send(json.dumps({
                    'type': 'SUB', 'channel': 'SELECTIVE_CLIENT', 'message': f'Bearer {token}',
                }))
                loop = asyncio.get_running_loop()
                next_poll = loop.time() + 2
                while True:
                    delay = max(0, next_poll - loop.time())
                    try:
                        raw = await asyncio.wait_for(socket.recv(), delay)
                        message = json.loads(raw)
                        if not isinstance(message, dict):
                            continue
                        status = message.get('status')
                        if status == 'EXCEPTION':
                            raise ValueError('Subscription rejected')
                        if status in ('SC_START', 'SC_INIT'):
                            next_poll = min(next_poll, loop.time() + 1)
                        if status != 'SC_STATUS':
                            continue
                        rows = message.get('message')
                    except TimeoutError:
                        rows = await asyncio.to_thread(fetch_status, origin, token)
                        next_poll = loop.time() + 10
                    if not await apply_status(rows):
                        next_poll = min(next_poll, loop.time() + 2)
        except (OSError, ValueError, WebSocketException, sqlite3.Error) as error:
            logger.warning('Selective camera sync disconnected (%s). Reconnecting.', type(error).__name__)
        await asyncio.sleep(5)


def start_monitor():
    origin = os.getenv('SELECTIVE_BASE_URL')
    server_ip = os.getenv('SELECTIVE_SERVER_IP')
    token_file = os.getenv('SELECTIVE_TOKEN_FILE')
    if not any((origin, server_ip, token_file)):
        return None
    if not origin or not server_ip:
        logger.error('Selective camera sync requires SELECTIVE_BASE_URL and SELECTIVE_SERVER_IP.')
        return None
    if not token_file and urlsplit(origin).hostname not in ('127.0.0.1', 'localhost', '::1'):
        logger.error('Selective camera sync requires a token file for non-loopback origins.')
        return None
    master = Path(os.getenv('SELECTIVE_MASTER_CONFIG', DEFAULT_MASTER))
    return asyncio.create_task(monitor(origin, server_ip, master, Path(token_file) if token_file else None))
