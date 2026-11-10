"""Depacketize H.264 RTSP and relay access units without decoding/encoding."""

import re
import struct
import time

import av

HEADER = struct.Struct(">Bq")  # keyframe flag, signed PTS in microseconds
START_CODE = b"\x00\x00\x00\x01"
START_CODES = re.compile(b"\x00\x00\x00\x01|\x00\x00\x01")


class SourceEnded(Exception):
    """The RTSP source stopped delivering usable video."""


class UnsupportedCodec(Exception):
    """The source codec cannot be relayed by this demo."""


def annexb_units(data: bytes) -> list[bytes]:
    markers = list(START_CODES.finditer(data))
    if not markers or markers[0].start() != 0:
        raise SourceEnded("Invalid Annex B access unit")
    units = []
    for i, marker in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(data)
        unit = data[marker.end():end]
        if unit:
            units.append(unit)
    return units


def avcc_config(data: bytes) -> tuple[int, list[bytes]]:
    """Read an AVCDecoderConfigurationRecord (e.g. from MP4 extradata)."""
    if len(data) < 7 or data[0] != 1:
        raise SourceEnded("Invalid AVC configuration")
    length_size = (data[4] & 3) + 1
    offset = 6
    units = []
    count = data[5] & 31
    for group in range(2):
        if group == 1:
            if offset >= len(data):
                raise SourceEnded("Truncated AVC configuration")
            count = data[offset]
            offset += 1
        for _ in range(count):
            if offset + 2 > len(data):
                raise SourceEnded("Truncated AVC parameter set")
            size = int.from_bytes(data[offset:offset + 2], "big")
            offset += 2
            if not size or offset + size > len(data):
                raise SourceEnded("Invalid AVC parameter set")
            units.append(data[offset:offset + size])
            offset += size
    return length_size, units


def length_prefixed_units(data: bytes, length_size: int) -> list[bytes]:
    units = []
    offset = 0
    while offset < len(data):
        if offset + length_size > len(data):
            raise SourceEnded("Truncated NAL length")
        size = int.from_bytes(data[offset:offset + length_size], "big")
        offset += length_size
        if not size or offset + size > len(data):
            raise SourceEnded("Invalid NAL length")
        units.append(data[offset:offset + size])
        offset += size
    return units


class RTSPStream:
    def __init__(self, url: str):
        self.container = None
        try:
            self.container = av.open(
                url, mode="r", timeout=(5.0, 5.0),
                options={"rtsp_transport": "tcp"},
            )
            if not self.container.streams.video:
                raise SourceEnded("No video track")
            self.track = self.container.streams.video[0]
            context = self.track.codec_context
            if context.name != "h264":
                raise UnsupportedCodec
            self.width, self.height = context.width, context.height
            self.fps = float(self.track.average_rate or 0)
            self.parameter_sets = {7: [], 8: []}
            self.length_size = None
            extra = context.extradata or b""
            if extra:
                if extra[0] == 1:
                    self.length_size, units = avcc_config(extra)
                else:
                    units = annexb_units(extra)
                self._remember_parameters(units)
            self.packets = iter(self.container.demux(self.track))
            self.origin = None
            self.fallback_timestamp = 0
            self.waiting_for_idr = True
            # Parameter sets may be available only in-band. Start at an IDR so
            # a new browser never receives delta pictures without references.
            self.first_packet = self._read_packet()
            sps = self.parameter_sets[7][-1]
            self.codec = "avc1." + sps[1:4].hex()
        except BaseException:
            self.close()
            raise

    def _remember_parameters(self, units):
        for unit in units:
            kind = unit[0] & 31
            if kind in self.parameter_sets and unit not in self.parameter_sets[kind]:
                # Keep multiple parameter-set IDs and bound repeated updates.
                self.parameter_sets[kind].append(unit)
                self.parameter_sets[kind] = self.parameter_sets[kind][-32:]

    def _read_packet(self) -> bytes:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            packet = next(self.packets, None)
            if packet is None:
                raise SourceEnded("Video source ended")
            if not packet.size:
                continue
            data = bytes(packet)
            if self.length_size is not None:
                units = length_prefixed_units(data, self.length_size)
            else:
                units = annexb_units(data)
            self._remember_parameters(units)
            # WebCodecs H.264 key chunks require an IDR, not just an I picture.
            key = any(unit[0] & 31 == 5 for unit in units)
            if not any(1 <= unit[0] & 31 <= 5 for unit in units):
                continue
            if self.waiting_for_idr:
                if not key:
                    continue
                if not self.parameter_sets[7] or not self.parameter_sets[8]:
                    continue
                if len(self.parameter_sets[7][-1]) < 4:
                    raise SourceEnded("Invalid SPS")
                self.waiting_for_idr = False
            if key:
                # Repeat SPS/PPS on every IDR so decoder reset/reconnection works.
                # Slice NAL bytes are preserved; only transport framing changes.
                prefix = b"".join(START_CODE + unit for kind in (7, 8)
                                  for unit in self.parameter_sets[kind])
            else:
                prefix = b""
            if self.length_size is not None:
                data = b"".join(START_CODE + unit for unit in units)
            if packet.pts is not None and packet.time_base is not None:
                source_pts = int(packet.pts * packet.time_base * 1_000_000)
                if self.origin is None:
                    self.origin = source_pts
                timestamp = source_pts - self.origin
            else:
                timestamp = self.fallback_timestamp
            # Preserve presentation order, including nonmonotonic PTS for B frames.
            self.fallback_timestamp = timestamp + round(1_000_000 / (self.fps or 30))
            return HEADER.pack(int(key), timestamp) + prefix + data
        raise SourceEnded("Timed out waiting for an H.264 access unit")

    def next_packets(self) -> list[bytes]:
        if self.first_packet is not None:
            packet, self.first_packet = self.first_packet, None
            return [packet]
        return [self._read_packet()]

    def close(self):
        if self.container is not None:
            self.container.close()
            self.container = None
