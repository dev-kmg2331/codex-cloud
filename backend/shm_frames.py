"""Read a frame fingerprint from the OMEYE shared-memory arena."""

import hashlib
import os
from pathlib import Path
import re
import stat
import struct

from backend.nal import annexb_nals


ARENA_DIRECTORY = Path('/dev/shm')
INDEX_HEADER_SIZE = 640
CAPACITY_OFFSET = 0x94
SLOT_SIZE = 128
BUFFER_HEADER_SIZE = 64
BUFFER_MAGIC = 0x42554641
BUFFER_VERSION = 2
H264_FORMAT = 100
MAX_FRAME_SIZE = 8 * 1024 * 1024
SLOT_HEADER = struct.Struct('<QQIIQ')


def vcl_fingerprint(data):
    """Hash the ordered H.264 slice NALs, ignoring framing and parameter sets."""
    digest = hashlib.sha256()
    found_slice = False
    for nal in annexb_nals(data):
        if nal[0] & 31 in (1, 2, 3, 4, 5):
            digest.update(len(nal).to_bytes(4, 'big'))
            digest.update(nal)
            found_slice = True
    return digest.digest() if found_slice else None


def _open_arena(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    return os.fdopen(fd, 'rb', buffering=0)


def shm_frame_signature(metadata):
    """Return a fingerprint only when the broker still identifies this exact slot."""
    camera_id = metadata.get('camera_id')
    frame_id = metadata.get('frame_id')
    slot = metadata.get('shm_slot')
    if (metadata.get('mode') != 'shm' or not hasattr(os, 'pread')
            or not isinstance(camera_id, str) or not re.fullmatch(r'[0-9]{1,16}', camera_id)
            or type(frame_id) is not int or not 0 < frame_id < 2**64
            or type(slot) is not int or not 0 <= slot < 2**64):
        return None

    try:
        with (_open_arena(ARENA_DIRECTORY / f'stream-{camera_id}_aidx') as index,
              _open_arena(ARENA_DIRECTORY / f'stream-{camera_id}_abuf') as buffer):
            index_fd, buffer_fd = index.fileno(), buffer.fileno()
            index_stat, buffer_stat = os.fstat(index_fd), os.fstat(buffer_fd)
            if not stat.S_ISREG(index_stat.st_mode) or not stat.S_ISREG(buffer_stat.st_mode):
                return None

            capacity, = struct.unpack('<I', os.pread(index_fd, 4, CAPACITY_OFFSET))
            if not capacity or index_stat.st_size != INDEX_HEADER_SIZE + SLOT_SIZE * capacity:
                return None
            magic, version, ring_size = struct.unpack('<IIQ', os.pread(buffer_fd, 16, 0))
            if (magic != BUFFER_MAGIC or version != BUFFER_VERSION or not ring_size
                    or buffer_stat.st_size != BUFFER_HEADER_SIZE + ring_size):
                return None

            entry_offset = INDEX_HEADER_SIZE + SLOT_SIZE * (slot % capacity)
            entry = os.pread(index_fd, SLOT_SIZE, entry_offset)
            _, data_offset, length, codec, timestamp = SLOT_HEADER.unpack_from(entry)
            stored_id = entry[SLOT_HEADER.size:SLOT_HEADER.size + 32].split(b'\0', 1)[0]
            if (len(entry) != SLOT_SIZE or codec != H264_FORMAT or timestamp != frame_id
                    or stored_id != str(frame_id).encode('ascii')
                    or not 0 < length <= min(MAX_FRAME_SIZE, ring_size)):
                return None

            start = data_offset % ring_size
            first_length = min(length, ring_size - start)
            data = os.pread(buffer_fd, first_length, BUFFER_HEADER_SIZE + start)
            if length > first_length:
                data += os.pread(buffer_fd, length - first_length, BUFFER_HEADER_SIZE)
            if len(data) != length or os.pread(index_fd, SLOT_SIZE, entry_offset) != entry:
                return None
    except (OSError, struct.error):
        return None

    return vcl_fingerprint(data)
