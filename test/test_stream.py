import asyncio
import json
import socket
import struct
import unittest
from unittest.mock import patch
from urllib.request import urlopen

import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
from backend.app import app, worker_request, read_frame
from backend.nal import H264Relay, START, annexb_nals


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

    async def test_invalid_url_and_cross_origin(self):
        async with connect(self.url) as ws:
            await ws.send(json.dumps({'url': 'file:///etc/passwd'}))
            error = json.loads(await ws.recv())
            self.assertEqual(error['type'], 'error')
        with self.assertRaises(InvalidStatus):
            async with connect(self.url, origin='https://other.example'):
                pass
