# 공개 RTSP 스트리밍 검증 — 2026-11-05

## 결과

현재 관리형 테스트 환경에서 FastAPI 서버를 기동하고 실제 Chromium으로 접속했습니다. HTTP와 WebSocket 연결은 정상이지만, 공개 RTSP 소스 연결이 실패하여 영상 재생 검증은 완료하지 못했습니다. 로컬 생성 영상이나 모의 입력으로 공개 스트림 테스트를 대체하지 않았습니다.

| 항목 | 결과 |
| --- | --- |
| 테스트 서버 | 현재 작업 환경의 `0.0.0.0:8000` |
| 서버 상태 API | HTTP 200, `status: ok`, `codec: h264` |
| 클라이언트 | 시스템 Chromium, WebCodecs 초기화 성공 |
| WebSocket 연결 | 성공 |
| 공개 RTSP 연결 | 실패 |
| 디코딩 프레임 | 0 |
| 브라우저 JavaScript 오류 | 없음 |
| 외부 접속용 배포 URL | 발급하지 않음. 현재 주소는 실행 환경 내부용 |

## 소스

[Wowza 공식 RTSP 테스트 페이지](https://www.wowza.com/developer/rtsp-stream-test)가 공개한 테스트 전용 반복 영상 주소를 사용했습니다. 주소는 2026-11-05에 공식 페이지에서 확인했으며, 소스의 실제 운영 상태는 이 환경의 네트워크 제약으로 검증하지 못했습니다.

```text
rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1
```

## 네트워크 진단

- 현재 환경은 HTTP 목적지가 제한된 관리형 클라우드이며 일반 인터넷 경로를 제공하지 않습니다.
- `/etc/codex/network-policy.json`의 `tcp_network_access.domains`와 `ip_ranges`가 모두 비어 있고 `vpn_configured`는 `false`입니다.
- 설정에 기재된 TCP CONNECT 프록시 `proxy:8088`에 대한 연결은 `ConnectionRefusedError`, errno 111로 실패했습니다.
- 서버의 RTSP 입력 객체로 공개 주소를 열었을 때 `OSError`, errno 5 (`Input/output error`)가 반환됐습니다.
- 따라서 공개 소스가 중단되었다고 단정할 수 없습니다. 확인된 문제는 이 실행 환경에 사용 가능한 외부 RTSP TCP 연결 경로가 없다는 점입니다.

인터넷 목적지로 일반 TCP 연결이 가능한 테스트 서버에서 같은 검증을 다시 실행해야 합니다. 현재 관리형 환경의 VPN 전용 TCP 경로에 공개 IP를 추가하는 것만으로 해결된다고 가정하면 안 됩니다.

## 재실행

저장소 루트에서 실행합니다. 스크립트는 소스를 직접 대체하지 않고 배포 서버의 실제 페이지를 조작합니다.

```bash
python scripts/test_rtsp_browser.py \
  --url rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1 \
  --base-url http://127.0.0.1:8000 \
  --output reports/public-rtsp-2026-11-05
```

- [기계 판독 결과](result.json): 실제 테스트 시각, 서버 상태, 프레임 수, 연결 로그
- [브라우저 화면](browser.png): RTSP 주소 입력 후 나타난 연결 오류
- [배포 소스 정보](deployment.json): 프로세스, 기동 명령, 소스 SHA-256
