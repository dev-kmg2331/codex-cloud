import os
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix='/api/cameras')
DATABASE = Path(__file__).resolve().parent.parent / 'db.sqlite3'
MAX_BULK_CAMERAS = 100


class CameraRegistration(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    rtsp_url: str = Field(min_length=1, max_length=4096)


class BulkCameraRegistration(BaseModel):
    cameras: list[CameraRegistration] = Field(min_length=1, max_length=MAX_BULK_CAMERAS)


def open_database():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    with connection:
        connection.execute('''CREATE TABLE IF NOT EXISTS cameras (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            rtsp_url TEXT NOT NULL
        )''')
    try:
        if 'selective_stream_id' not in {row['name'] for row in connection.execute('PRAGMA table_info(cameras)')}:
            with connection:
                connection.execute('BEGIN IMMEDIATE')
                if 'selective_stream_id' not in {row['name'] for row in connection.execute('PRAGMA table_info(cameras)')}:
                    connection.execute('ALTER TABLE cameras ADD COLUMN selective_stream_id TEXT')
                    connection.execute('ALTER TABLE cameras ADD COLUMN selective_camera_id TEXT')
                    connection.execute('ALTER TABLE cameras ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
                    connection.execute('CREATE UNIQUE INDEX cameras_selective_stream ON cameras(selective_stream_id)')
    except Exception:
        connection.close()
        raise
    return connection


def camera_url(camera_id):
    with closing(open_database()) as connection:
        row = connection.execute('SELECT rtsp_url FROM cameras WHERE id = ? AND active = 1', (camera_id,)).fetchone()
    if row is None:
        raise ValueError('등록된 카메라를 찾을 수 없습니다.')
    return row['rtsp_url']


def selective_stream_id(camera_id):
    with closing(open_database()) as connection:
        row = connection.execute(
            'SELECT selective_stream_id FROM cameras WHERE id = ? AND active = 1', (camera_id,)
        ).fetchone()
    return row['selective_stream_id'] if row else None


@router.get('')
def list_cameras():
    bbox_enabled = bool(os.getenv('SELECTIVE_BBOX_SOCKET'))
    with closing(open_database()) as connection:
        rows = connection.execute(
            'SELECT id, name, selective_stream_id FROM cameras WHERE active = 1 ORDER BY id'
        )
        return [
            {'id': row['id'], 'name': row['name'], **({'bboxAvailable': True} if bbox_enabled and row['selective_stream_id'] else {})}
            for row in rows
        ]


def sync_selective_cameras(cameras):
    with closing(open_database()) as connection, connection:
        connection.execute('BEGIN IMMEDIATE')
        active_streams = {
            row['selective_stream_id'] for row in connection.execute(
                'SELECT selective_stream_id FROM cameras WHERE selective_stream_id IS NOT NULL AND active = 1'
            )
        }
        connection.executemany(
            'UPDATE cameras SET active = 0 WHERE selective_stream_id = ?',
            [(stream_id,) for stream_id in active_streams - cameras.keys()],
        )
        connection.executemany('''
            INSERT INTO cameras (name, rtsp_url, selective_stream_id, selective_camera_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(selective_stream_id) DO UPDATE SET
                name = excluded.name, rtsp_url = excluded.rtsp_url,
                selective_camera_id = excluded.selective_camera_id, active = 1
        ''', [(name, url, stream_id, camera_id) for stream_id, (camera_id, name, url) in cameras.items()])


def validated_camera(camera: CameraRegistration):
    name = camera.name.strip()
    url = camera.rtsp_url.strip()
    if not name:
        raise ValueError('카메라 이름을 입력하세요.')
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('rtsp', 'rtsps') or not parsed.hostname:
            raise ValueError
        parsed.port
    except ValueError:
        raise ValueError('유효한 rtsp:// 또는 rtsps:// 주소를 입력하세요.') from None
    return name, url


def insert_cameras(cameras):
    registered = []
    with closing(open_database()) as connection, connection:
        for name, url in cameras:
            camera_id = connection.execute(
                'INSERT INTO cameras (name, rtsp_url) VALUES (?, ?)', (name, url)
            ).lastrowid
            registered.append({'id': camera_id, 'name': name})
    return registered


@router.post('', status_code=201)
def register_camera(camera: CameraRegistration):
    try:
        camera_data = validated_camera(camera)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return insert_cameras([camera_data])[0]


@router.post('/bulk', status_code=201)
async def register_cameras(request: Request):
    try:
        registration = BulkCameraRegistration.model_validate_json(await request.body())
    except ValidationError as error:
        # Keep submitted URLs and credentials out of validation responses.
        location = error.errors(include_input=False, include_context=False, include_url=False)[0]['loc']
        if len(location) > 1 and isinstance(location[1], int):
            raise HTTPException(422, f'{location[1] + 1}번째 카메라의 이름과 RTSP 주소를 확인하세요.') from None
        raise HTTPException(422, f'카메라를 1대 이상 {MAX_BULK_CAMERAS}대 이하로 입력하세요.') from None

    cameras = []
    for number, camera in enumerate(registration.cameras, start=1):
        try:
            cameras.append(validated_camera(camera))
        except ValueError as error:
            raise HTTPException(422, f'{number}번째 카메라를 확인하세요. {error}') from None
    return await run_in_threadpool(insert_cameras, cameras)
