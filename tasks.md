# rustpdf — 작업 진행 상황

가벼운 크로스 플랫폼(macOS / Windows) PDF 뷰어. Mac 미리보기 + 알집뷰어를 참고한 주석 기능 포함.

전체 설계는 `/Users/jb/.claude/plans/cuddly-conjuring-marble.md` 참고.

---

## 진행 요약

| # | 단계 | 상태 |
|---|---|---|
| 1 | Rust 툴체인 설치 (rustup) | 완료 |
| 2 | Tauri 프로젝트 스캐폴드 생성 | 완료 |
| 3 | PDF 렌더 코어 (Rust) | 완료 |
| 4 | 가상 스크롤 + LRU 비트맵 캐시 | 완료 |
| 5 | 이중 해상도 렌더 + 백프레셔 → raw RGBA로 재설계 | 완료 |
| 6 | 줌 / 회전 / 페이지 점프 / 다크모드 | 완료 |
| 7 | 텍스트 추출 + 검색 | 완료 |
| 8 | 썸네일 사이드바 | 완료 |
| 9 | 주석 레이어 골격 | 완료 |
| 10 | 주석 도구 구현 (텍스트박스 / 도형 / 펜 / 마크업) | 완료 |
| 11 | 선택·이동·리사이즈·삭제 + undo/redo | 완료 |
| 12 | sidecar 자동저장 + PDF flatten 내보내기 | 완료 |
| 13 | 드래그앤드롭 + OS 파일 연결 + 번들 | 완료 |

---

## 1. Rust 툴체인 설치 — 완료

**목적**: Tauri 백엔드 빌드 prerequisite.

**적용**:
- `rustup-init` 직접 다운로드 후 실행 (sandbox 환경에서 `mktemp`/Keychain 검증 회피, `RUSTUP_USE_CURL=1`).
- 설치된 버전: rustc 1.95.0 (stable, profile=minimal).
- 셸 PATH는 `--no-modify-path`로 설치되어 사용자가 `~/.zshrc`에 `. "$HOME/.cargo/env"` 추가.

---

## 2. Tauri 프로젝트 스캐폴드 — 완료

**목적**: Tauri 2.x + Solid + TypeScript + Vite 기반 프로젝트 구조.

**적용**:
- `create-tauri-app`이 sandbox에서 막혀 핵심 설정 파일을 직접 작성, 아이콘만 템플릿에서 복사.
- 프런트: Solid 1.9 + Vite 6 + TS 5.6, `@tauri-apps/api` 2.1.
- 백엔드: tauri 2, tauri-plugin-{dialog,fs}, pdfium-render 0.8(thread_safe), uuid, lru, parking_lot, tokio.
- 윈도우: 1280×860, dragDropEnabled.
- Capabilities: dialog/fs read·write 권한.

**핵심 파일**:
- `package.json`, `vite.config.ts`, `tsconfig.json`
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- `src/main.tsx`, `src/App.tsx`, `src/styles/global.css`

**부가**:
- `scripts/setup-pdfium.mjs`: bblanchon/pdfium-binaries에서 호스트별 동적 라이브러리 자동 다운로드(`src-tauri/lib/`).
- `npm run setup-pdfium` 으로 한 번 실행. macOS arm64는 이미 설치됨.

---

## 3. PDF 렌더 코어 (Rust) — 완료

**목적**: pdfium-render로 PDF 열기·페이지 메타·페이지 비트맵 추출 기능을 Tauri command로 노출.

**적용**:
- `src-tauri/src/pdf/mod.rs` — pdfium 라이브러리 로더. 환경변수 `RUSTPDF_PDFIUM_PATH` → 실행 파일 옆 → `src-tauri/lib/` → 시스템 lookup 순. 매 호출 새 인스턴스 생성(thread-safety 단순화).
- `pdf/document.rs` — 파일 바이트를 `Arc<Vec<u8>>`로 보관, 페이지 메타(폭/높이) 추출. `DocRegistry`(UUID → Arc<DocHandle>).
- `pdf/render.rs` — 페이지 → RGBA → 8바이트 헤더(W/H) + raw 픽셀 형식으로 인코딩. `PdfRenderConfig`에 target W/H + 회전.
- `lib.rs` — `pdf_open`, `pdf_close`, `pdf_render_page`, `pdf_search` 커맨드 등록.

**검증**: `cargo check` 통과. macOS arm64에서 런타임 동작 확인됨(사용자 확인 완료).

---

## 4. 가상 스크롤 + LRU 비트맵 캐시 — 완료

**목적**: 100MB PDF·페이지 수 많은 문서에서도 메모리·FPS 안정.

**적용**:
- `src-tauri/src/pdf/cache.rs` — 키 `(doc_id, page_index, scale_bucket, rotation)`, 256MB 바이트 budget LRU. 새 entry 삽입 시 budget 초과면 LRU 순으로 evict.
- `src/viewer/PdfViewer.tsx` — flex 컬럼 스택, `IntersectionObserver`로 visible 페이지 추적, scroll 위치 → currentPage 추정, currentPage 변경 시 해당 페이지로 자동 스크롤.
- `src/viewer/PageCanvas.tsx` — 페이지마다 별도 `<canvas>`. 가시(또는 viewport ±1200px)일 때만 invoke. cleanup에서 cancellation flag.
- 줌은 25% 단위 버킷팅으로 무의미한 재렌더 방지.

**메모**: prefetch margin은 후속 단계에서 400px → 1200px로 확대.

---

## 5. 이중 해상도 + 백프레셔 → raw RGBA로 재설계 — 완료

**원래 계획**: 첫 보임 시 0.5× 저해상도로 빠르게 → 180ms 후 풀 해상도 교체.

**문제(사용자 피드백)**: 흐린 단계가 너무 강하고 1초 가까이 보임. PNG 인코딩이 큰 페이지에서 100~200ms 비용.

**최종 적용**:
1. **저해상도 단계 완전 제거**. 캔버스에는 이전 비트맵이 남아 있어 CSS가 stretch — 새 RGBA 도착 즉시 sharp 교체. 더 이상 의도된 흐림 없음.
2. **PNG 인코딩 제거 → raw RGBA**. 8-byte 헤더(W/H BE) + RGBA. Tauri `Response::new`로 binary IPC. JS에서는 `ImageData` + `putImageData`.
3. **prefetch 마진 확대** (400 → 1200px). visible 직전 미리 렌더 시작.
4. **트랙패드 / 마우스 휠 줌·가로 이동**.
5. **작은 파일(≤30MB) 자동 전체 prerender**: 열자마자 background worker 3개가 currentPage부터 외곽으로 모든 페이지를 LRU에 채움. 큰 파일은 lazy.

**남은 후보 최적화** (미적용):
- 렌더 해상도를 device pixel ratio로 cap → zoom 4× 같은 극단 케이스 메모리 절약.
- 동일 키 in-flight dedupe(visible PageCanvas + prefetch worker가 같은 페이지 중복 호출 가능).
- JPEG 옵션 (lossy, 텍스트 sharpness 손해 있음).

---

## 6. 줌 / 회전 / 페이지 점프 / 다크모드 — 완료

**적용**:
- `src/keyboard.ts` — 단축키:
  - `Cmd/Ctrl + + / − / 0` 줌
  - `Cmd/Ctrl + O` 열기
  - `Cmd/Ctrl + F` 검색 토글
  - `← / → / PageUp / PageDown / Space` 페이지 이동
  - `Home / End` 처음·끝
  - `R / Shift+R` 회전
  - `T` 테마 토글
- `src/viewer/PdfViewer.tsx` — wheel 핸들러:
  - `Cmd/Ctrl + 휠` 또는 트랙패드 핀치 → 커서 위치 기준 줌(zoom-around-cursor: 변경 후 scroll 보정).
  - `Alt + 휠` → 가로 이동(`scrollLeft`).
- `src/state/ui.ts` — theme `auto/light/dark` localStorage 영속화. `applyTheme`이 `<html data-theme>` 속성 토글.
- `src/styles/global.css` — `data-theme="dark"` 또는 `prefers-color-scheme: dark` 매핑.
- 툴바에 테마 토글 버튼 (🌓 / 🌙 / ☀️).

---

## 7. 텍스트 추출 + 검색 — 완료

**적용**:
- `src-tauri/src/pdf/text.rs`:
  - 페이지별 텍스트를 doc_id 단위 캐시(첫 검색 시 전체 추출, 이후 캐시 hit).
  - `make_snippet`로 매치 전후 ±40문자 snippet, char-boundary 안전 슬라이스.
  - 1000개 매치 상한.
- `pdf_search` Tauri command.
- `src/search/SearchPanel.tsx`:
  - `Cmd+F`로 토글되는 우상단 패널.
  - 220ms 디바운스, 결과 리스트(클릭/Enter/↑↓로 점프), 매치 없음/오류 상태.
  - Esc로 닫기.

**한계**: 페이지 내 정확한 매치 위치 하이라이트는 미구현(PDFium의 char-level rect API 필요). 페이지 점프까지만.

---

## 8. 썸네일 사이드바 — 완료

**적용**:
- `src/viewer/Thumbnails.tsx` — 좌측 썸네일 사이드바. 각 페이지를 112px 폭의 작은 캔버스로 별도 렌더하고 `IntersectionObserver`로 화면 근처 썸네일만 실제 렌더.
- `src/viewer/PdfViewer.tsx` — `viewer-shell` 구조로 본문 스크롤 영역과 썸네일 영역 분리. 썸네일 클릭 시 해당 페이지로 점프하고 현재 페이지를 강조.
- `src/toolbar/Toolbar.tsx` — 문서가 열렸을 때 `썸네일` 토글 버튼 노출.
- `src/keyboard.ts` — `Cmd/Ctrl+\`로 사이드바 토글.

---

## 9. 주석 레이어 골격 — 완료

**적용**:
- `src/annotations/types.ts` — 텍스트, 사각형, 원, 직선, 화살표, 펜, 형광펜을 표현하는 공통 Annotation 모델.
- `src/annotations/store.ts` — Solid store 기반 주석 상태, 선택 상태, 도구 상태, 저장 상태, undo/redo history 관리.
- `src/annotations/coords.ts` — 페이지 좌표계와 화면 SVG 좌표계 변환. 줌·회전 상태를 반영해 주석이 PDF 비트맵과 함께 정렬됨.
- `src/annotations/AnnotationLayer.tsx` — 각 페이지 캔버스 위에 SVG 오버레이를 배치. PDF 재렌더 없이 주석만 독립적으로 갱신.
- `src/viewer/PageCanvas.tsx` — 페이지 비트맵과 주석 레이어를 같은 프레임에 합성.

---

## 10. 주석 도구 구현 — 완료

**적용**:
- `src/annotations/AnnotationToolbar.tsx` — 선택, 텍스트, 형광펜, 사각형, 원, 직선, 화살표, 펜 도구와 색상·두께·폰트 크기 컨트롤.
- 텍스트 박스: 클릭으로 생성, 더블클릭으로 내용 수정.
- 도형: 드래그로 사각형·원·직선·화살표 생성.
- 자유선 펜: pointer drag로 polyline 주석 생성.
- 마크업: 반투명 형광펜 영역 주석으로 구현. PDF 텍스트 selection 기반 밑줄/취소선은 현재 범위에서 제외하고, 페이지 좌표형 하이라이트로 대체.

---

## 11. 선택·이동·리사이즈·삭제 + undo/redo — 완료

**적용**:
- 선택 도구에서 주석 클릭 선택, 빈 영역 클릭 시 선택 해제.
- 선택된 주석 드래그 이동.
- rect 기반 주석(텍스트, 형광펜, 사각형, 원)은 네 모서리 핸들로 리사이즈.
- `Delete` / `Backspace`로 선택 주석 삭제.
- `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, `Cmd/Ctrl+Y`로 undo/redo.
- 이동·리사이즈 중에는 live update로 반응성을 유지하고 pointer up 시 history에 기록.

---

## 12. sidecar 자동저장 + PDF flatten 내보내기 — 완료

**sidecar (.json)**:
- `src/annotations/persistence.ts` — 변경 후 700ms 디바운스 자동저장.
- `src/ipc/pdf.ts` — PDF 열기 시 `<원본>.pdf.notes.json` 자동 로드, 닫거나 다른 문서를 열면 주석 상태 교체.
- `src-tauri/src/lib.rs` — `annotations_load`, `annotations_save` Tauri command. sidecar 경로는 원본 PDF 옆 `<파일명>.notes.json`.

**flatten 내보내기**:
- `src-tauri/src/pdf/annotations.rs` — pdfium page object API로 주석을 페이지 위에 실제 객체로 그려 넣은 뒤 PDF로 저장.
- 지원 타입: 텍스트, 사각형, 원, 직선, 화살표, 펜/polyline, 형광펜.
- `AnnotationToolbar`의 `내보내기` 버튼으로 저장 위치 선택 후 주석 포함 PDF 생성. 내보낸 PDF 옆에도 동일한 `.notes.json` sidecar를 함께 저장.

**한계**:
- flatten 텍스트는 PDFium 내장 Helvetica 기반이라 한글 등 일부 유니코드 글꼴은 PDF 뷰어별 표시 차이가 있을 수 있음. sidecar 원본 텍스트는 보존됨.

---

## 13. 드래그앤드롭 + OS 파일 연결 + 번들 — 완료

**적용**:
- `src/ipc/opening.ts` — 시작 시 OS가 넘긴 첫 PDF 경로를 자동 열기. 앱 창에 PDF를 드롭하면 첫 번째 PDF를 열기.
- `src-tauri/src/lib.rs` — `initial_open_path` command로 `argv[1]` PDF 경로 전달.
- `src-tauri/tauri.conf.json` — PDF file association(`application/pdf`) 등록, `lib/*` resources 포함, macOS bundle identifier를 `com.rustpdf.viewer`로 정리.
- Tauri 빌드 산출물:
  - `src-tauri/target/release/bundle/macos/rustpdf.app`
  - `src-tauri/target/release/bundle/dmg/rustpdf_0.1.0_aarch64.dmg`

---

## 부가 작업 (계획 외 처리)

- **트랙패드 / 휠 줌, alt-가로 이동** — 5단계에서 함께 처리.
- **흐림 단계 제거 + raw RGBA IPC** — 5단계 재설계.
- **작은 파일 자동 전체 prerender** — 5단계에 통합.
- **테마 토글 버튼 + localStorage 영속** — 6단계에 통합.
- **`scripts/setup-pdfium.mjs`** — 호스트별 pdfium 자동 설치 스크립트.

---

## 검증 가이드 (현재까지 구현분)

```bash
# 1. 의존성 + pdfium
npm install
npm run setup-pdfium

# 2. 셸에 cargo 추가
echo '. "$HOME/.cargo/env"' >> ~/.zshrc
source ~/.zshrc

# 3. dev 실행
npm run tauri dev
```

확인 포인트:
- 좌측 `썸네일` 토글 또는 `Cmd+\`로 썸네일 사이드바 열기/닫기, 썸네일 클릭으로 페이지 점프.
- 30MB 이하 PDF — 열자마자 모든 페이지가 캐시에 들어감, 스크롤·줌 모두 즉각.
- 100MB PDF — visible 페이지 ±1200px만 렌더, 메모리 안정.
- `Cmd + 휠` 줌, `Alt + 휠` 가로 이동.
- `Cmd+F` 검색, 한·영 모두 페이지 점프.
- `T`로 테마 순환(auto → dark → light), 새로고침 후에도 유지.
- 줌 변경 시 흐린 단계 없음(이전 비트맵 잠깐 stretched → sharp 교체).
- 주석 도구바에서 텍스트/형광펜/도형/직선/화살표/펜 생성, 선택 후 이동·리사이즈·삭제.
- `Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y`로 주석 undo/redo.
- PDF 옆 `.notes.json` sidecar 자동저장 및 재열기 시 복원.
- `내보내기`로 주석 포함 PDF flatten 저장.
- 앱 창으로 PDF 드래그앤드롭 열기.

dev는 unoptimized라 release 대비 PDFium 자체가 5~10× 느립니다. 최종 성능 측정은:
```bash
npm run tauri build
open src-tauri/target/release/bundle/macos/rustpdf.app
```

현재 macOS arm64 빌드 산출물:
- `src-tauri/target/release/bundle/macos/rustpdf.app`
- `src-tauri/target/release/bundle/dmg/rustpdf_0.1.0_aarch64.dmg`
