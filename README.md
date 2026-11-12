# RTSP Live — Python + React + WebCodecs

Python/FastAPI 백엔드가 RTSP 카메라 영상을 PyAV로 디먹싱해 H.264 NAL 데이터를 재인코딩 없이 WebSocket으로 전달하고 React 빌드 파일을 함께 호스팅합니다. 브라우저는 WebCodecs `VideoDecoder`로 영상을 그립니다.

```text
RTSP 카메라 → PyAV (RTSP/TCP 디먹싱) → H.264 Annex B / WebSocket → React / WebCodecs
                                         └ HTTP: React 정적 파일
```

## 설치 및 실행

필수: Python 3.11+, Node.js 20.19+ 또는 22.12+, PyAV. 테스트 영상 생성에는 FFmpeg (`libx264` 인코더 포함)가 추가로 필요합니다. RTSP 중계에는 별도 FFmpeg 실행 파일이 필요 없습니다.

```sh
cd /workspace/codex-cloud
python -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npm run build
npm start
```

[http://localhost:3000](http://localhost:3000)에 접속해 RTSP 주소를 입력하고 **연결**을 누릅니다. 카메라가 없으면 **테스트 영상**으로 H.264 소스 → PyAV → WS → WebCodecs 전체 경로를 확인합니다. Node.js는 프런트 빌드에만 필요하며 실행 시에는 Python이 페이지와 API, WS를 모두 제공합니다.

카메라 주소를 서버 환경변수 `RTSP_URL`로 설정하면 UI 주소 칸을 비워두고 연결할 수 있습니다. `.env` 파일을 사용하는 경우 다음처럼 실행합니다(파일은 Git에서 제외됨).

```sh
.venv/bin/python -m uvicorn backend.app:app --env-file .env --host 0.0.0.0 --port 3000
```

브라우저 Chrome/Edge 최신 버전을 권장합니다. WebCodecs는 localhost 또는 HTTPS에서 사용할 수 있습니다. 외부 접속은 HTTPS 리버스 프록시를 사용하고 `/ws/stream`에 WebSocket 업그레이드를 전달해야 합니다. 카메라는 **백엔드에서** 접근 가능해야 합니다. Cloud 환경에서 사설망 카메라를 사용하려면 해당 네트워크로의 연결 경로가 필요합니다.

## 구성

- `backend/app.py`: FastAPI, RTSP 입력, 릴레이 워커 수명 관리, WS 프레임 송신, React 정적 호스팅
- `backend/relay_worker.py`: RTSP 디먹싱 및 원본 PTS 전달 (디코딩/인코딩 없음)
- `backend/nal.py`: NAL 프레이밍, SPS/PPS 보존, Annex B 변환
- `frontend/src/main.jsx`: React UI, WS 연결, H.264 디코딩, 캔버스 출력
- `frontend/src/style.css`: 반응형 UI
- `test/test_stream.py`: 프레임 형식, URL 검사, NAL 페이로드 보존, H.264 → WS 통합, 연결 해제 후 프로세스 정리
- `GET /api/health`: 서버 상태와 테스트 영상용 FFmpeg 실행 파일 설치 여부
- `WS /ws/stream`: 연결 후 JSON `{ "url": "rtsp://…" }` 또는 `{ "demo": true }` 전송

WS는 먼저 JSON `{ "type": "config", "codec": "avc1.42c01f" }` (실제 코덱 문자열은 원본 SPS에서 계산)를 보냅니다. 이후 각 바이너리 메시지는 `키프레임 여부 1바이트 + 타임스탬프 8바이트(int64 big-endian, 마이크로초) + Annex B access unit (하나 이상의 원본 NAL)`입니다. 오류는 `{ "type": "error", "message": "…" }`로 전달합니다.

RTSP는 **H.264만 지원**하며 해상도, 프레임레이트, 비트레이트, 압축 영상 페이로드를 원본대로 유지합니다. RTP 패킷 자체를 전달하는 것이 아니라 디패킷화된 NAL들을 access unit(프레임)별로 묶습니다. AVCC 길이 접두사가 있는 입력은 Annex B 시작 코드로 바꾸고, IDR 앞에는 원본 SPS/PPS를 반복해 새 연결과 디코더 재설정을 지원합니다. 원본 PTS를 마이크로초 단위로 전달하며 브라우저에는 `description` 없이 Annex B 모드로 설정합니다. H.265/HEVC와 오디오는 현재 지원하지 않습니다. 카메라의 H.264 프로파일은 브라우저 디코더가 지원해야 합니다.

각 연결은 별도 디먹싱 워커를 사용합니다. 클라이언트 종료 시 워커와 테스트 영상 프로세스를 정리하고, 느린 WS 연결은 종료하며, 디코딩이 밀리면 다음 IDR부터 재개합니다. 자동 재연결은 하지 않으며 UI에서 다시 연결할 수 있습니다. 테스트 영상만 FFmpeg로 H.264를 생성하고 동일한 NAL 중계 경로를 검증합니다.

현재 인증이 없는 내부 개발용 서버입니다. RTSP 주소로 백엔드 네트워크에 접근할 수 있으므로 외부 공개 전 인증과 카메라 주소 허용 목록을 적용하세요. 입력 URL은 저장하거나 로그에 기록하지 않으며 워커 표준입력으로 전달합니다.

## 개발 및 검증

```sh
# Python 서버를 먼저 실행한 뒤, 다른 터미널에서 React 개발 서버 실행
npm run dev

# React 빌드 후 Python 테스트
npm run build
npm test
```

Vite 개발 서버는 `/api`와 `/ws`를 Python 3000 포트로 프록시합니다. 운영 실행에는 Vite 서버가 필요하지 않습니다. 테스트는 실제 FFmpeg 테스트 패턴을 사용하며 별도 카메라가 필요 없습니다. 실카메라의 주소/인증/네트워크 호환성은 해당 RTSP 주소로 별도 확인해야 합니다.


## Codex Cloud에서 접속

서버가 Codex Cloud에서 실행 중일 때 PC의 `localhost:3000`은 해당 Cloud 서버를 가리키지 않습니다. Codex 오른쪽 패널의 **새 탭(+) → Desktop**으로 공유 Desktop을 열 수 있는 경우, 그 안의 Chrome에서 `http://localhost:3000`으로 접속합니다. PC 브라우저에서 직접 접속하려면 별도의 포트 전달 경로를 설정하거나 소스를 PC에서 실행해야 합니다. 이 저장소는 공개 터널을 자동으로 생성하지 않습니다.
