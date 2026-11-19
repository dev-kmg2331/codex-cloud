import asyncio
import json
import socket
import struct
import sys
import unittest
from unittest.mock import patch
from urllib.request import urlopen

import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
from backend.app import MAX_PENDING_MESSAGES, SharedRelay, app, read_frame, relays, worker_request
from backend.nal import H264Relay, START, annexb_nals
from backend.shm_frames import vcl_fingerprint


class PacketTests(unittest.IsolatedAsyncioTestCase):
    async def test_nal_payload_is_unchanged(self):
        sps, pps, idr = b'\x67\x42\xe0\x1e\xab', b'\x68\xce\x01', b'\x65\x88\x84\x21'
        delta = b'\x41\x9a\x22'
        source = START + sps + b'\x00\x00\x01' + pps + START + idr
        relay = H264Relay()
        codec, key, output = relay.access_unit(source)
        self.assertEqual(codec, 'avc1.42e01e')
        self.assertTrue(key)
        self.assertEqual(annexb_nals(output), [sps, pps, idr])
        self.assertEqual(relay.access_unit(START + delta), (codec, False, START + delta))
        self.assertEqual(annexb_nals(relay.access_unit(START + idr)[2]), [sps, pps, idr])

    async def test_avcc_to_annexb_preserves_nals(self):
        sps, pps, idr = b'\x67\x42\xe0\x1e\xab', b'\x68\xce\x01', b'\x65\x88\x84\x21'
        extra = b'\x01\x42\xe0\x1e\xff\xe1' + len(sps).to_bytes(2, 'big') + sps + b'\x01' + len(pps).to_bytes(2, 'big') + pps
        relay = H264Relay(extra)
        output = relay.access_unit(len(idr).to_bytes(4, 'big') + idr)
        self.assertEqual(annexb_nals(output[2]), [sps, pps, idr])
        with self.assertRaises(ValueError):
            relay.access_unit(b'\x00\x00\x01\xffx')

    async def test_framed_reader(self):
        reader = asyncio.StreamReader()
        body = b'\x01' + struct.pack('>Bq', 1, -100) + START + b'\x65abc'
        reader.feed_data(struct.pack('>I', len(body)) + body)
        self.assertEqual(await read_frame(reader), body)

    async def test_reject_oversize_frame(self):
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack('>I', 100_000_000))
        with self.assertRaises(ValueError):
            await read_frame(reader)

    async def test_only_rtsp_urls(self):
        for url in ('file:///etc/passwd', 'http://camera', '', 'rtsp:///missing-host'):
            with self.assertRaises(ValueError):
                worker_request(url)
        self.assertEqual(worker_request('rtsp://camera/live')['url'], 'rtsp://camera/live')


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_viewer_resumes_from_keyframe_without_unsubscribing(self):
        source = 'rtsp://camera/live'
        config = {'type': 'config', 'codec': 'avc1.42e01e'}
        first_key = struct.pack('>Bq', 1, 0) + START + b'\x65first'
        delta = struct.pack('>Bq', 0, 1) + START + b'\x41delta'
        next_key = struct.pack('>Bq', 1, 2) + START + b'\x65next'

        for overflow_frame in (delta, next_key):
            with self.subTest(overflow_is_key=overflow_frame is next_key):
                with patch.object(SharedRelay, 'run'):
                    relay = SharedRelay(source, worker_request(source))
                    await relay.task

                slow_viewer = relay.add_viewer()
                fast_viewer = relay.add_viewer()
                relay.config = config
                relay.publish(config)
                self.assertEqual(fast_viewer.messages.get_nowait(), config)

                relay.publish(first_key)
                self.assertEqual(fast_viewer.messages.get_nowait(), first_key)
                for _ in range(MAX_PENDING_MESSAGES - 2):
                    relay.publish(delta)
                    self.assertEqual(fast_viewer.messages.get_nowait(), delta)

                relay.publish(overflow_frame)
                self.assertEqual(fast_viewer.messages.get_nowait(), overflow_frame)
                self.assertIn(slow_viewer, relay.viewers)
                self.assertFalse(relay.stopping.is_set())
                self.assertEqual(slow_viewer.messages.get_nowait(), config)

                if overflow_frame is delta:
                    relay.publish(delta)
                    self.assertEqual(fast_viewer.messages.get_nowait(), delta)
                    self.assertTrue(slow_viewer.messages.empty())
                    relay.publish(next_key)
                    self.assertEqual(fast_viewer.messages.get_nowait(), next_key)

                self.assertEqual(slow_viewer.messages.get_nowait(), next_key)
                self.assertTrue(slow_viewer.messages.empty())

                relay.publish(delta)
                self.assertEqual(slow_viewer.messages.get_nowait(), delta)
                self.assertEqual(fast_viewer.messages.get_nowait(), delta)


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        self.port = self.sock.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
        self.task = asyncio.create_task(self.server.serve(sockets=[self.sock]))
        for _ in range(100):
            if self.server.started:
                break
            await asyncio.sleep(.02)
        self.assertTrue(self.server.started)
        self.url = f'ws://127.0.0.1:{self.port}/ws/stream'

    async def asyncTearDown(self):
        self.server.should_exit = True
        await asyncio.wait_for(self.task, 5)

    async def test_python_hosts_react_and_health(self):
        def get(path):
            with urlopen(f'http://127.0.0.1:{self.port}{path}') as response:
                return response.read(), response.headers
        body, headers = await asyncio.to_thread(get, '/')
        self.assertIn(b'/assets/', body)
        self.assertEqual(headers['Cross-Origin-Embedder-Policy'], 'require-corp')
        body, _ = await asyncio.to_thread(get, '/api/health')
        self.assertTrue(json.loads(body)['ffmpeg'])

    async def test_real_ffmpeg_stream_and_disconnect_cleanup(self):
        processes = []
        create = asyncio.create_subprocess_exec

        async def capture(*args, **kwargs):
            proc = await create(*args, **kwargs)
            processes.append(proc)
            return proc

        with patch('backend.app.asyncio.create_subprocess_exec', capture):
            async with connect(self.url) as ws:
                await ws.send(json.dumps({'demo': True}))
                config = json.loads(await asyncio.wait_for(ws.recv(), 10))
                self.assertTrue(config['codec'].startswith('avc1.'))
                timestamps = []
                for index in range(5):
                    packet = await asyncio.wait_for(ws.recv(), 5)
                    self.assertIsInstance(packet, bytes)
                    key, timestamp = struct.unpack('>Bq', packet[:9])
                    if index == 0:
                        self.assertEqual(key, 1)
                        types = [nal[0] & 31 for nal in annexb_nals(packet[9:])]
                        self.assertIn(7, types)
                        self.assertIn(8, types)
                        self.assertIn(5, types)
                    timestamps.append(timestamp)
                self.assertEqual(timestamps, sorted(timestamps))
                self.assertGreater(timestamps[-1], timestamps[0])
            await asyncio.wait_for(processes[0].wait(), 5)
            self.assertEqual(processes[0].returncode, 0, 'Worker should run cleanup and exit gracefully')

    async def test_same_rtsp_url_shares_worker_until_last_viewer_leaves(self):
        source = 'rtsp://camera/live'
        requests = []
        processes = []
        workers = asyncio.Queue()
        writers = []
        create_process = asyncio.create_subprocess_exec
        fake_worker = '''
import socket
import sys

request = sys.stdin.buffer.readline()
with socket.create_connection(('127.0.0.1', int(sys.argv[1]))) as control:
    control.sendall(request)
    while chunk := control.recv(65536):
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
'''

        def connected(reader, writer):
            writers.append(writer)
            workers.put_nowait((reader, writer))

        control = await asyncio.start_server(connected, '127.0.0.1', 0)
        control_port = control.sockets[0].getsockname()[1]

        async def start_worker(*args, **kwargs):
            process = await create_process(sys.executable, '-u', '-c', fake_worker, str(control_port), **kwargs)
            processes.append(process)
            return process

        async def next_worker():
            reader, writer = await asyncio.wait_for(workers.get(), 5)
            requests.append(json.loads(await asyncio.wait_for(reader.readline(), 5)))
            return writer

        def framed(kind, payload):
            return struct.pack('>IB', len(payload) + 1, kind) + payload

        async def receive(ws):
            return await asyncio.wait_for(ws.recv(), 5)

        config = {'type': 'config', 'codec': 'avc1.42e01e'}
        config_frame = framed(0, json.dumps(config).encode())
        first_key = struct.pack('>Bq', 1, 0) + START + b'\x65first'
        delta = struct.pack('>Bq', 0, 1) + START + b'\x41delta'
        next_key = struct.pack('>Bq', 1, 2) + START + b'\x65next'

        try:
            async with control:
                with (
                    patch('backend.app.asyncio.create_subprocess_exec', start_worker),
                    patch('backend.app.camera_url', return_value=source) as lookup,
                ):
                    async with connect(self.url) as first, connect(self.url) as second:
                        await first.send(json.dumps({'url': source}))
                        writer = await next_worker()
                        writer.write(config_frame + framed(1, first_key))
                        self.assertEqual(json.loads(await receive(first)), config)
                        self.assertEqual(await receive(first), first_key)

                        await second.send(json.dumps({'cameraId': 7}))
                        self.assertEqual(json.loads(await receive(second)), config)
                        lookup.assert_called_once_with(7)
                        self.assertEqual(len(processes), 1)

                        writer.write(framed(1, delta) + framed(1, next_key))
                        self.assertEqual(await receive(first), delta)
                        self.assertEqual(await receive(first), next_key)
                        self.assertEqual(await receive(second), next_key)

                        await first.close()
                        writer.write(framed(1, delta))
                        self.assertEqual(await receive(second), delta)
                        self.assertIsNone(processes[0].returncode)

                    await asyncio.wait_for(processes[0].wait(), 5)
                    async with connect(self.url) as reopened:
                        await reopened.send(json.dumps({'url': source}))
                        writer = await next_worker()
                        writer.write(config_frame + framed(1, first_key))
                        self.assertEqual(json.loads(await receive(reopened)), config)
                        self.assertEqual(await receive(reopened), first_key)
                    await asyncio.wait_for(processes[1].wait(), 5)
                    self.assertEqual(requests, [{'url': source, 'demo': False}] * 2)
        finally:
            for writer in writers:
                writer.close()
            await asyncio.gather(*(writer.wait_closed() for writer in writers), return_exceptions=True)

    async def test_stream_keeps_playing_while_bbox_is_delayed_disabled_or_failing(self):
        source = 'rtsp://camera/bbox-test'
        config = {'type': 'config', 'codec': 'avc1.42e01e'}
        keyframe = struct.pack('>Bq', 1, 0) + START + b'\x65keyframe'
        matched_delta = struct.pack('>Bq', 0, 1234) + START + b'\x41matched'
        disabled_delta = struct.pack('>Bq', 0, 1500) + START + b'\x41disabled'
        failure_delta = struct.pack('>Bq', 0, 1800) + START + b'\x41failure'
        unrelated_delta = struct.pack('>Bq', 0, 2000) + START + b'\x41unrelated'
        later_match = struct.pack('>Bq', 0, 3456) + START + b'\x41later'
        bbox = {'type': 'bbox', 'width': 1280, 'height': 768, 'boxes': []}
        subscriptions = asyncio.Queue()
        stopped = asyncio.Queue()
        outcome = asyncio.Queue()
        offered = asyncio.Queue()

        async def run_video(relay):
            relay.config = config
            relay.publish(config)
            relay.publish(keyframe)
            try:
                await relay.stopping.wait()
            finally:
                del relays[relay.key]

        async def run_bbox(camera_id, on_bbox, *, synchronize=False):
            subscriptions.put_nowait((camera_id, synchronize))
            try:
                video_packet = await outcome.get()
                if video_packet is None:
                    raise OSError('broker unavailable')
                on_bbox({**bbox, 'frameSignature': vcl_fingerprint(video_packet[9:]), 'frameId': 1700000000000123})
                offered.put_nowait(video_packet)
                await asyncio.Future()
            finally:
                stopped.put_nowait(camera_id)

        async def receive(ws):
            message = await asyncio.wait_for(ws.recv(), 5)
            return json.loads(message) if isinstance(message, str) else message

        async def set_bbox(ws, enabled, revision):
            await ws.send(json.dumps({'type': 'bbox', 'enabled': enabled, 'bboxRevision': revision}))

        async def assert_bbox(ws, revision, pts):
            message = await receive(ws)
            self.assertIsInstance(message, dict)
            self.assertNotIn('frameSignature', message)
            message.pop('frameId', None)
            self.assertEqual(message, {**bbox, 'bboxRevision': revision, 'ptsUs': pts})

        with (
            patch.object(SharedRelay, 'run', run_video),
            patch('backend.app.camera_url', return_value=source),
            patch('backend.app.subscribe_bbox', run_bbox),
        ):
            async with connect(self.url) as ws:
                await ws.send(json.dumps({'cameraId': 7, 'bbox': True, 'bboxRevision': 1}))
                self.assertEqual(await asyncio.wait_for(subscriptions.get(), 5), (7, True))
                self.assertEqual(await receive(ws), config)
                self.assertEqual(await receive(ws), keyframe)

                relays[source].publish(matched_delta)
                self.assertEqual(await receive(ws), matched_delta)
                outcome.put_nowait(matched_delta)
                self.assertEqual(await asyncio.wait_for(offered.get(), 5), matched_delta)
                await assert_bbox(ws, 1, 1234)
                await set_bbox(ws, False, 2)
                self.assertEqual(await asyncio.wait_for(stopped.get(), 5), 7)
                relays[source].publish(disabled_delta)
                self.assertEqual(await receive(ws), disabled_delta)

                await set_bbox(ws, True, 3)
                self.assertEqual(await asyncio.wait_for(subscriptions.get(), 5), (7, True))
                outcome.put_nowait(None)
                error = await receive(ws)
                self.assertEqual(error['type'], 'bbox_error')
                self.assertEqual(error['bboxRevision'], 3)
                self.assertEqual(await asyncio.wait_for(stopped.get(), 5), 7)
                relays[source].publish(failure_delta)
                self.assertEqual(await receive(ws), failure_delta)

                await set_bbox(ws, True, 4)
                self.assertEqual(await asyncio.wait_for(subscriptions.get(), 5), (7, True))
                outcome.put_nowait(later_match)
                self.assertEqual(await asyncio.wait_for(offered.get(), 5), later_match)
                relays[source].publish(unrelated_delta)
                self.assertEqual(await receive(ws), unrelated_delta)
                relays[source].publish(later_match)
                self.assertEqual(await receive(ws), later_match)
                await assert_bbox(ws, 4, 3456)
            self.assertEqual(await asyncio.wait_for(stopped.get(), 5), 7)

    async def test_invalid_url_and_cross_origin(self):
        async with connect(self.url) as ws:
            await ws.send(json.dumps({'url': 'file:///etc/passwd'}))
            error = json.loads(await ws.recv())
            self.assertEqual(error['type'], 'error')
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, origin='https://other.example'):
                pass
