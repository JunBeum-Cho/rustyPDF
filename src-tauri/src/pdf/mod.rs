pub mod annotations;
pub mod cache;
pub mod document;
pub mod render;
pub mod text;

use pdfium_render::prelude::Pdfium;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PdfError {
    #[error("pdfium init failed: {0}")]
    Init(String),
    #[error("invalid document handle")]
    InvalidHandle,
    #[error("invalid page index {0}")]
    InvalidPage(usize),
    #[error("pdfium error: {0}")]
    Pdfium(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("image encode error: {0}")]
    Image(String),
}

impl serde::Serialize for PdfError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

/// Build a `Pdfium` by trying explicit env path → bundled location → system.
/// Library lookups are cheap (dlopen) and we keep this synchronous; callers
/// instantiate once per top-level request and drop when done.
pub fn create_pdfium() -> Result<Pdfium, PdfError> {
    let lib_name = Pdfium::pdfium_platform_library_name();

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(custom) = std::env::var("RUSTPDF_PDFIUM_PATH") {
        candidates.push(PathBuf::from(custom));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(&lib_name));
            candidates.push(parent.join("../Frameworks").join(&lib_name));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("lib").join(&lib_name));
        candidates.push(cwd.join("src-tauri/lib").join(&lib_name));
    }

    let mut last_err: Option<String> = None;
    for c in &candidates {
        if !c.exists() {
            continue;
        }
        match Pdfium::bind_to_library(c) {
            Ok(b) => return Ok(Pdfium::new(b)),
            Err(e) => last_err = Some(e.to_string()),
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(b) => Ok(Pdfium::new(b)),
        Err(e) => Err(PdfError::Init(last_err.unwrap_or_else(|| e.to_string()))),
    }
}
