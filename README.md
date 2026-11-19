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

[http://localhost:3000](http://localhost:3000)에 접속해 카메라를 등록하고, 카메라 목록에서 재생할 카메라를 선택합니다. Node.js는 프런트 빌드와 프런트 테스트에 필요하며 실행 시에는 Python이 페이지와 API, WS를 모두 제공합니다.

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
| `SELECTIVE_BBOX_SOCKET` | bbox 브로커의 Unix 소켓 경로. 설정하면 가져온 카메라에서 bbox를 사용할 수 있습니다. 서버 실행 계정에 소켓 연결 및 `/dev/shm` 프레임 파일 읽기 권한이 필요합니다. Redis 접속 설정은 `SELECTIVE_MASTER_CONFIG`에서 읽습니다. |

WebCodecs 백엔드는 선별관제 WebSocket에 구독하고, 상태를 기준으로 카메라 목록을 갱신합니다. 시작·종료 알림 이후에는 상태 API로 재확인합니다. 대상 서버가 `running`이면 하위 설정까지 전부 읽은 뒤 한 트랜잭션으로 가져온 카메라를 갱신합니다. 대상 서버가 `ready`이면 가져온 카메라를 숨깁니다. 수동 등록 카메라와 기존 타일의 영상 재생은 유지됩니다. 이 연동은 카메라 목록을 동기화하며, bbox 수신은 별도 연동이 필요합니다.

- `backend/app.py`: FastAPI, RTSP 입력, 릴레이 워커 수명 관리, WS 프레임 송신, React 정적 호스팅
- `backend/relay_worker.py`: RTSP 디먹싱, 원본 PTS 및 프레임 지문 계산 (디코딩/인코딩 없음)
- `backend/bbox.py`: 스트림별 bbox 구독 공유, Redis 라이브 상태 갱신, 공유 메모리 프레임 지문 계산
- `backend/nal.py`: NAL 프레이밍, SPS/PPS 보존, Annex B 변환
- `frontend/src/main.jsx`: React UI, WS 연결, H.264 디코딩, 캔버스 출력
- `frontend/src/playout.js`: 표시할 프레임 선택, VideoFrame 정리, BBox 적용 시점 관리
- `frontend/src/style.css`: 반응형 UI
- `test/test_stream.py`: 프레임 형식, URL 검사, NAL 페이로드 보존, H.264 → WS 통합, 연결 해제 후 프로세스 정리
- `test/playout.test.mjs`: 표시 기한, 최신 프레임 선택, BBox 유지·비우기, 큐 제한과 출력 프레임 정리
- `GET /api/health`: 서버 상태와 테스트 영상용 FFmpeg 실행 파일 설치 여부
- `GET /api/metrics`: 현재 프로세스의 영상 소스·시청자 수, bbox 공유 및 시청자별 대기열 통계
- `WS /ws/stream`: 연결 후 JSON `{ "cameraId": 1, "bbox": true, "bboxRevision": 0 }`, `{ "url": "rtsp://…" }` 또는 `{ "demo": true }` 전송. 등록 카메라의 bbox는 같은 소켓에서 `{ "type": "bbox", "enabled": false, "bboxRevision": 1 }` 형식으로 켜거나 끕니다.

WS는 먼저 JSON `{ "type": "config", "codec": "avc1.42c01f" }` (실제 코덱 문자열은 원본 SPS에서 계산)를 보냅니다. 이후 각 바이너리 메시지는 `키프레임 여부 1바이트 + 타임스탬프 8바이트(int64 big-endian, 마이크로초) + Annex B access unit (하나 이상의 원본 NAL)`입니다. 오류는 `{ "type": "error", "message": "…" }`로 전달합니다.

BBox 업데이트는 같은 소켓의 `bbox` JSON 메시지로 전달합니다. 서버는 브로커가 지정한 공유 메모리 슬롯에서 `frame_id`를 확인하고, 해당 H.264 프레임이 RTSP 영상의 프레임과 일치할 때만 BBox에 `ptsUs`를 붙여 보냅니다. 브라우저는 bbox가 켜진 타일에서 100ms의 표시 대기 시간을 두고 해당 PTS에 도달한 영상에 새 박스를 적용합니다. 그 사이 표시할 영상이 생략되면 이미 도달한 PTS 중 가장 최신 결과를 적용합니다. 다음 결과가 적용될 때까지 이전 좌표를 유지하며, 빈 탐지 결과가 적용되면 박스를 지웁니다. 이미 표시한 PTS보다 늦게 도착한 결과는 건너뜁니다. `bboxRevision`으로 토글 전 결과를 건너뛰며, `bbox_error`가 와도 영상은 계속 재생합니다.

RTSP는 **H.264만 지원**하며 해상도, 프레임레이트, 비트레이트, 압축 영상 페이로드를 원본대로 유지합니다. RTP 패킷 자체를 전달하는 것이 아니라 디패킷화된 NAL들을 access unit(프레임)별로 묶습니다. AVCC 길이 접두사가 있는 입력은 Annex B 시작 코드로 바꾸고, IDR 앞에는 원본 SPS/PPS를 반복해 새 연결과 디코더 재설정을 지원합니다. 원본 PTS를 마이크로초 단위로 전달하며 브라우저에는 `description` 없이 Annex B 모드로 설정합니다. H.265/HEVC와 오디오는 현재 지원하지 않습니다. 카메라의 H.264 프로파일은 브라우저 디코더가 지원해야 합니다.

서버 프로세스 내에서 같은 RTSP 주소를 요청한 모든 타일과 브라우저는 디먹싱 워커와 카메라 연결 하나를 공유합니다. 등록 카메라와 직접 입력도 최종 주소가 같으면 연결을 공유합니다. 새 시청자는 코덱 설정을 받고 다음 IDR부터 재생하며 마지막 시청자가 나가면 워커를 정리합니다. 자동 재연결은 하지 않으며 UI에서 다시 연결할 수 있습니다. 테스트 영상만 FFmpeg로 H.264를 생성하고 동일한 NAL 중계 경로를 검증합니다.

## 다채널 재생과 지연 관리

- 시청자별 서버 전송 대기열은 **16개 메시지·영상 8MiB·가장 오래된 메시지 150ms**를 기준으로 관리합니다. 한도에 도달하거나 오래된 프레임이 남으면 해당 시청자의 밀린 프레임을 버립니다. WebSocket은 유지하고 코덱 설정을 다시 보낸 뒤 다음 IDR부터 재개합니다. 느린 시청자 때문에 다른 시청자의 대기열이 막히지 않습니다.
- 영상과 bbox는 하나의 송신 작업에서 처리합니다. 코덱 설정과 오류를 우선 전달하고, 영상 메시지를 최대 4개 연속 송신한 뒤 대기 중인 bbox에 송신 기회를 줍니다. bbox가 없으면 영상은 계속 전송합니다.
- bbox는 카메라 DB ID가 달라도 최종 선별관제 `stream_id`가 같으면 브로커 연결, Redis 라이브 상태 갱신, 공유 메모리 읽기 및 지문 계산을 공유합니다. 시청자별 대기 항목은 최신 결과 하나로 합쳐 느린 소비자가 다른 시청자를 막지 않게 합니다. 마지막 구독이 끝나면 소스를 정리하며, 정리 중 재구독은 완료를 기다려 소스가 겹치지 않게 합니다.
- RTSP 프레임의 지문은 디먹싱 워커에서 계산해 전달하므로 주 서버 이벤트 루프에서 영상 바이트를 반복해서 해시하지 않습니다. 브라우저에 전달하는 영상 형식과 원본 H.264 페이로드는 그대로입니다.
- 브라우저는 `requestAnimationFrame`마다 표시 시점이 지난 프레임 중 최신 하나만 그립니다. 대기 프레임은 최대 8개이며 새 프레임 수신 시 250ms 이상 지난 대기 프레임을 정리합니다. 표시하지 않은 `VideoFrame`은 즉시 닫습니다. bbox 오버레이는 좌표나 화면 크기가 바뀔 때 갱신합니다.
- 분할 수를 줄여 가려진 타일도 WebSocket과 디코딩을 유지합니다. 해당 타일은 출력 프레임을 즉시 닫고 캔버스 그리기를 생략합니다. 다시 보일 때 쌓인 영상을 재생하지 않습니다. 브라우저 디코더 대기가 10개를 넘으면 디코더를 재설정하고 다음 IDR부터 재개합니다.

공유 범위는 **Python 프로세스 하나**입니다. 카메라당 연결 하나를 유지하려면 운영 서버를 Uvicorn **단일 워커**로 실행합니다. 여러 워커나 서버를 쓰면 각 프로세스에서 별도 RTSP/bbox 연결을 생성합니다. 위 시간은 내부 대기열 관리 기준이며 카메라의 캡처 시점부터 화면 출력까지의 전체 지연을 보장하는 값은 아닙니다.

`/api/metrics`는 URL이나 인증정보 없이 `activeSources`, `activeViewers`, bbox의 `sources`·`subscribers`·`updates`·`matchedFrames`·`coalescedUpdates`, 시청자별 `videoSent`·`bboxSent`·`resyncs`·`framesDropped`·`queueFrames`·`queueBytes`·`oldestQueueMs`·`queueWaitMs`·`maxQueueWaitMs`·`pendingBbox`를 반환합니다. 카운터는 현재 살아 있는 소스/시청자의 값이며 연결 해제나 프로세스 재시작 후 누적 보관하지 않습니다.

타일의 React ref에는 `getStats()`가 있고, 브라우저 개발자 도구에서는 영상 캔버스의 `data-playback-stats`로 같은 통계를 확인할 수 있습니다. 활성 타일의 통계는 최대 초당 한 번 갱신합니다.

상단의 **정보 오버레이**를 켜면 재생 중인 타일에 수신·디코딩·출력 FPS, 영상 비트레이트, 해상도·코덱, 디코딩·표시 대기 수와 버린 프레임 수, 영상 PTS, 적용된 BBox PTS와 frame_id, 늦어서 버린 BBox 수를 표시합니다. 기본값은 꺼짐이며 선택은 브라우저에 저장됩니다. 켠 상태에서 화면에 보이는 재생 타일만 초당 한 번 갱신하고, 별도 WebSocket 연결은 만들지 않습니다. FPS와 비트레이트는 최근 표본 간 누적 카운터 차이로 계산합니다. 디코드 시간은 `decode()` 제출부터 출력 콜백까지의 최근 측정값으로, 대기와 B 프레임 재정렬 시간을 포함할 수 있습니다. 그리기 시간은 캔버스 출력 호출의 소요 시간입니다.

**영상−BBox**는 화면에 실제로 그린 영상 PTS에서 현재 적용된 BBox PTS를 뺀 값입니다. 다음 탐지 결과까지 좌표를 유지하는 동안 증가할 수 있으며, 카메라 촬영부터 브라우저 표시까지의 전체 지연이나 네트워크 지연을 의미하지 않습니다. 빈 탐지 결과도 적용된 결과의 PTS와 frame_id를 갱신합니다.

정보는 영상이 비쳐 보이는 반투명 배경에 표시합니다. 작은 타일에서는 글자 크기를 유지하고 FPS·디코드 시간·대기열·BBox 시차·ID를 요약해 보여 줍니다. 해상도·코덱·비트레이트와 개별 PTS 등 상세 정보는 넓은 타일에서 확인할 수 있습니다.

```js
[...document.querySelectorAll('canvas[data-playback-stats]')]
  .map(canvas => JSON.parse(canvas.dataset.playbackStats));
```

브라우저 통계에는 수신·디코딩·출력·생략 프레임 수, 숨김 타일에서 닫은 프레임 수, 최근 디코딩/그리기 시간, 표시 대기 시간, 디코딩/표시 대기 수, 오래된 bbox 수가 포함됩니다. 서버의 `oldestQueueMs`·`resyncs`, 브라우저의 `decodeQueueSize`·`droppedFrames`·`lateBbox`를 함께 비교하면 네트워크 송신, 디코딩, 화면 출력 중 지연이 쌓이는 구간을 구분할 수 있습니다.

239 서버는 `https://192.168.182.239:3000`으로 접속합니다. Nginx가 TLS를 처리하고 Python 단일 워커의 `127.0.0.1:3001`로 정적 파일·API·`/ws/stream`을 전달합니다. `deploy/239/`에 systemd 서비스, Nginx 설정, 설치 스크립트가 있습니다. `/home/omeye/webcodecs`에 빌드 결과·가상환경·`.env`를 준비한 뒤 `sudo sh deploy/239/install.sh`로 설치합니다. 인증서가 없으면 해당 IP의 자체 서명 인증서를 생성하며, 브라우저에서 인증서를 신뢰하도록 등록해야 합니다. 기존 `db.sqlite3`와 서버 전용 환경설정은 보존합니다. 서비스 계정은 선별관제 설정·bbox Unix 소켓·공유 메모리에 접근할 수 있어야 합니다.

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
