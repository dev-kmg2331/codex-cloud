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

[http://localhost:3000](http://localhost:3000)에 접속해 카메라를 등록하고, 카메라 목록에서 재생할 카메라를 선택합니다. Node.js는 프런트 빌드에만 필요하며 실행 시에는 Python이 페이지와 API, WS를 모두 제공합니다.

**카메라 목록** 옆의 **+** 버튼으로 등록 창을 엽니다. 이름과 RTSP 주소를 입력해 한 대를 등록하거나, **일괄 등록**에서 한 줄마다 이름과 RTSP 주소를 쉼표 또는 탭으로 구분해 최대 100대를 등록할 수 있습니다. 등록 정보는 프로젝트의 `db.sqlite3`에 저장됩니다. 목록에서 원하는 타일로 끌어 놓으면 해당 타일에서 연결을 시작합니다. 목록에서 카메라를 클릭하면 선택한 타일에서 연결합니다. 4·9·16분할을 전환해도 타일별 연결은 유지됩니다.

재생 중인 타일 우측 상단의 **×**로 연결을 종료합니다. bbox를 사용할 수 있는 카메라는 같은 위치에서 개별적으로 켜고 끌 수 있습니다. 상단의 **전체 bbox**는 재생 중인 모든 지원 타일에 적용되고, 다음에 재생하는 카메라의 기본값도 설정합니다.

WebSocket 클라이언트가 직접 URL을 지정하지 않으면 서버의 `RTSP_URL`을 사용할 수 있습니다. `.env` 파일을 사용하는 경우 다음처럼 실행합니다(파일은 Git에서 제외됨).

```sh
.venv/bin/python -m uvicorn backend.app:app --env-file .env --host 0.0.0.0 --port 3000
```

브라우저 Chrome/Edge 최신 버전을 권장합니다. WebCodecs는 localhost 또는 HTTPS에서 사용할 수 있습니다. 외부 접속은 HTTPS 리버스 프록시를 사용하고 `/ws/stream`에 WebSocket 업그레이드를 전달해야 합니다. 카메라는 **백엔드에서** 접근 가능해야 합니다. Cloud 환경에서 사설망 카메라를 사용하려면 해당 네트워크로의 연결 경로가 필요합니다.

## 구성

239 서버에서 선별관제 카메라를 자동으로 가져오려면 다음 환경변수를 설정합니다.

| 환경변수 | 값 |
| --- | --- |
| `SELECTIVE_BASE_URL` | 선별관제 API 게이트웨이의 HTTP(S) 주소. 경로 없이 호스트와 포트를 지정합니다. |
| `SELECTIVE_SERVER_IP` | `SC_STATUS`의 `serverIp` 값. 239 서버가 해당 주소로 등록돼 있으면 `192.168.182.239`를 사용합니다. |
| `SELECTIVE_TOKEN_FILE` | WebSocket 구독에 사용할 액세스 토큰 파일 경로. 만료 시 파일을 갱신하면 다음 연결 시 읽습니다. 같은 서버의 루프백 주소에서 상태 API에 인증 없이 접근할 수 있으면 생략할 수 있습니다. |
| `SELECTIVE_MASTER_CONFIG` | 필요할 때만 지정합니다. 기본값은 `/usr/local/oms/omeye/omeye2/sc/tmp/config/master.json`입니다. |

WebCodecs 백엔드는 선별관제 WebSocket에 구독하고, 상태를 기준으로 카메라 목록을 갱신합니다. 시작·종료 알림 이후에는 상태 API로 재확인합니다. 대상 서버가 `running`이면 하위 설정까지 전부 읽은 뒤 한 트랜잭션으로 가져온 카메라를 갱신합니다. 대상 서버가 `ready`이면 가져온 카메라를 숨깁니다. 수동 등록 카메라와 기존 타일의 영상 재생은 유지됩니다. 이 연동은 카메라 목록을 동기화하며, bbox 수신은 별도 연동이 필요합니다.

- `backend/app.py`: FastAPI, RTSP 입력, 릴레이 워커 수명 관리, WS 프레임 송신, React 정적 호스팅
- `backend/relay_worker.py`: RTSP 디먹싱 및 원본 PTS 전달 (디코딩/인코딩 없음)
- `backend/nal.py`: NAL 프레이밍, SPS/PPS 보존, Annex B 변환
- `frontend/src/main.jsx`: React UI, WS 연결, H.264 디코딩, 캔버스 출력
- `frontend/src/style.css`: 반응형 UI
- `test/test_stream.py`: 프레임 형식, URL 검사, NAL 페이로드 보존, H.264 → WS 통합, 연결 해제 후 프로세스 정리
- `GET /api/health`: 서버 상태와 테스트 영상용 FFmpeg 실행 파일 설치 여부
- `WS /ws/stream`: 연결 후 JSON `{ "cameraId": 1, "bbox": true, "bboxRevision": 0 }`, `{ "url": "rtsp://…" }` 또는 `{ "demo": true }` 전송. 등록 카메라의 bbox는 같은 소켓에서 `{ "type": "bbox", "enabled": false, "bboxRevision": 1 }` 형식으로 켜거나 끕니다.

WS는 먼저 JSON `{ "type": "config", "codec": "avc1.42c01f" }` (실제 코덱 문자열은 원본 SPS에서 계산)를 보냅니다. 이후 각 바이너리 메시지는 `키프레임 여부 1바이트 + 타임스탬프 8바이트(int64 big-endian, 마이크로초) + Annex B access unit (하나 이상의 원본 NAL)`입니다. 오류는 `{ "type": "error", "message": "…" }`로 전달합니다.

BBox 업데이트는 같은 소켓의 `bbox` JSON 메시지로 전달합니다. 서버는 브로커가 지정한 공유 메모리 슬롯에서 `frame_id`를 확인하고, 해당 H.264 프레임이 RTSP 영상의 프레임과 일치할 때만 BBox에 `ptsUs`를 붙여 보냅니다. 영상 전송을 우선하며, 브라우저는 BBox가 켜진 타일에서 최대 100ms의 표시 지연을 두고 같은 PTS의 영상과 박스를 함께 그립니다. 대응하는 BBox가 시한 안에 없으면 영상만 표시합니다. `bboxRevision`으로 토글 전 결과를 건너뛰며, `bbox_error`가 와도 영상은 계속 재생합니다.

RTSP는 **H.264만 지원**하며 해상도, 프레임레이트, 비트레이트, 압축 영상 페이로드를 원본대로 유지합니다. RTP 패킷 자체를 전달하는 것이 아니라 디패킷화된 NAL들을 access unit(프레임)별로 묶습니다. AVCC 길이 접두사가 있는 입력은 Annex B 시작 코드로 바꾸고, IDR 앞에는 원본 SPS/PPS를 반복해 새 연결과 디코더 재설정을 지원합니다. 원본 PTS를 마이크로초 단위로 전달하며 브라우저에는 `description` 없이 Annex B 모드로 설정합니다. H.265/HEVC와 오디오는 현재 지원하지 않습니다. 카메라의 H.264 프로파일은 브라우저 디코더가 지원해야 합니다.

서버 프로세스 내에서 같은 RTSP 주소를 요청한 모든 타일과 브라우저는 디먹싱 워커와 카메라 연결 하나를 공유합니다. 등록 카메라와 직접 입력도 최종 주소가 같으면 연결을 공유합니다. 새 시청자는 코덱 설정을 받고 다음 IDR부터 재생하며 마지막 시청자가 나가면 워커를 정리합니다. 시청자별 전송 큐가 가득 차면 대기 중인 프레임을 버리고, 같은 WebSocket으로 코덱 설정을 다시 보낸 뒤 다음 IDR부터 전송을 재개합니다. 브라우저 디코딩이 밀려도 다음 IDR부터 재개합니다. 자동 재연결은 하지 않으며 UI에서 다시 연결할 수 있습니다. 테스트 영상만 FFmpeg로 H.264를 생성하고 동일한 NAL 중계 경로를 검증합니다.

현재 인증이 없는 내부 개발용 서버입니다. RTSP 주소로 백엔드 네트워크에 접근할 수 있으므로 외부 공개 전 인증과 카메라 주소 허용 목록을 적용하세요. 카메라 등록 기능으로 제출한 URL은 SQLite에 저장되며 카메라 목록 API는 이름, ID, 지원되는 카메라의 bbox 사용 가능 여부를 반환합니다. WebSocket에서 직접 지정한 URL은 저장하지 않습니다. URL은 워커 표준입력으로 전달합니다.

## 개발 및 검증

화면을 추가하거나 수정할 때는 [프런트엔드 디자인 가이드](docs/frontend-design.md)를 참고합니다.

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
