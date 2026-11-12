"""H.264 framing only: no video decoding or encoding."""
import re

START = b'\x00\x00\x00\x01'


def annexb_nals(data):
    parts = re.split(b'\x00\x00\x00?\x01', data)
    return [part for part in parts[1:] if part]


def extradata_info(data):
    """Return original SPS/PPS NAL payloads and AVCC length width (0 for Annex B)."""
    if not data:
        return [], 0
    if data[0] != 1:
        return [nal for nal in annexb_nals(data) if nal[0] & 31 in (7, 8)], 0
    if len(data) < 7:
        raise ValueError('잘못된 AVC 설정입니다.')
    width = (data[4] & 3) + 1
    offset = 6
    nals = []
    counts = [data[5] & 31]
    for group in range(2):
        if group:
            if offset >= len(data):
                raise ValueError('잘못된 AVC 설정입니다.')
            counts.append(data[offset])
            offset += 1
        for _ in range(counts[group]):
            if offset + 2 > len(data):
                raise ValueError('잘못된 AVC 설정입니다.')
            size = int.from_bytes(data[offset:offset + 2], 'big')
            offset += 2
            if not size or offset + size > len(data):
                raise ValueError('잘못된 AVC 설정입니다.')
            nals.append(data[offset:offset + size])
            offset += size
    return nals, width


def packet_nals(data, length_width):
    if not length_width:
        nals = annexb_nals(data)
        if not nals:
            raise ValueError('Annex B NAL이 없습니다.')
        return nals
    nals = []
    offset = 0
    while offset < len(data):
        if offset + length_width > len(data):
            raise ValueError('잘못된 NAL 길이입니다.')
        size = int.from_bytes(data[offset:offset + length_width], 'big')
        offset += length_width
        if not size or offset + size > len(data):
            raise ValueError('잘못된 NAL 길이입니다.')
        nals.append(data[offset:offset + size])
        offset += size
    return nals


class H264Relay:
    def __init__(self, extradata=b''):
        parameters, self.length_width = extradata_info(extradata)
        self.parameters = {nal[0] & 31: nal for nal in parameters}

    def access_unit(self, data):
        nals = packet_nals(data, self.length_width)
        for nal in nals:
            if nal[0] & 31 in (7, 8):
                self.parameters[nal[0] & 31] = nal
        sps = self.parameters.get(7)
        if not sps or len(sps) < 4 or 8 not in self.parameters:
            return None
        # IDR is the random access point supported by this player.
        key = any(nal[0] & 31 == 5 for nal in nals)
        if not any(nal[0] & 31 in (1, 2, 3, 4, 5) for nal in nals):
            return None
        if key:
            # Repeat the exact source parameter sets for decoder reset / new clients.
            types = {nal[0] & 31 for nal in nals}
            nals = [self.parameters[t] for t in (7, 8) if t not in types] + nals
        return 'avc1.' + sps[1:4].hex(), key, b''.join(START + nal for nal in nals)
