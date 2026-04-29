use super::cache::PageCache;
use super::document::DocRegistry;
use super::render::render_page;
use super::PdfError;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// One recognized line of text together with its position. Coordinates are
/// in normalized 0–1 page space with origin at the top-left, regardless of
/// what the underlying engine returns — we normalize on parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Per-page OCR result. We carry both the joined plain text (so search and
/// other consumers don't have to reassemble lines) and the structured lines
/// (so the frontend can render a positioned text layer for selection).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    pub text: String,
    pub lines: Vec<OcrLine>,
}

/// OCR result cache, keyed by (doc_id, page_index). Survives the whole app
/// session and is also persisted alongside the document on disk. Hitting OCR
/// is expensive, so we want the second open of the same file to be instant.
pub struct OcrCache {
    inner: RwLock<HashMap<String, OcrPage>>,
}

impl OcrCache {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    fn key(doc_id: &str, page: usize) -> String {
        format!("{doc_id}::{page}")
    }

    pub fn get(&self, doc_id: &str, page: usize) -> Option<OcrPage> {
        self.inner.read().get(&Self::key(doc_id, page)).cloned()
    }

    pub fn get_text(&self, doc_id: &str, page: usize) -> Option<String> {
        self.get(doc_id, page).map(|p| p.text)
    }

    pub fn put(&self, doc_id: &str, page: usize, page_data: OcrPage) {
        self.inner.write().insert(Self::key(doc_id, page), page_data);
    }

    pub fn invalidate(&self, doc_id: &str) {
        let prefix = format!("{doc_id}::");
        self.inner.write().retain(|k, _| !k.starts_with(&prefix));
    }

    pub fn snapshot_for_doc(&self, doc_id: &str) -> HashMap<usize, OcrPage> {
        let prefix = format!("{doc_id}::");
        self.inner
            .read()
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix(&prefix)
                    .and_then(|s| s.parse::<usize>().ok())
                    .map(|i| (i, v.clone()))
            })
            .collect()
    }

    pub fn load_from_sidecar(&self, doc_id: &str, sidecar: HashMap<usize, OcrPage>) {
        let mut map = self.inner.write();
        for (page, value) in sidecar {
            map.insert(Self::key(doc_id, page), value);
        }
    }
}

fn ocr_sidecar_path(pdf_path: &str) -> PathBuf {
    PathBuf::from(format!("{pdf_path}.ocr.json"))
}

pub fn load_sidecar_into_cache(
    cache: &OcrCache,
    doc_id: &str,
    pdf_path: &str,
) -> Result<(), PdfError> {
    let path = ocr_sidecar_path(pdf_path);
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(&path)?;
    // Try the modern structured format first; fall back to the legacy
    // string-only sidecar so users with files OCR'd by an earlier build
    // don't lose their cached text. Old entries get an empty `lines`
    // array (search still works; selection layer just isn't rebuilt).
    if let Ok(parsed) = serde_json::from_slice::<HashMap<String, OcrPage>>(&bytes) {
        let mut as_int: HashMap<usize, OcrPage> = HashMap::new();
        for (k, v) in parsed {
            if let Ok(i) = k.parse::<usize>() {
                as_int.insert(i, v);
            }
        }
        cache.load_from_sidecar(doc_id, as_int);
        return Ok(());
    }
    if let Ok(legacy) = serde_json::from_slice::<HashMap<String, String>>(&bytes) {
        let mut as_int: HashMap<usize, OcrPage> = HashMap::new();
        for (k, v) in legacy {
            if let Ok(i) = k.parse::<usize>() {
                as_int.insert(
                    i,
                    OcrPage {
                        text: v,
                        lines: Vec::new(),
                    },
                );
            }
        }
        cache.load_from_sidecar(doc_id, as_int);
        return Ok(());
    }
    Ok(())
}

pub fn persist_sidecar(
    cache: &OcrCache,
    doc_id: &str,
    pdf_path: &str,
) -> Result<(), PdfError> {
    let snap = cache.snapshot_for_doc(doc_id);
    if snap.is_empty() {
        return Ok(());
    }
    let stringified: HashMap<String, OcrPage> =
        snap.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let bytes = serde_json::to_vec_pretty(&stringified)?;
    std::fs::write(ocr_sidecar_path(pdf_path), bytes)?;
    Ok(())
}

/// Render the page to a PNG file in a temp dir and run the platform OCR
/// helper. Returns the recognized text. The 2x scale balances accuracy
/// (tiny rasters fail to recognize) against speed.
pub fn ocr_page(
    registry: &DocRegistry,
    cache: &PageCache,
    ocr_cache: &OcrCache,
    doc_id: &str,
    page_index: usize,
) -> Result<OcrPage, PdfError> {
    if let Some(cached) = ocr_cache.get(doc_id, page_index) {
        return Ok(cached);
    }

    // Render at ~2x for OCR clarity. Higher scales are slower without much
    // accuracy gain on the 300dpi-equivalent native engines we target.
    const OCR_SCALE: f32 = 2.0;
    let raw = render_page(registry, cache, doc_id, page_index, OCR_SCALE, 0)?;
    // raw layout: [u32 BE width][u32 BE height][rgba bytes]
    if raw.len() < 8 {
        return Err(PdfError::Pdfium("ocr render returned empty".into()));
    }
    let width = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    let height = u32::from_be_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
    let pixels = &raw[8..];

    // Encode RGBA → PNG into a temp file. The platform helpers all take a
    // file path which sidesteps stdin-binary plumbing.
    let mut buf: Vec<u8> = Vec::new();
    {
        let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels.to_vec())
            .ok_or_else(|| PdfError::Image("rgba size mismatch".into()))?;
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| PdfError::Image(e.to_string()))?;
    }

    let mut tmp = std::env::temp_dir();
    tmp.push(format!("rustpdf-ocr-{}-{}.png", doc_id, page_index));
    std::fs::write(&tmp, &buf)?;

    let result = run_platform_ocr(&tmp);
    // Best-effort cleanup; OS will sweep tmp anyway.
    let _ = std::fs::remove_file(&tmp);

    let page_data = result?;
    ocr_cache.put(doc_id, page_index, page_data.clone());
    Ok(page_data)
}

#[cfg(target_os = "macos")]
fn run_platform_ocr(image_path: &PathBuf) -> Result<OcrPage, PdfError> {
    // Inline Swift program piped to `xcrun swift`. Vision returns one
    // observation per recognized text line, each with a normalized
    // bounding box (origin at the BOTTOM-left, 0..1 coords). We emit JSON
    // with the bbox flipped to top-left origin so the frontend can
    // position SVG/HTML text spans without doing the flip itself.
    let script = r#"
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { exit(1) }
let path = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: path),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { exit(2) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("ocr error: \(error)".data(using: .utf8) ?? Data())
    exit(3)
}

struct LineEntry: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

var lines: [LineEntry] = []
let results = (request.results as? [VNRecognizedTextObservation]) ?? []
for obs in results {
    if let top = obs.topCandidates(1).first {
        let bb = obs.boundingBox  // origin: bottom-left, 0..1
        // Flip Y so origin is top-left to match how the frontend lays out
        // pages (CSS coordinates).
        let topLeftY = 1.0 - Double(bb.origin.y) - Double(bb.size.height)
        lines.append(LineEntry(
            text: top.string,
            x: Double(bb.origin.x),
            y: topLeftY,
            w: Double(bb.size.width),
            h: Double(bb.size.height)
        ))
    }
}

let data = try JSONEncoder().encode(lines)
FileHandle.standardOutput.write(data)
"#;

    let mut child = Command::new("xcrun")
        .args(["swift", "-"])
        .arg("--")
        .arg(image_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            PdfError::Pdfium(format!(
                "failed to launch xcrun (Xcode CLT required for OCR on macOS): {e}"
            ))
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(script.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(PdfError::Pdfium(format!("macOS Vision OCR failed: {err}")));
    }
    parse_lines_json(&output.stdout)
}

/// Parse the JSON line array emitted by the macOS helper into the shared
/// `OcrPage` shape (lines + concatenated plain text). Same parser is reused
/// by the Windows path; engine differences are absorbed by the inline
/// scripts.
fn parse_lines_json(stdout: &[u8]) -> Result<OcrPage, PdfError> {
    let lines: Vec<OcrLine> =
        serde_json::from_slice(stdout).unwrap_or_default();
    // Defensive clamp — anything outside [0,1] would render off-page.
    let cleaned: Vec<OcrLine> = lines
        .into_iter()
        .filter(|l| l.w > 0.0 && l.h > 0.0)
        .map(|mut l| {
            l.x = l.x.clamp(0.0, 1.0);
            l.y = l.y.clamp(0.0, 1.0);
            l.w = l.w.clamp(0.0, 1.0);
            l.h = l.h.clamp(0.0, 1.0);
            l
        })
        .collect();
    let text = cleaned
        .iter()
        .map(|l| l.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(OcrPage {
        text,
        lines: cleaned,
    })
}

#[cfg(target_os = "windows")]
fn run_platform_ocr(image_path: &PathBuf) -> Result<OcrPage, PdfError> {
    // Windows.Media.Ocr ships with the OS. PowerShell exposes WinRT directly
    // via the [Type, Assembly, ContentType=WindowsRuntime] cast. We block on
    // the async APIs via GetAwaiter().GetResult() — fine for our serial,
    // page-at-a-time use.
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]

function Await($task, $type) {{
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        ? {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 }} |
        Select-Object -First 1
    $task.GetAwaiter().GetResult()
}}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{}'))
$stream = Await $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
$bitmap = Await $decoder.GetSoftwareBitmapAsync()
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine -eq $null) {{
    Write-Error 'No OCR engine for current user-profile languages'
    exit 1
}}
$result = Await $engine.RecognizeAsync($bitmap)
$bw = $bitmap.PixelWidth
$bh = $bitmap.PixelHeight
$lines = @()
foreach ($line in $result.Lines) {{
    $minX = [double]::PositiveInfinity
    $minY = [double]::PositiveInfinity
    $maxX = [double]::NegativeInfinity
    $maxY = [double]::NegativeInfinity
    foreach ($w in $line.Words) {{
        $r = $w.BoundingRect
        if ($r.X -lt $minX) {{ $minX = $r.X }}
        if ($r.Y -lt $minY) {{ $minY = $r.Y }}
        if ($r.X + $r.Width -gt $maxX) {{ $maxX = $r.X + $r.Width }}
        if ($r.Y + $r.Height -gt $maxY) {{ $maxY = $r.Y + $r.Height }}
    }}
    if ($minX -eq [double]::PositiveInfinity) {{ continue }}
    $obj = @{{
        text = $line.Text
        x = $minX / $bw
        y = $minY / $bh
        w = ($maxX - $minX) / $bw
        h = ($maxY - $minY) / $bh
    }}
    $lines += [pscustomobject]$obj
}}
$lines | ConvertTo-Json -Compress
"#,
        image_path.display().to_string().replace('\'', "''")
    );

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| PdfError::Pdfium(format!("failed to launch powershell: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(PdfError::Pdfium(format!("Windows OCR failed: {err}")));
    }
    // PowerShell's ConvertTo-Json emits a single object for one element and
    // an array for many — wrap singletons defensively before parsing.
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let normalized = if raw.starts_with('[') || raw.is_empty() {
        raw
    } else {
        format!("[{raw}]")
    };
    parse_lines_json(normalized.as_bytes())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_platform_ocr(_image_path: &PathBuf) -> Result<OcrPage, PdfError> {
    Err(PdfError::Pdfium(
        "OCR is currently supported on macOS (Apple Vision) and Windows (Windows.Media.Ocr). \
         Linux support requires Tesseract; install it and we'll wire it up next."
            .into(),
    ))
}
