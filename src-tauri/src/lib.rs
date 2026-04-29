mod ipc;
mod pdf;

use ipc::AppState;
use pdf::annotations::export_flattened_pdf;
use pdf::document::{close_document, open_document, OpenedDocument};
use pdf::render::render_page;
use pdf::text::{search as text_search, SearchHit};
use pdf::PdfError;
use serde_json::Value;
use std::path::PathBuf;
use tauri::ipc::Response;
use tauri::State;

#[tauri::command(rename_all = "camelCase")]
async fn pdf_open(state: State<'_, AppState>, path: String) -> Result<OpenedDocument, PdfError> {
    open_document(&state.registry, path)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_close(state: State<'_, AppState>, doc_id: String) -> Result<bool, PdfError> {
    state.cache.purge_doc(&doc_id);
    state.text.invalidate(&doc_id);
    Ok(close_document(&state.registry, &doc_id))
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_render_page(
    state: State<'_, AppState>,
    doc_id: String,
    page_index: usize,
    scale: f32,
    rotation: i32,
) -> Result<Response, PdfError> {
    let bytes = render_page(
        &state.registry,
        &state.cache,
        &doc_id,
        page_index,
        scale,
        rotation,
    )?;
    Ok(Response::new(bytes))
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_search(
    state: State<'_, AppState>,
    doc_id: String,
    query: String,
) -> Result<Vec<SearchHit>, PdfError> {
    text_search(&state.text, &state.registry, &doc_id, &query)
}

fn sidecar_path(path: &str) -> PathBuf {
    PathBuf::from(format!("{path}.notes.json"))
}

#[tauri::command(rename_all = "camelCase")]
async fn annotations_load(path: String) -> Result<Option<Value>, PdfError> {
    let path = sidecar_path(&path);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

#[tauri::command(rename_all = "camelCase")]
async fn annotations_save(path: String, data: Value) -> Result<(), PdfError> {
    let path = sidecar_path(&path);
    let bytes = serde_json::to_vec_pretty(&data)?;
    std::fs::write(path, bytes)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn initial_open_path() -> Option<String> {
    std::env::args().skip(1).find(|arg| {
        PathBuf::from(arg)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn export_annotated_pdf(
    source_path: String,
    target_path: String,
    data: Value,
) -> Result<(), PdfError> {
    export_flattened_pdf(&source_path, &target_path, data.clone())?;
    let sidecar = sidecar_path(&target_path);
    std::fs::write(sidecar, serde_json::to_vec_pretty(&data)?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pdf_open,
            pdf_close,
            pdf_render_page,
            pdf_search,
            annotations_load,
            annotations_save,
            initial_open_path,
            export_annotated_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
