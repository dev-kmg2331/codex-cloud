"""Isolated blocking RTSP demuxer. stdout is framed JSON / Annex B access units."""
import json
import signal
import struct
import subprocess
import sys

import av

from backend.nal import H264Relay


def emit(kind, body):
    payload = bytes([kind]) + body
    sys.stdout.buffer.write(struct.pack('>I', len(payload)) + payload)
    sys.stdout.buffer.flush()


def main():
    request = json.loads(sys.stdin.readline())
    demo = None
    try:
        if request.get('demo'):
            # Synthetic source only. Real RTSP input never passes through an encoder.
            demo = subprocess.Popen([
                'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                '-re', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25',
                '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-g', '25',
                '-f', 'mpegts', '-flush_packets', '1', 'pipe:1',
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            source = av.open(demo.stdout, format='mpegts')
        else:
            source = av.open(request['url'], options={'rtsp_transport': 'tcp'}, timeout=(10, 10))
        with source:
            video = next((stream for stream in source.streams.video), None)
            if video is None or video.codec_context.name != 'h264':
                raise ValueError('H.264 RTSP 스트림만 지원합니다. 카메라 코덱 설정을 확인하세요.')
            relay = H264Relay(video.codec_context.extradata or b'')
            codec = None
            waiting_key = True
            for packet in source.demux(video):
                if not packet.size:
                    continue
                au = relay.access_unit(bytes(packet))
                if au is None:
                    continue
                current_codec, key, data = au
                if current_codec != codec:
                    if not key:
                        continue
                    codec = current_codec
                    waiting_key = True
                    emit(0, json.dumps({'type': 'config', 'codec': codec}).encode())
                if waiting_key and not key:
                    continue
                waiting_key = False
                if packet.pts is None or packet.time_base is None:
                    raise ValueError('영상 프레임에 PTS가 없습니다.')
                timestamp = int(packet.pts * packet.time_base * 1_000_000)
                emit(1, struct.pack('>Bq', int(key), timestamp) + data)
    finally:
        if demo:
            if demo.stdout:
                demo.stdout.close()
            if demo.poll() is None:
                demo.terminate()
                try:
                    demo.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    demo.kill()
                    demo.wait()


def terminate(signum, frame):
    # Run the demo process cleanup before exiting, including when the group is stopped.
    raise SystemExit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    av.logging.set_level(av.logging.PANIC)
    try:
        main()
    except ValueError as error:
        emit(0, json.dumps({'type': 'error', 'message': str(error)}).encode())
    except Exception:
        # PyAV/FFmpeg errors may contain credentials; never log or forward them.
        emit(0, json.dumps({'type': 'error', 'message': 'RTSP 영상을 받을 수 없습니다. 주소, 인증, H.264 설정 및 네트워크를 확인하세요.'}).encode())
