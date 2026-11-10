from fractions import Fraction

import av
import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.video import (
    HEADER, START_CODE, RTSPStream, SourceEnded, UnsupportedCodec,
    annexb_units, avcc_config, length_prefixed_units,
)


@pytest.fixture(params=[0, 2], ids=["no-b-frames", "b-frames"])
def video_file(tmp_path, request):
    path = tmp_path / "source.mp4"
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=30)
        stream.width, stream.height = 64, 48
        stream.pix_fmt = "yuv420p"
        stream.codec_context.max_b_frames = request.param
        stream.options = {"preset": "medium", "g": "6", "sc_threshold": "0"}
        for i in range(12):
            frame = av.VideoFrame(64, 48, "yuv420p")
            for j, plane in enumerate(frame.planes):
                plane.update(bytes([70 + i * 5 if j == 0 else 128]) * plane.buffer_size)
            frame.pts = i
            frame.time_base = Fraction(1, 30)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return str(path)


@pytest.fixture
def local_rtsp(monkeypatch, video_file):
    real_open = av.open
    # Read the input compressed slices before patching the RTSP boundary.
    expected = []
    with real_open(video_file) as container:
        size, _ = avcc_config(container.streams.video[0].codec_context.extradata)
        for packet in container.demux(video=0):
            if packet.size:
                expected.append([n for n in length_prefixed_units(bytes(packet), size)
                                 if 1 <= n[0] & 31 <= 5])

    def open_source(url, **kwargs):
        assert url == "rtsp://camera.local/live"
        assert kwargs["options"]["rtsp_transport"] == "tcp"
        assert kwargs["timeout"] == (5.0, 5.0)
        return real_open(video_file)

    monkeypatch.setattr(av, "open", open_source)
    return expected


def test_health_config_and_page():
    with TestClient(app) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        assert client.get("/api/config").json()["mode"] == "passthrough"
        assert "RTSP 소스" in client.get("/").text
        assert client.get("/static/app.js").status_code == 200


@pytest.mark.parametrize("url", ["", "https://example.com/video", "rtsp://", "rtsp://host:99999/live", "rtsp://host/a b", ["rtsp://host/live"]])
def test_invalid_rtsp_address(url):
    with TestClient(app) as client, client.websocket_connect("/ws/stream") as ws:
        ws.send_json({"type": "start", "rtspUrl": url})
        assert ws.receive_json()["type"] == "error"
        assert ws.receive()["code"] == 1008


def test_binary_start_is_rejected():
    with TestClient(app) as client, client.websocket_connect("/ws/stream") as ws:
        ws.send_bytes(b"not json")
        assert ws.receive_json()["type"] == "error"


def test_source_preserves_original_slices_and_is_decodable(local_rtsp):
    source = RTSPStream("rtsp://camera.local/live")
    decoder = av.CodecContext.create("h264", "r")
    forwarded = []
    frames = []
    timestamps = []
    try:
        assert source.codec.startswith("avc1.")
        assert (source.width, source.height) == (64, 48)
        while True:
            try:
                packets = source.next_packets()
            except SourceEnded:
                break
            for raw in packets:
                key, timestamp = HEADER.unpack(raw[:HEADER.size])
                units = annexb_units(raw[HEADER.size:])
                if key:
                    assert any(n[0] & 31 == 7 for n in units)
                    assert any(n[0] & 31 == 8 for n in units)
                    assert any(n[0] & 31 == 5 for n in units)
                if not timestamps:
                    assert (key, timestamp) == (1, 0)
                timestamps.append(timestamp)
                forwarded.append([n for n in units if 1 <= n[0] & 31 <= 5])
                packet = av.Packet(raw[HEADER.size:])
                packet.pts = timestamp
                packet.time_base = Fraction(1, 1_000_000)
                frames.extend(decoder.decode(packet))
        frames.extend(decoder.decode(None))
        assert forwarded == local_rtsp  # exact compressed slice bytes, no re-encode
        assert len(frames) == len(timestamps) == 12  # no sampling/dropping
        assert all((f.width, f.height) == (64, 48) for f in frames)
    finally:
        source.close()
        source.close()
    assert source.container is None


def test_websocket_negotiates_then_sends_annexb(local_rtsp):
    with TestClient(app) as client, client.websocket_connect("/ws/stream") as ws:
        ws.send_json({"type": "start", "rtspUrl": "rtsp://camera.local/live"})
        config = ws.receive_json()
        assert config["type"] == "config" and config["codec"].startswith("avc1.")
        assert config["mode"] == "passthrough"
        assert config["headerBytes"] == HEADER.size
        ws.send_json({"type": "ready"})
        packet = ws.receive_bytes()
        assert HEADER.unpack(packet[:HEADER.size]) == (1, 0)
        assert packet[HEADER.size:].startswith(START_CODE)


def test_failed_source_does_not_expose_credentials(monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("rtsp://user:secret@camera.local/live")

    monkeypatch.setattr(av, "open", fail)
    with TestClient(app) as client, client.websocket_connect("/ws/stream") as ws:
        ws.send_json({"type": "start", "rtspUrl": "rtsp://user:secret@camera.local/live"})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert "secret" not in error["message"]
        assert ws.receive()["code"] == 1011


def test_unsupported_codec_has_clear_error(monkeypatch):
    def fail(*args, **kwargs):
        raise UnsupportedCodec

    monkeypatch.setattr("server.main.RTSPStream", fail)
    with TestClient(app) as client, client.websocket_connect("/ws/stream") as ws:
        ws.send_json({"type": "start", "rtspUrl": "rtsp://camera.local/live"})
        assert "H.264" in ws.receive_json()["message"]
        assert ws.receive()["code"] == 1003


def test_annexb_preserves_multiple_nals_in_access_unit():
    sps, pps, slice1, slice2 = b"\x67\x42\x00\x1e", b"\x68\xee", b"\x65\x11\x22", b"\x65\x33\x44"
    data = b"\x00\x00\x01" + sps + START_CODE + pps + START_CODE + slice1 + START_CODE + slice2
    assert annexb_units(data) == [sps, pps, slice1, slice2]


@pytest.mark.parametrize("data", [b"", b"\x00\x00\x00\x10\x65", b"\x00\x00"])
def test_malformed_length_prefix_is_rejected(data):
    if not data:
        assert length_prefixed_units(data, 4) == []
    else:
        with pytest.raises(SourceEnded):
            length_prefixed_units(data, 4)
