# RustyPDF 잠재 오류 및 버그 분석 보고서

작성일: 2026-09-09 · 대상 버전: 1.0.9 · 기준 커밋: `8ac3445bdb74fb1b5201196fc6d77345e0af264c`

> 후속 수정: 아래는 수정 전 분석 기록이다. F03·F04·F05 및 내보내기 품질 개선의 적용 내용과 검증 결과는 [후속 수정 보고서](2026-09-09-rustypdf-fixes.md)에 기록했다.

**현재 빌드와 Rust 테스트는 통과하지만, 실제 사용 중 기능 실패와 문서 간 주석 혼선을 일으키는 문제가 확인됐다.** 우선 처리할 문제는 macOS OCR 실행 실패, 이미지 드롭의 대상 문서 변경, 이동 복구 후 복사본의 주석 저장소 공유, 신뢰하지 않는 주석 HTML의 직접 삽입이다.

이번 분석은 코드 검토, 프런트엔드 빌드, Rust 테스트, 원본 함수를 이용한 격리 재현으로 진행했다. 앱 전체의 GUI 자동화나 Windows/Intel Mac 실기기 검증은 진행하지 않았다. 아래에서 실행 재현, 로직 재현, 정적 분석, 플랫폼 검증 필요를 구분한다. 제품 소스는 수정하지 않았으며 기존 작업 파일 `src/welcome/welcome.css`를 보존했다.

## 1. 검증 범위와 결과

| 항목 | 결과와 해석 |
|---|---|
| 환경 | macOS 26.5.1, Apple Silicon arm64, Node 20.20.0, Rust 1.95.0 |
| `npm run build` | 성공. TypeScript 검사와 Vite 프로덕션 번들 생성 통과 |
| `cargo test --locked` | 성공. 테스트 실행 40회, 실패 0회 |
| 테스트 중복 | `annotations.rs`의 한 함수에 `#[test]`가 중복돼 같은 테스트가 두 번 실행됨. 서로 다른 테스트 함수는 39개 |
| 프런트엔드 회귀 검사 | `package.json`에 프런트엔드 테스트 실행 스크립트가 없고, 이번에 발견한 비동기 탭 전환·스크롤 문제를 검증하는 테스트도 확인하지 못함 |
| 추가 재현 | 실제 macOS OCR 스크립트 실행, 실제 이미지 삽입 함수와 상태 저장소를 사용한 탭 전환, 실제 Rust 주석 저장소 함수로 이동·복사 순서 재현, 스크롤 계산 재현 |
| 제외한 검증 | Windows OCR 실행, Intel/Windows ARM 배포물 실행, 전체 GUI E2E, 대규모 메모리 부하 실측, 악성 HTML을 이용한 권한 악용 실험 |

기존 테스트에는 회전 좌표, 저장 트랜잭션, 외부 파일 변경 감지, 주석 지문 복구, 캐시 동작 등 유의미한 검증이 있다. 따라서 “저장 전반이 안전하지 않다”는 결론은 부적절하다. 확인된 문제는 특정 실행 경로와 조건에 한정된다.

우선순위는 P1을 기능 전체 실패·문서 데이터 혼선·보안 경계 문제, P2를 반복적인 사용 장애·성능 저하로 분류했다. 출하를 즉시 중단해야 할 P0 수준의 결함은 이번 범위에서 확정하지 않았다.

## 2. 주요 발견 사항

| ID | 우선순위 | 문제 | 확인 수준 |
|---|---|---|---|
| F01 | P1 | macOS OCR이 이미지 경로 대신 `--`를 읽고 실패 | 실행 재현 |
| F02 | P1 | 이미지 드롭 도중 탭 전환 시 다른 PDF에 이미지 삽입 | 원본 함수·상태 저장소 재현, I/O 대체 |
| F03 | P1 | 이동 복구 후 동일 PDF 복사본이 기존 문서의 주석 키를 공유 | 원본 Rust 함수 재현 |
| F04 | P1 | 주석 HTML을 정제 없이 앱 DOM에 삽입 | 입력→출력 경로 정적 확인, HTML 보존 확인 |
| F05 | P2 | 드롭 좌표의 물리 픽셀/CSS 픽셀 혼용 | 설치된 Tauri 타입과 코드 대조 |
| F06 | P2 | 수동 스크롤이 현재 페이지 갱신을 통해 강제 이동으로 되돌아옴 | 원본 스크롤 계산 재현, 반응 경로 정적 확인 |
| F07 | P2 | 탭 복귀 시 화면은 첫 페이지, 상태는 이전 페이지 | 정적 제어 흐름 확인 |
| F08 | P2 | 화면 밖 페이지의 캔버스 메모리가 계속 유지됨 | 구조 확인, 메모리 크기 산정 |
| F09 | P2 | OCR 한 페이지 완료마다 전체 페이지의 텍스트를 다시 요청 | 반응형 의존성·호출 경로 확인 |
| F10 | P2 | 앱 초기화 도중 OS에서 열린 PDF 이벤트를 놓칠 수 있음 | 이벤트 등록 순서 확인 |

### F01. macOS OCR의 Swift 인자 처리 오류

**영향:** 현재 호출 방식에서는 OCR 이미지 열기에 실패한다. 인식 엔진의 정확도 문제가 아니라, 엔진에 이미지가 전달되기 전에 중단되는 기능 오류다.

**근거:** [ocr.rs:289](/Users/jb/rustyPDF/src-tauri/src/pdf/ocr.rs:289)는 `CommandLine.arguments[1]`을 이미지 경로로 사용한다. 반면 [ocr.rs:337](/Users/jb/rustyPDF/src-tauri/src/pdf/ocr.rs:337)는 `xcrun swift - -- <image_path>`로 실행한다.

**재현 결과:** 현재 환경에서 Swift 인자는 `["-", "--", "실제 이미지 경로"]`였다. 소스에 내장된 Swift 스크립트를 그대로 추출하고 저장소의 정상 PNG를 입력했을 때 기존 인자 구성은 종료 코드 `2`, 출력 없음으로 실패했다. 동일 스크립트·동일 이미지에서 `--`만 제거한 대조 실행은 종료 코드 `0`이고 `PDF`라는 텍스트를 담은 JSON을 반환했다. 따라서 개발 도구 미설치나 이미지 손상과 구분되는 인자 처리 오류다.

**수정 방향:** 실행 인자와 스크립트의 경로 인덱스를 일치시키고, 실제 보조 프로세스를 실행하는 OCR smoke test를 추가한다. 페이지별 실패가 화면에 명확히 드러나는지도 함께 보완한다. 별도로 현재 구조는 사용자의 Mac에 `xcrun`과 Swift 개발 도구가 있어야 하므로, 일반 배포에서는 빌드된 네이티브 보조 실행 파일을 포함하는 방식을 검토할 필요가 있다.

### F02. 비동기 이미지 드롭의 대상 문서가 바뀜

**영향:** A 문서에 넣으려던 이미지가 B 문서에 저장될 수 있다. A의 페이지 번호와 좌표를 그대로 쓰므로 B에 해당 페이지가 없으면 추가한 이미지가 보이지 않는 상태까지 가능하다.

**근거:** [imageDrop.ts:81](/Users/jb/rustyPDF/src/viewer/imageDrop.ts:81)에서 시작 시점의 활성 탭과 페이지 정보를 잡지만, 파일 읽기와 이미지 크기 측정을 `await`한 뒤 [imageDrop.ts:148](/Users/jb/rustyPDF/src/viewer/imageDrop.ts:148)에서 `addAnnotation()`을 호출한다. [store.ts:373](/Users/jb/rustyPDF/src/annotations/store.ts:373)의 이 함수는 완료 시점의 **활성 탭**을 변경한다.

**재현:** 실제 `handleImageDrop`과 실제 상태 저장소를 사용하되 파일 읽기를 지연시키고 이미지/DOM 부분만 대체했다. A에서 드롭을 시작하고 B로 전환한 뒤 읽기를 완료하면 결과는 `A: 주석 0개, B: 주석 1개`였다. 전체 GUI 재현은 아니지만 문서 선택 오류를 만드는 비동기 경로는 실제 함수로 확인했다.

**수정 방향:** 작업 시작 시 `tabId`, 문서 revision, 대상 페이지를 보관하고 해당 탭에만 추가한다. 처리 중 문서가 닫혔거나 페이지 구성이 바뀌었다면 작업을 취소하거나 유효성을 다시 확인한다. 탭 전환·탭 닫기·페이지 삭제를 포함한 회귀 검사가 필요하다.

### F03. 이동 복구 뒤 동일 복사본에 주석이 잘못 연결됨

**영향:** 별도 문서로 취급해야 할 두 PDF가 같은 주석 키와 영구 저장 레코드를 공유할 수 있다. 이후 저장·재열기 과정에서 상대 문서의 주석을 보거나 덮어쓸 위험이 있다.

**근거:** [annotation_store.rs:265](/Users/jb/rustyPDF/src-tauri/src/annotation_store.rs:265)는 기존 `sourcePath`가 사라진 동일 지문 후보를 이동된 문서로 판단한다. 복구 시 새 경로의 alias는 쓰지만 [annotation_store.rs:274](/Users/jb/rustyPDF/src-tauri/src/annotation_store.rs:274), 원본 영구 레코드의 `sourcePath`는 갱신하지 않는다.

**재현 순서:**

1. A.pdf에 주석을 저장한다.
2. A.pdf를 B.pdf로 이름 변경하고 B를 열어 주석을 복구한다.
3. 복구된 B를 다시 저장하기 전에 B.pdf를 C.pdf로 복사한다. B는 여전히 존재한다.
4. C.pdf를 열면 영구 레코드에 남은 A의 경로가 없다는 이유로 다시 이동 복구가 일어난다.

원본 Rust 저장소 함수를 임시 테스트 패키지에 포함해 실행한 결과는 `moved=recovered, identical-copy=recovered, same-key=true, original-still-exists=true`였다. 이번 실행에서 직접 확인한 것은 잘못된 복구와 키 공유이며, 이후 덮어쓰기는 동일 저장 주소를 사용하는 구조에서 도출되는 위험이다.

**수정 방향:** 복구 성공 시 영구 레코드의 소유 경로와 alias를 일관되게 갱신하고, 이미 살아 있는 문서와 연결된 키를 새 복사본에 재사용하지 않도록 한다. 기존의 단순 동일 파일 복사 테스트에 더해 “이동→열기→복사→열기” 순서를 검증해야 한다.

### F04. 외부 주석 HTML을 그대로 실행 가능한 DOM에 전달

**영향:** 신뢰하지 않는 주석 파일에 이벤트 속성 등이 포함되면 앱 WebView에서 의도하지 않은 스크립트가 실행될 수 있다. 일반 PDF만 열었을 때의 취약점으로 입증한 것은 아니며, 공격자가 주석 sidecar를 제공하거나 수정할 수 있다는 조건이 필요하다.

**근거:**

- [annotation_store.rs:296](/Users/jb/rustyPDF/src-tauri/src/annotation_store.rs:296)는 기존 형식의 PDF 인접 `.notes.json`도 불러온다.
- [pdf.ts:219](/Users/jb/rustyPDF/src/ipc/pdf.ts:219)는 로드한 주석 배열을 런타임 스키마 검증이나 HTML 정제 없이 상태에 넣는다. JSON 복제는 HTML 정제가 아니다.
- [textLayout.ts:12](/Users/jb/rustyPDF/src/annotations/textLayout.ts:12)는 `payload.html`을 그대로 반환한다. 텍스트 fallback에만 escape 처리가 있다.
- [AnnotationLayer.tsx:1102](/Users/jb/rustyPDF/src/annotations/AnnotationLayer.tsx:1102)와 [AnnotationLayer.tsx:1129](/Users/jb/rustyPDF/src/annotations/AnnotationLayer.tsx:1129)는 이를 `innerHTML`에 넣는다.
- [tauri.conf.json:24](/Users/jb/rustyPDF/src-tauri/tauri.conf.json:24)의 CSP는 `null`이다.

**검증 수준:** 이벤트 속성을 포함한 무해한 검사 문자열이 `annotationHtml()`을 변경 없이 통과하는 것을 확인했다. 실제 WebView에서 공격 스크립트 실행이나 Tauri 권한 악용까지 실험하지 않았으므로 OS 명령 실행·정보 유출이 검증됐다는 의미는 아니다. 다만 외부 저장 데이터가 앱의 HTML 실행 영역으로 들어가는 경계는 확인됐다.

**수정 방향:** 허용할 서식 태그·스타일·속성만 남기는 검증된 HTML sanitizer를 적용한다. 이벤트 속성, 실행 가능한 URL, 불필요한 외부 리소스·임베딩 요소를 차단하고, 주석 스키마 및 데이터 URL도 검증한다. CSP는 추가 방어로 설정한다. 저장 파일의 내용 지문 일치는 신뢰성 검증을 대신하지 않는다.

### F05. 고해상도 화면에서 이미지 드롭 좌표가 어긋남

**영향:** Retina 또는 배율이 적용된 화면에서 커서와 다른 위치·페이지에 이미지가 들어가거나, 페이지를 찾지 못해 아무 일도 일어나지 않을 수 있다.

**근거:** [opening.ts:53](/Users/jb/rustyPDF/src/ipc/opening.ts:53)는 Tauri 드롭 이벤트의 좌표를 그대로 넘긴다. 설치된 `@tauri-apps/api/webview.d.ts`의 드롭 위치 타입은 `PhysicalPosition`이다. 반면 [imageDrop.ts:51](/Users/jb/rustyPDF/src/viewer/imageDrop.ts:51)의 `elementsFromPoint()`와 `getBoundingClientRect()`는 CSS 픽셀을 사용한다.

**예시:** 화면 배율이 2라면 CSS 좌표 `(400, 300)`에 대응하는 물리 좌표 `(800, 600)`이 CSS 좌표로 해석될 수 있다. 이번 분석에서는 실제 UI 드롭 위치를 실측하지 않았으며, 타입과 소비 API의 좌표 단위 불일치를 확인했다.

**수정 방향:** 해당 WebView의 배율로 물리 좌표를 논리 좌표로 변환한 뒤 hit test를 수행한다. 배율 1·1.5·2와 모니터 간 이동을 검증한다.

### F06. 자연스러운 스크롤 중 다음 페이지 상단으로 튐

**영향:** 트랙패드나 마우스로 조금씩 읽을 때 화면이 페이지 상단으로 갑자기 이동할 수 있다.

**근거:** [PdfViewer.tsx:36](/Users/jb/rustyPDF/src/viewer/PdfViewer.tsx:36)의 스크롤 관찰이 `currentPage`를 갱신한다. [PdfViewer.tsx:174](/Users/jb/rustyPDF/src/viewer/PdfViewer.tsx:174)는 그 변경을 페이지 이동 요청으로 취급해 `scrollToPage()`를 예약한다. `suppressNextScroll`은 강제 이동에서 발생한 후속 이벤트를 막지만, 수동 스크롤에서 강제 이동으로 이어지는 첫 연결은 막지 않는다.

**로직 재현:** 원본 `onScroll` 계산에 페이지 높이 842, 간격 16, 뷰포트 높이 800, `scrollTop=500`, 현재 페이지 0을 입력하면 현재 페이지가 1로 바뀐다. 이어지는 페이지 이동의 목표는 858이므로 사용자가 놓은 위치보다 358픽셀 앞으로 이동한다. 이는 계산·제어 흐름 재현이며 실제 WebView의 스크롤 체감을 측정한 결과는 아니다.

**수정 방향:** “현재 보이는 페이지 관찰값”과 “툴바·검색·썸네일에서 요청한 이동”을 분리한다. 관찰값 변경만으로 프로그램 스크롤을 실행하지 않도록 한다.

### F07. 탭으로 돌아왔을 때 화면과 페이지 상태가 불일치

**영향:** A의 10페이지를 보다가 B를 열고 A로 돌아오면 화면은 처음으로 이동하지만, 페이지 표시와 페이지 기반 동작은 여전히 10페이지를 기준으로 처리될 수 있다.

**근거:** [PdfViewer.tsx:62](/Users/jb/rustyPDF/src/viewer/PdfViewer.tsx:62)는 탭 변경 시 `scrollTop=0`으로 이동하고 다음 스크롤 이벤트를 억제한다. 하지만 `currentPage`를 0으로 바꾸지 않는다. 별도의 페이지 추적 로직도 [PdfViewer.tsx:177](/Users/jb/rustyPDF/src/viewer/PdfViewer.tsx:177)에서 탭 변경이면 이전 페이지 번호만 기록하고 반환하므로 화면을 해당 페이지로 복원하지 않는다.

**수정 방향:** 탭별 스크롤 위치를 보존·복원하거나, 최소한 저장된 `currentPage`로 이동해 화면과 상태를 맞춘다. F06과 함께 이동 상태 모델을 정리하는 편이 좋다.

### F08. 페이지가 많을수록 캔버스 메모리가 누적

**영향:** 고배율로 긴 문서를 훑으면 메모리가 크게 증가해 앱 반응 저하나 WebView 종료로 이어질 수 있다. 실제 메모리 부족 종료를 유발하는 부하 실험은 하지 않았다.

**근거:** [PdfViewer.tsx:196](/Users/jb/rustyPDF/src/viewer/PdfViewer.tsx:196)는 모든 페이지의 `PageCanvas`를 마운트한다. [PageCanvas.tsx:82](/Users/jb/rustyPDF/src/viewer/PageCanvas.tsx:82)의 가시성 검사는 새 렌더링을 지연하지만, 이미 그린 캔버스의 backing store를 비우거나 먼 페이지를 제거하지 않는다. Rust 렌더 캐시의 상한은 프런트엔드 캔버스 메모리까지 제한하지 못한다.

**크기 산정:** 595×842pt 페이지를 400% 배율에서 현재 렌더 스케일로 계산하면 약 3173×4490px이고, RGBA 버퍼만 약 54.3MiB다. 같은 크기의 페이지 100개를 그려 유지하면 단순 합산 약 5.3GiB다. 이는 버퍼 크기 산정이며 실제 프로세스 RSS 측정값은 아니다. 브라우저의 메모리 회수·복사 정책에 따라 달라진다.

**수정 방향:** 현재 화면 주변 페이지만 실제 캔버스를 유지하고 나머지는 크기 placeholder로 대체한다. 또는 멀어진 페이지의 캔버스를 비우고 재진입 시 다시 그린다. 선행 렌더링 예산도 PDF 파일 크기만이 아니라 페이지 수·출력 픽셀·예상 메모리를 기준으로 제한한다.

### F09. OCR 진행에 따라 전체 페이지 텍스트 요청이 반복됨

**영향:** 페이지 수가 많은 스캔 문서에서 OCR이 진행될수록 IPC 요청과 PDF 텍스트 추출이 과도하게 발생해 지연과 자원 사용을 키운다. F01을 고쳐 OCR이 정상 완료되기 시작하면 이 경로가 더 잘 드러날 수 있다.

**근거:** 각 페이지의 [TextLayer.tsx:75](/Users/jb/rustyPDF/src/ocr/TextLayer.tsx:75)는 자기 페이지의 완료 여부 대신 문서 전체 `done.size`를 구독한다. [ocr.ts:143](/Users/jb/rustyPDF/src/ocr/ocr.ts:143)가 어느 한 페이지의 완료를 반영할 때마다 모든 마운트된 페이지가 `pdfNativeTextLines()`를 다시 호출한다. 네이티브 텍스트가 없고 응답이 아직 유효하면 OCR 텍스트 요청도 이어진다. [text.rs:124](/Users/jb/rustyPDF/src-tauri/src/pdf/text.rs:124)의 네이티브 추출은 문서 잠금과 Pdfium 문서 로딩을 수행한다.

N개 페이지가 마운트된 상태에서 N번 완료 갱신이 일어나면 네이티브 텍스트 요청은 대략 N²로 늘어날 수 있다. 500페이지라면 초기 요청을 제외해도 약 25만 회 규모가 되는 구조다. 응답 순번 검사는 오래된 결과의 화면 반영을 막지만 이미 보낸 요청을 취소하지 않는다. 이 수치는 구조상 산정이며 실제 500페이지 실행을 계측한 결과는 아니다.

**수정 방향:** 페이지별 완료 상태·버전을 독립적으로 구독하고, 화면에 필요한 페이지에 대해서만 텍스트를 가져온다. 문서 revision과 페이지를 키로 네이티브 텍스트를 캐시하고, 중복 요청을 병합한다. 단순히 매번 `done.has(pageIndex)`를 반환하는 새 배열로 바꾸는 것만으로는 반응 재실행이 남을 수 있으므로 페이지별 memo/signal의 변경 억제까지 확인한다.

### F10. 시작 중 파일 열기 이벤트를 놓치는 구간

**영향:** 앱에서 첫 PDF를 여는 동안 Finder에서 두 번째 PDF를 더블클릭하면 두 번째 문서가 탭으로 열리지 않을 수 있다.

**근거:** [opening.ts:37](/Users/jb/rustyPDF/src/ipc/opening.ts:37)는 시작 큐를 먼저 읽고 문서 열기를 기다린 후 [opening.ts:63](/Users/jb/rustyPDF/src/ipc/opening.ts:63)에서 `open-pdfs` 이벤트를 구독한다. 백엔드의 [lib.rs:1051](/Users/jb/rustyPDF/src-tauri/src/lib.rs:1051)는 OS 열기 요청을 큐에 넣고 이벤트를 보낸다. 시작 큐를 비운 뒤 구독 전 사이에 들어온 요청은 이벤트 수신자가 없고, 남은 큐를 이후 다시 읽는 경로도 초기화 코드에 없다.

**수정 방향:** 이벤트 구독을 먼저 완료하고 초기 큐를 수집하되, 두 경로에서 같은 요청이 오는 경우 중복을 제거한다. 또는 백엔드 큐에 수신 확인과 재배달을 도입한다. 느린 첫 문서를 열면서 두 번째 OS 열기 이벤트를 발생시키는 검사가 필요하다.

## 3. 플랫폼 검증이 추가로 필요한 위험

다음 두 항목은 코드상 위험 근거가 있지만 대상 플랫폼 실행으로 확인하지 않았다. 위의 macOS 실행 재현 결과와 같은 확정 수준으로 취급하면 안 된다.

**R01 · P1 후보 — Windows OCR의 WinRT 비동기 처리 미완성**

[ocr.rs:405](/Users/jb/rustyPDF/src-tauri/src/pdf/ocr.rs:405)의 PowerShell `Await`는 `AsTask` 메서드를 검색해 `$asTask`에 넣고 사용하지 않는다. 대신 WinRT 비동기 객체에 `$task.GetAwaiter().GetResult()`를 직접 호출하며, 전달받는 `$type`도 사용하지 않는다. WinRT 연산을 .NET Task로 바꾸는 단계가 빠져 있어 첫 비동기 작업부터 실패할 가능성이 높다. WinRT와 .NET의 비동기 연결에서 `AsTask`·확장 메서드가 수행하는 역할은 [Microsoft의 공식 설명](https://devblogs.microsoft.com/dotnet/asynchronous-programming-for-windows-store-apps-net-is-up-to-the-task/)과 대조했다. 문서 대조는 해당 PowerShell 스크립트의 실제 실행 검증을 대신하지 않는다.

Windows에서 StorageFile 열기부터 인식 결과 반환까지 실행하고, 필요한 어셈블리 로딩 및 실제 반환 타입에 맞는 Task 변환을 확인해야 한다. 네이티브 WinRT 호출로 대체하는 방법도 있다. 한글 결과, 결과 0개·1개·여러 개, 실패 시 오류 전달을 포함해 검증하는 것이 좋다.

**R02 · 대상에 따라 P1 — 배포 대상과 Pdfium 바이너리 아키텍처 불일치**

[package.json:14](/Users/jb/rustyPDF/package.json:14)에는 macOS universal/Intel과 Windows ARM 빌드 명령이 있다. 하지만 [setup-pdfium.mjs:49](/Users/jb/rustyPDF/scripts/setup-pdfium.mjs:49)는 빌드 대상이 아니라 실행 중인 Node의 OS/CPU로 라이브러리를 선택하고, 기존 파일이 있으면 아키텍처 확인 없이 건너뛴다. Tauri는 해당 `lib` 리소스를 번들에 포함한다.

현재 작업 공간에서 `file` 명령으로 확인한 `libpdfium.dylib`는 arm64 단일 바이너리이고 `pdfium.dll`은 x86-64다. 이 리소스를 그대로 넣으면 Intel용 macOS 프로세스 및 ARM 네이티브 Windows 프로세스와 맞지 않는다. Rust 앱을 universal로 빌드하는 것만으로 별도 dylib가 universal이 되지는 않는다. 실제 Intel/Windows ARM 실행 결과는 확인하지 않았다.

빌드 타깃별 라이브러리를 명시적으로 선택하고, macOS universal 배포는 의존 dylib도 필요한 아키텍처를 포함하도록 구성해야 한다. 해당 배포물을 열고 PDF 한 장을 렌더링하는 검증을 CI에 추가하는 것이 적절하다. 현재 macOS arm64/Windows x64 사용에서 동일한 불일치가 있다는 뜻은 아니다.

## 4. 버그와 구분할 지원 범위·품질 보완 사항

- **닫기 취소 선택지:** 저장/저장하지 않음 대화상자 경로에 사용자가 닫기 자체를 취소하는 선택지가 구현돼 있지 않다. 의도된 정책일 수도 있지만 문서 작업 앱에서는 실수 복구가 어려워지는 사용성 공백이다. 자동 저장된 주석까지 “저장하지 않음”으로 되돌리는지와는 별도 문제다.
- **암호 PDF:** PDF 로딩에 비밀번호를 전달하는 UI/IPC 경로를 확인하지 못했다. 비밀번호가 필요한 문서는 지원 범위로 명시하거나 입력 흐름을 추가해야 한다. 모든 암호화 PDF가 실패한다는 의미는 아니다.
- **Linux OCR:** Linux OCR은 미지원 경로인데 Linux 빌드 명령은 존재한다. 앱 빌드 가능 여부와 OCR 지원 여부를 구분해 안내할 필요가 있다.
- **테스트 중복:** [annotations.rs:1715](/Users/jb/rustyPDF/src-tauri/src/pdf/annotations.rs:1715)의 중복 테스트 속성을 제거하면 테스트 실행 수의 오해와 컴파일 경고를 줄일 수 있다. 이는 제품 런타임 버그와는 별도다.

## 5. 권장 수정 순서와 완료 기준

| 순서 | 대상 | 완료 기준 |
|---|---|---|
| 1 | F02·F03 문서 간 데이터 혼선 | 처리 중 탭 전환에도 원래 문서에만 삽입되고, 이동 복구 후 복사한 PDF가 독립된 주석 키를 사용 |
| 2 | F01 macOS OCR | 실제 배포와 같은 호출 방식으로 정상 이미지 인식 성공, 실패 시 UI에서 원인 확인 가능 |
| 3 | F04 주석 HTML | 허용 서식은 유지하면서 이벤트 속성·실행 URL 등은 저장소 입력과 렌더 경계에서 차단 |
| 4 | F05·F06·F07 좌표·탐색 | 여러 화면 배율에서 드롭 위치 일치, 수동 스크롤 점프 없음, 탭 복귀 시 위치와 페이지 번호 일치 |
| 5 | F08·F09 대용량 문서 | 페이지를 순회해도 캔버스 메모리가 설정 예산 안에 머물고 OCR 텍스트 요청이 페이지 수에 비례 |
| 6 | F10·R01·R02 플랫폼 통합 | 초기화 중 OS 열기 요청 누락 없음, Windows OCR 실제 성공, 지원 아키텍처별 PDF 렌더링 성공 |

F01~F04는 기능 신뢰성과 문서 분리에 직접 영향을 주므로 다음 배포 전 처리 대상으로 권한다. F08~F09는 작은 PDF 중심의 수동 검사로 놓치기 쉬우므로, 수정 시 메모리와 IPC 요청 수를 계측해야 한다.

## 6. 재현 증거 요약

아래 출력은 이번 분석의 격리 검증 결과를 요약한 것이다. 격리 검증을 위해 제품 소스를 수정하지 않았다.

```text
프런트엔드: npm run build → 성공
Rust: cargo test --locked → 40회 실행, 실패 0회

macOS 실제 OCR 스크립트 + 정상 PNG:
  xcrun swift - -- <png> → exit 2, 출력 없음
  xcrun swift - <png>    → exit 0, "PDF" 인식 결과 JSON

실제 이미지 드롭 함수 + 실제 상태 저장소, 파일 읽기/이미지/DOM 대체:
  A에서 시작 → B로 전환 → 비동기 읽기 완료
  [ { tab: 'A', annotations: 0 }, { tab: 'B', annotations: 1 } ]

실제 Rust 주석 저장소 함수, 임시 PDF 경로와 저장 루트 사용:
  moved=recovered, identical-copy=recovered,
  same-key=true, original-still-exists=true

원본 onScroll 계산:
  userScrollTop=500, newCurrentPage=1,
  subsequentScrollToPageTop=858, jumpPixels=358

현재 번들 리소스의 file 검사:
  libpdfium.dylib: Mach-O 64-bit dynamically linked shared library arm64
  pdfium.dll: PE32+ executable (DLL) x86-64, for MS Windows
```

이 보고서는 확인한 코드와 실행 경로의 결함 분석이며 모든 PDF 입력·운영체제·배포 조합에 대한 무결성 보증은 아니다. 특히 플랫폼 후보와 성능 산정은 명시한 후속 검증을 거쳐 확정해야 한다.
