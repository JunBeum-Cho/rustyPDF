# Electron 전환 결과 — 2026-10-21

Windows와 macOS를 대상으로 기존 Solid 화면을 유지하면서 실행 환경을 Electron으로 전환했다. 현재 개발·빌드·패키징 경로에는 Rust, Tauri, PDFium 설치나 Swift OCR 실행이 없다. 기존 미커밋 작업은 보존했으며 커밋·브랜치 전환·stash는 하지 않았다.

## 구조와 기능

- 화면 표시·텍스트 선택·검색·영역 캡처: PDF.js. 문서 수정·페이지 편집·저장·내보내기: Node worker의 pdf-lib. OCR: 번들에 포함된 Tesseract 영어·한국어 모델.
- Electron 메인 프로세스는 창·파일 대화상자·제한된 IPC를 담당한다. renderer는 sandbox/contextIsolation을 사용하고 Node 접근을 끈다. 외부 이동·새 창·webview를 차단한다.
- 일반 저장은 편집 가능한 주석 메타데이터를 보존한다. 내보내기는 측정된 텍스트 배치와 이미지·도형을 PDF에 합친다. 한국어 글꼴은 라이선스와 함께 번들로 제공한다.
- 기존 이미지→PDF 작업, 다중 탭, 페이지 복사·붙여넣기·회전·삭제, 검색, OCR, PNG 캡처, 최근 문서 및 OS 파일 열기 경로를 연결했다.

## 이전 검토 사항 반영

- 전체 페이지 선행 렌더링을 제거하고 화면 주변 페이지만 렌더링한다. 화면 밖 캔버스 메모리는 해제하며, 텍스트·주석 레이어와 썸네일도 지연 처리한다.
- 사용자 스크롤과 명시적 페이지 이동을 분리하고 탭별 위치를 복원한다. 뒤늦게 실행되는 다른 탭의 콜백은 무시한다.
- 비동기 이미지 드롭은 시작 시점의 문서를 대상으로 한다. 자동 저장과 수동 저장을 하나의 경로로 처리하고, 저장 도중 발생한 새 편집이 저장 완료로 잘못 표시되지 않게 했다.
- OCR 완료 상태는 페이지별로 관찰하고 결과는 배치로 기록한다. 문서 fingerprint가 맞지 않는 캐시와 과거의 검증 불가능한 캐시는 사용하지 않는다.
- 이동한 파일의 주석 복구와 동일 내용 복사본의 독립성을 검증한다. 외부 변경 감지, revision 확인, 원자적 교체 저장을 적용했다. HTML 정화는 유지했다.
- 파일 열기 이벤트를 구독한 뒤 초기 큐를 비우며, 창·탭 닫기에서 저장/저장 안 함/취소를 처리한다.
- 플랫폼별 네이티브 OCR 스크립트와 PDFium 바이너리 선택이 필요 없어졌다. 배포 시 중복 PDF.js·OCR 모델·코어 패키지는 제외한다.

## 실행한 검증

환경: macOS arm64. 시스템 Node 20 대신 격리된 Node 22로 지원 도구를 실행했다.

| 검증 | 실행 및 결과 |
|---|---|
| 전체 테스트 | `npx --yes --package=node@22 --call 'npm test'`: 37 통과, 실패·스킵 0, 2.17초 |
| 프로덕션 빌드 | `npx --yes --package=node@22 --call 'npm run build'`: renderer/Node 타입 검사, Vite, Electron 번들 성공. 마지막 측정 실제 경과 6.05초, Vite 2.67초 |
| 개발 형태 Electron 실행 | `node scripts/smoke-electron.mjs`: 종료 코드 0 |
| macOS arm64 패키징 | `npx --yes --package=node@22 --call 'electron-builder --mac --arm64 --dir'`: 성공 |
| 패키징한 macOS 앱 실행 | `node scripts/smoke-electron.mjs --packaged`: 종료 코드 0 |
| Windows x64·arm64 교차 패키징 | `npx --yes --package=node@22 --call 'electron-builder --win --x64 --arm64 --dir --config.win.signAndEditExecutable=false'`: 두 아키텍처 모두 성공 |
| 최종 네 아키텍처 패키징 | `npx --yes --package=node@22 --call 'electron-builder --mac --win --arm64 --x64 --dir --config.win.signAndEditExecutable=false'`: 성공. 최종 클립보드 회귀 검사 추가 후 생성 |
| 프로덕션 의존성 감사 | `npm audit --omit=dev --json`: 취약점 0 |

실제 Electron 실행 검증은 sandbox preload, PDF.js 816×1056 표시, 번들 영어·한국어 OCR 모델 로딩과 영어 문구 인식, 페이지 회전·저장, 한국어 굵게·기울임·밑줄 내보내기, PNG 클립보드 복사 후 크기·픽셀색 읽기 검증, 수동 스크롤 유지, 탭 전환 복원, 다음 페이지 이동 후 복원을 포함한다. 내보낸 PDF는 앱에서 다시 열어 화면도 확인했다. 자동 테스트는 한국어 각 글자의 실제 raster 출력과 텍스트 추출, 주석 저장/재열기·이동 복구·복사본 분리·외부 변경 거부·저장 경쟁·닫기 취소 등을 검증한다.

빌드 시간은 의존성과 리소스가 준비된 현재 작업 공간의 측정이다. 최초 설치·Electron 다운로드·배포물 압축 시간을 포함하지 않으며, 이전 Rust 빌드와 동일 조건의 비교 벤치마크는 아니다.

## 결과물과 실행

- macOS Apple Silicon 앱: `release/mac-arm64/RustyPDF.app`
- macOS Intel 앱: `release/mac/RustyPDF.app`
- Windows x64: `release/win-unpacked/RustyPDF.exe`
- Windows arm64: `release/win-arm64-unpacked/RustyPDF.exe`
- 패키징한 앱의 화면: [PDF 표시](electron-smoke.png), [한국어 내보내기](electron-export-smoke.png)

Node 22.13 이상에서 `npm ci`, `npm run dev`로 개발한다. `npm run build:mac`, `npm run build:windows`는 각 플랫폼의 arm64/x64 배포 대상을 제공한다. CI는 macOS·Windows에서 테스트·빌드·실제 Electron 실행·패키징한 앱 실행을 수행하도록 구성했다.

## 검증 범위와 남은 제약

Windows의 실행, Intel Mac 실행, CI의 원격 실행은 이 macOS arm64 환경에서 확인하지 않았다. Windows 교차 패키징은 실행 파일의 리소스 편집과 서명을 끈 상태로 검사했으며, 정식 Windows 설치 프로그램은 네이티브 CI에서 생성한다. 로컬 macOS 앱도 서명·공증하지 않았다.

Electron과 오프라인 OCR 리소스를 포함하므로 앱 용량은 작지 않다. 현재 macOS arm64 앱 디렉터리는 약 443 MiB이며, 불필요한 중복을 제외하기 전 약 541 MiB였다. 한국어 내보내기는 안정적인 Noto Sans KR 전체 글꼴 임베딩을 사용하므로 PDF 용량이 증가할 수 있고, 임의의 시스템 글꼴을 그대로 포함하는 방식은 아니다. OCR의 한국어 모델 로딩은 확인했지만 다양한 한국어 스캔 자료에 대한 인식률 평가는 수행하지 않았다. 이미지→PDF는 PNG/JPEG를 지원한다.

후속 정리 요청에 따라 `src-tauri/` 전체(소스·설정·PDFium 라이브러리·빌드 캐시), 과거 아이콘 생성기와 PDFium 설치 스크립트, Rust 작업 목록을 삭제했다. Electron에서 사용하는 아이콘은 `resources/icons/`에 있다. 이전 메타데이터를 이전할 수 있도록 과거 앱 데이터 디렉터리는 유지해야 한다.
