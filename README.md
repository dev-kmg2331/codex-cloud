# WebCodecs RTSP 데모

H.264 RTSP 주소를 입력하면 Python 서버가 압축된 NAL 데이터를 그대로 전달하고, 브라우저의 WebCodecs `VideoDecoder`로 재생합니다. 서버에서 영상 디코딩·재인코딩·프레임 샘플링을 수행하지 않습니다.

```text
H.264 RTSP → RTP 재조립 / demux → Annex B access unit → WebSocket → VideoDecoder → Canvas
```

## 실행

Python 3.11 이상과 최신 Chrome 또는 Edge가 필요합니다.

Git clone 후 저장소 폴더에서 다음 명령만 실행하면 됩니다.
첫 실행에는 `.venv` 가상환경과 필요한 패키지를 자동으로 준비하고 서버와 브라우저를 실행합니다.
이후 실행에는 설치된 패키지를 재사용합니다.
실행 의존성은 `requirements.txt`에서 관리하며 `main.py`가 이 파일을 읽어 설치합니다.
테스트용 `pytest`, `httpx`, `playwright`는 `requirements-dev.txt`에 별도로 정리했습니다.

```bash
python3 main.py
```

Windows에서는 `python main.py` 또는 `py -3 main.py`를 사용할 수 있습니다.
포트가 사용 중이면 `python3 main.py --port 8001`로 변경할 수 있습니다.
브라우저 자동 실행 없이 서버만 실행하려면 `python3 main.py --no-browser`를 사용하세요.
브라우저가 자동으로 열리지 않거나 기본 브라우저가 WebCodecs를 지원하지 않으면 Chrome 또는 Edge에서 `http://127.0.0.1:8000`을 직접 여세요. 종료는 실행 터미널에서 `Ctrl+C`를 누릅니다.
이때 RTSP 접속은 해당 PC에서 이루어지므로 PC가 접근할 수 있는 H.264 RTSP 주소를 입력하면 됩니다.

수동 설치·실행:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
```

Windows에서는 가상환경을 `.venv\Scripts\activate`로 활성화합니다. PyAV 배포 휠에는 FFmpeg 라이브러리가 포함되어 있어 일반적인 환경에서는 `ffmpeg` 실행 파일을 별도로 설치할 필요가 없습니다.

1. 브라우저에서 <http://localhost:8000>에 접속합니다.
2. `rtsp://192.168.0.100:554/stream`처럼 서버가 접근 가능한 RTSP 주소를 입력합니다.
3. **스트리밍 시작**을 누릅니다. 원본 코덱·해상도·FPS를 자동으로 표시합니다.
4. **스트리밍 중지**를 누르면 연결과 디코더를 해제합니다. 주소를 변경한 뒤 다시 시작할 수 있습니다.

인증이 필요한 소스는 `rtsp://사용자:비밀번호@호스트:554/경로` 형식을 사용합니다. 사용자명·비밀번호의 특수문자는 URL 인코딩하세요. 입력 주소는 WebSocket의 시작 메시지로 전송하며 브라우저 저장소나 애플리케이션 로그에 저장하지 않습니다.

RTSP는 Python 서버를 실행하는 컴퓨터에서 접근할 수 있어야 합니다. 전송은 RTSP over TCP를 사용하며, 입력 연결과 읽기 제한 시간은 각각 5초입니다. 원격 컴퓨터에서 페이지에 접속할 때는 HTTPS/WSS를 사용해야 WebCodecs를 사용할 수 있습니다. `localhost`는 HTTP에서도 사용할 수 있습니다.

## 기능

- RTSP 영상 재생·중지·재연결
- H.264 원본 압축 데이터 전송, 원본 해상도·FPS·화질 유지
- 실제 디코딩 FPS, 수신 비트레이트, 디코딩 시간, 누적 프레임 표시
- 연결 실패, 잘못된 주소, 시간 초과, 브라우저 지원 여부 안내
- 키프레임을 이용한 디코딩 대기열 복구와 연결당 RTSP 자원 해제
- 동시 스트림 최대 4개

해상도·FPS·비트레이트를 변경하려면 카메라에서 설정하세요. 현재 원본 전송 경로는 H.264를 지원하며, H.265 등 다른 코덱은 명시적인 오류로 안내합니다. 브라우저가 해당 카메라의 H.264 프로필을 지원하는지 연결 시 확인합니다. **디코딩 지연**은 브라우저의 패킷 수신부터 디코더 출력까지의 시간이며 카메라부터의 전체 지연은 포함하지 않습니다.

## 파일

```text
main.py             가상환경·패키지 자동 준비 및 서버 실행 진입점
requirements.txt    서버 실행 패키지 (FastAPI, Uvicorn, PyAV)
requirements-dev.txt 테스트 및 브라우저 자동화 패키지
server/main.py      FastAPI 서버, 설정 검증, WebSocket 전송
server/video.py     RTSP demux, SPS/PPS 처리, 원본 H.264 NAL 전송
static/index.html   클라이언트 페이지
static/app.js       WebSocket 수신, VideoDecoder, Canvas, 지표
static/style.css    반응형 스타일
tests/test_stream.py 서버·프로토콜·NAL 바이트 보존·H.264 디코딩 테스트
```

## WebSocket 프로토콜

`/ws/stream`에 연결한 뒤 10초 안에 시작 메시지를 보냅니다.

```json
{"type": "start", "rtspUrl": "rtsp://192.168.0.100:554/stream"}
```

서버는 먼저 `type: "config"`인 JSON 메시지로 실제 코덱 문자열(`avc1.PPCCLL`), 원본 크기, FPS, `mode: "passthrough"`, `format: "annexb"`를 전달합니다. 클라이언트는 `VideoDecoder.isConfigSupported()`로 지원 여부를 확인하고 디코더를 설정한 뒤 `{"type":"ready"}`를 보냅니다. 서버는 이 확인을 받은 뒤에만 바이너리 영상을 전송합니다.

| 바이트 위치 | 내용 |
| --- | --- |
| 0 | 키프레임 여부: 1 = key, 0 = delta |
| 1–8 | 첫 IDR 기준 마이크로초 PTS, int64, big-endian (B 프레임의 PTS 순서 유지) |
| 9 이후 | Annex B H.264 access unit (한 프레임을 구성하는 NAL 묶음) |

NAL의 압축된 슬라이스 바이트는 원본 그대로 유지합니다. RTP의 FU-A/STAP-A 등 재조립은 FFmpeg RTSP demuxer가 처리합니다. AVCC 입력은 NAL 길이 접두어만 Annex B 시작 코드로 바꾸며 재인코딩하지 않습니다. 첫 IDR까지 기다린 뒤 전송하고, 디코더 재시작을 위해 IDR마다 SPS/PPS를 붙입니다. `description` 없이 Annex B 형식으로 `VideoDecoder`를 설정합니다.

실패 시 `{"type":"error","message":"..."}`를 보내고 연결을 종료합니다. 클라이언트가 WebSocket을 닫으면 서버가 스트림 자원을 해제합니다. 정상 종료 대기 중인 RTSP 읽기는 제한 시간까지 걸릴 수 있습니다.

`GET /api/health`는 서버 상태를, `GET /api/config`는 지원 설정을 반환합니다.

## 검증

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

테스트는 외부 RTSP 카메라 없이 실행됩니다. 로컬 영상 파일로 RTSP 입력 경계를 대체하며, 전달 전후 슬라이스 NAL 바이트가 동일한지, H.264 디코딩, B 프레임, 패킷 헤더, SPS/PPS, WebSocket 준비 확인, 입력 검증, 오류 메시지의 인증 정보 노출 여부를 확인합니다.

## 배포된 서버의 실제 RTSP 브라우저 테스트

서버가 실행 중인 상태에서 공개 RTSP 또는 접근 가능한 카메라로 테스트할 수 있습니다.

```bash
RTSP_TEST_URL='rtsp://호스트:포트/경로' \
  python scripts/test_rtsp_browser.py \
  --base-url http://127.0.0.1:8000 \
  --seconds 15 \
  --output reports/rtsp-browser
```

시스템 Chromium 또는 Playwright Chromium이 필요합니다. 서버의 상태 확인 → RTSP 연결 → 첫 30프레임 수신 → 15초간 프레임 증가를 확인합니다. 결과 JSON과 브라우저 스크린샷을 저장하며, 재생하지 못하면 종료 코드 1을 반환합니다. 원격 서버는 `--base-url`에 해당 HTTPS 주소를 지정하세요. RTSP 주소는 **배포 서버가** 직접 접근할 수 있어야 합니다.

2026-11-05 공개 소스 시도의 실제 결과와 네트워크 제약은 [검증 보고서](reports/public-rtsp-2026-11-05/REPORT.md)에 기록했습니다.
