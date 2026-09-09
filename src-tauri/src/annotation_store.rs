use crate::pdf::PdfError;
use crate::storage::{atomic_write, sha256_hex};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

// Claiming a moved document and publishing its aliases must not race another
// load/save in a different Tauri worker. Individual files are replaced atomically.
static STORE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationLoadResult {
    pub sidecar: Option<Value>,
    /// `none`, `exact`, `legacy`, `recovered`, `mismatch`, or `ambiguous`.
    pub status: String,
    pub message: Option<String>,
}

fn legacy_sidecar_path(path: &str) -> PathBuf {
    PathBuf::from(format!("{path}.notes.json"))
}

/// Stable 64-bit FNV-1a hash retained for compatibility with the original
/// path-keyed annotation store.
fn fnv1a_64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for byte in s.bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn alias_path(root: &Path, pdf_path: &str) -> PathBuf {
    root.join(format!("{:016x}.notes.json", fnv1a_64(pdf_path)))
}

fn documents_root(root: &Path) -> PathBuf {
    root.join("documents")
}

fn stable_path(root: &Path, fingerprint: &str, document_key: &str) -> PathBuf {
    documents_root(root)
        .join(fingerprint)
        .join(format!("{document_key}.notes.json"))
}

fn annotation_root(app: &tauri::AppHandle) -> Result<PathBuf, PdfError> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| PdfError::Io(std::io::Error::other(error.to_string())))?;
    Ok(base.join("annotations"))
}

fn read_json(path: &Path) -> Result<Value, PdfError> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn value_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}

fn sidecar_fingerprint(value: &Value) -> Option<&str> {
    value_string(value, "pdfFingerprint")
}

fn sidecar_source(value: &Value) -> Option<&str> {
    value_string(value, "sourcePath")
}

fn ensure_object(data: Value) -> Map<String, Value> {
    match data {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn valid_document_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn enrich_sidecar(pdf_path: &str, pdf_bytes: &[u8], data: Value) -> Value {
    let mut object = ensure_object(data);
    object.insert("version".into(), Value::from(2));
    object.insert("sourcePath".into(), Value::from(pdf_path.to_string()));
    object.insert("pdfFingerprint".into(), Value::from(sha256_hex(pdf_bytes)));
    let needs_key = object
        .get("documentKey")
        .and_then(Value::as_str)
        .map_or(true, |key| !valid_document_key(key));
    if needs_key {
        object.insert(
            "documentKey".into(),
            Value::from(Uuid::new_v4().to_string()),
        );
    }
    if !object.contains_key("annotations") {
        object.insert("annotations".into(), Value::Array(Vec::new()));
    }
    Value::Object(object)
}

fn write_stable(root: &Path, sidecar: &Value) -> Result<(), PdfError> {
    let fingerprint = value_string(sidecar, "pdfFingerprint")
        .ok_or_else(|| PdfError::Pdfium("annotation sidecar has no PDF fingerprint".into()))?;
    let document_key = value_string(sidecar, "documentKey")
        .ok_or_else(|| PdfError::Pdfium("annotation sidecar has no document key".into()))?;
    let path = stable_path(root, fingerprint, document_key);
    if let Ok(existing) = read_json(&path) {
        if sidecar_source(&existing).is_some_and(|source| {
            Some(source) != sidecar_source(sidecar) && Path::new(source).exists()
        }) {
            return Err(PdfError::Pdfium(
                "다른 PDF가 사용 중인 주석 저장소에는 저장할 수 없습니다. 문서를 다시 열어 주세요."
                    .into(),
            ));
        }
    }
    let bytes = serde_json::to_vec_pretty(sidecar)?;
    atomic_write(path, &bytes)?;
    Ok(())
}

fn write_alias(root: &Path, pdf_path: &str, sidecar: &Value) -> Result<(), PdfError> {
    let bytes = serde_json::to_vec_pretty(sidecar)?;
    atomic_write(alias_path(root, pdf_path), &bytes)?;
    Ok(())
}

/// A path alias is only an index into the fingerprint/document-key store. The
/// stable record is written first on every save, so it can legitimately be
/// newer when the process stops before the alias replacement. Prefer that
/// record whenever the alias gives us enough identity to find it.
fn authoritative_exact_sidecar(
    root: &Path,
    pdf_path: &str,
    pdf_bytes: &[u8],
    fingerprint: &str,
    alias: Value,
) -> Result<Option<Value>, PdfError> {
    if let Some(document_key) =
        value_string(&alias, "documentKey").filter(|key| valid_document_key(key))
    {
        let path = stable_path(root, fingerprint, document_key);
        if let Ok(stable) = read_json(&path) {
            let stable_matches = sidecar_fingerprint(&stable) == Some(fingerprint)
                && value_string(&stable, "documentKey") == Some(document_key);
            if stable_matches {
                // Opening an already-owned record is read-only; only a changed
                // owner needs a durable claim before we return the annotations.
                if sidecar_source(&stable) == Some(pdf_path) {
                    return Ok(Some(stable));
                }
                // An old alias can survive a move (or a previous buggy recovery).
                // Never let it claim notes now owned by another existing PDF.
                if sidecar_source(&stable)
                    .is_some_and(|source| source != pdf_path && Path::new(source).exists())
                {
                    return Ok(None);
                }
                let claimed = enrich_sidecar(pdf_path, pdf_bytes, stable);
                write_stable(root, &claimed)?;
                return Ok(Some(claimed));
            }
        }
    }
    let claimed = enrich_sidecar(pdf_path, pdf_bytes, alias);
    write_stable(root, &claimed)?;
    Ok(Some(claimed))
}

/// Stage the fingerprint-addressed sidecar for bytes that are about to
/// replace a PDF. This intentionally does not update the path alias yet.
pub fn stage_for_pdf_bytes(
    app: &tauri::AppHandle,
    pdf_path: &str,
    pdf_bytes: &[u8],
    data: Value,
) -> Result<(), PdfError> {
    let _guard = STORE_LOCK.lock();
    let root = annotation_root(app)?;
    let sidecar = enrich_sidecar(pdf_path, pdf_bytes, data);
    write_stable(&root, &sidecar)
}

/// Save metadata for caller-validated bytes. Used by annotation autosave so
/// an external replacement of the path cannot be mistaken for the open
/// in-memory document.
pub fn save_for_pdf_bytes(
    app: &tauri::AppHandle,
    pdf_path: &str,
    pdf_bytes: &[u8],
    data: Value,
) -> Result<(), PdfError> {
    let _guard = STORE_LOCK.lock();
    let root = annotation_root(app)?;
    let sidecar = enrich_sidecar(pdf_path, pdf_bytes, data);
    write_stable(&root, &sidecar)?;
    write_alias(&root, pdf_path, &sidecar)?;

    // Retire the old adjacent file only after both durable replacements have
    // succeeded, so a failed migration never destroys the only copy.
    let legacy = legacy_sidecar_path(pdf_path);
    if legacy.exists() {
        let _ = std::fs::remove_file(legacy);
    }
    Ok(())
}

fn candidate_sidecars(root: &Path, fingerprint: &str) -> Result<Vec<Value>, PdfError> {
    let directory = documents_root(root).join(fingerprint);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let value = match read_json(&entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if sidecar_fingerprint(&value) == Some(fingerprint) {
            candidates.push(value);
        }
    }
    Ok(candidates)
}

fn result(sidecar: Option<Value>, status: &str, message: Option<String>) -> AnnotationLoadResult {
    AnnotationLoadResult {
        sidecar,
        status: status.to_string(),
        message,
    }
}

fn load_from_root(
    root: &Path,
    pdf_path: &str,
    pdf_bytes: &[u8],
) -> Result<AnnotationLoadResult, PdfError> {
    let fingerprint = sha256_hex(pdf_bytes);
    let alias = alias_path(root, pdf_path);
    let mut alias_mismatch = false;
    if alias.exists() {
        match read_json(&alias) {
            Ok(exact) => match sidecar_fingerprint(&exact) {
                Some(stored) if stored == fingerprint => {
                    if let Some(exact) =
                        authoritative_exact_sidecar(root, pdf_path, pdf_bytes, &fingerprint, exact)?
                    {
                        return Ok(result(Some(exact), "exact", None));
                    }
                    alias_mismatch = true;
                }
                None => {
                    // A path-keyed v1 record is safe at its exact original path.
                    return Ok(result(
                        Some(exact),
                        "legacy",
                        Some("이 주석은 다음 저장 때 안전한 v2 형식으로 이전됩니다.".into()),
                    ));
                }
                Some(_) => alias_mismatch = true,
            },
            Err(_) => {
                // A partial/manual alias corruption must not hide the durable
                // fingerprint-addressed copy written before it.
                alias_mismatch = true;
            }
        }
    }

    let candidates = candidate_sidecars(root, &fingerprint)?;
    let current_matches: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| sidecar_source(candidate) == Some(pdf_path))
        .collect();
    if current_matches.len() == 1 {
        let exact = enrich_sidecar(pdf_path, pdf_bytes, current_matches[0].clone());
        // Repair a missing, stale, or corrupt alias after successfully finding
        // the authoritative stable record. Recovery does not depend on this.
        let _ = write_alias(root, pdf_path, &exact);
        return Ok(result(Some(exact), "exact", None));
    }

    // A rename/move makes the recorded source path disappear. Requiring one
    // and only one such candidate avoids silently sharing notes with an
    // identical PDF copy whose original still exists.
    let moved: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| {
            sidecar_source(candidate)
                .map(|source| source != pdf_path && !Path::new(source).exists())
                .unwrap_or(false)
        })
        .collect();
    if moved.len() == 1 {
        let recovered = enrich_sidecar(pdf_path, pdf_bytes, moved[0].clone());
        // Publish the new owner BEFORE returning notes or repairing the alias.
        // Otherwise another identical PDF still sees the missing old source and
        // recovers the same key. A failed durable claim must fail the recovery.
        write_stable(root, &recovered)?;
        let _ = write_alias(root, pdf_path, &recovered);
        return Ok(result(
            Some(recovered),
            "recovered",
            Some("이동되거나 이름이 바뀐 PDF의 주석을 내용 지문으로 복구했습니다.".into()),
        ));
    }

    if !candidates.is_empty() {
        return Ok(result(
            None,
            "ambiguous",
            Some(
                "동일한 내용의 PDF용 주석이 여러 개이거나 원본 복사본이 남아 있어 자동으로 연결하지 않았습니다."
                    .into(),
            ),
        ));
    }

    let legacy = legacy_sidecar_path(pdf_path);
    if legacy.exists() {
        return Ok(result(
            Some(read_json(&legacy)?),
            "legacy",
            Some("기존 주석 파일을 불러왔으며 다음 저장 때 v2로 이전됩니다.".into()),
        ));
    }

    if alias_mismatch {
        return Ok(result(
            None,
            "mismatch",
            Some("PDF 내용과 주석 파일의 지문이 달라 잘못된 주석을 연결하지 않았습니다.".into()),
        ));
    }
    Ok(result(None, "none", None))
}

/// Load metadata against the exact bytes held by the open registry handle.
/// Reading the path again here would create a race where an external process
/// replaces the PDF between `pdf_open` and sidecar loading.
pub fn load_for_pdf_bytes(
    app: &tauri::AppHandle,
    pdf_path: &str,
    pdf_bytes: &[u8],
) -> Result<AnnotationLoadResult, PdfError> {
    let _guard = STORE_LOCK.lock();
    load_from_root(&annotation_root(app)?, pdf_path, pdf_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("rustpdf-annotations-{label}-{stamp}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn sample(path: &str, bytes: &[u8], key: &str) -> Value {
        enrich_sidecar(
            path,
            bytes,
            json!({
                "documentKey": key,
                "updatedAt": "2026-08-03T00:00:00Z",
                "annotations": [{"id": key}]
            }),
        )
    }

    #[test]
    fn reconnects_unique_sidecar_after_move() {
        let root = temp_root("move");
        let old_path = root.join("old.pdf");
        let new_path = root.join("new.pdf");
        let bytes = b"same-pdf";
        std::fs::write(&old_path, bytes).unwrap();
        let sidecar = sample(old_path.to_str().unwrap(), bytes, "doc-a");
        write_stable(&root, &sidecar).unwrap();
        std::fs::rename(&old_path, &new_path).unwrap();

        let loaded = load_from_root(&root, new_path.to_str().unwrap(), bytes).unwrap();
        assert_eq!(loaded.status, "recovered");
        assert_eq!(loaded.sidecar.unwrap()["annotations"][0]["id"], "doc-a");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn does_not_attach_notes_to_an_identical_copy() {
        let root = temp_root("copy");
        let original = root.join("original.pdf");
        let copy = root.join("copy.pdf");
        let bytes = b"same-pdf";
        std::fs::write(&original, bytes).unwrap();
        std::fs::write(&copy, bytes).unwrap();
        let sidecar = sample(original.to_str().unwrap(), bytes, "doc-a");
        write_stable(&root, &sidecar).unwrap();

        let loaded = load_from_root(&root, copy.to_str().unwrap(), bytes).unwrap();
        assert_eq!(loaded.status, "ambiguous");
        assert!(loaded.sidecar.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovered_document_does_not_share_notes_with_a_later_copy() {
        let root = temp_root("move-then-copy");
        let old = root.join("a.pdf");
        let moved = root.join("b.pdf");
        let copy = root.join("c.pdf");
        let bytes = b"same-pdf";
        std::fs::write(&old, bytes).unwrap();
        let original = sample(old.to_str().unwrap(), bytes, "doc-a");
        write_stable(&root, &original).unwrap();
        write_alias(&root, old.to_str().unwrap(), &original).unwrap();
        std::fs::rename(&old, &moved).unwrap();

        let recovered = load_from_root(&root, moved.to_str().unwrap(), bytes).unwrap();
        assert_eq!(recovered.status, "recovered");
        std::fs::copy(&moved, &copy).unwrap();
        let copied = load_from_root(&root, copy.to_str().unwrap(), bytes).unwrap();
        assert!(copied.sidecar.is_none());

        // Reusing the old filename must not bypass ownership via its old alias.
        std::fs::copy(&moved, &old).unwrap();
        let recreated = load_from_root(&root, old.to_str().unwrap(), bytes).unwrap();
        assert!(recreated.sidecar.is_none());
        assert!(write_stable(&root, &original).is_err());

        // A newly saved copy gets independent notes and cannot affect the owner.
        let independent = sample(copy.to_str().unwrap(), bytes, "doc-c");
        write_stable(&root, &independent).unwrap();
        write_alias(&root, copy.to_str().unwrap(), &independent).unwrap();
        let reopened = load_from_root(&root, moved.to_str().unwrap(), bytes).unwrap();
        assert_eq!(reopened.sidecar.unwrap()["annotations"][0]["id"], "doc-a");
        assert_eq!(
            load_from_root(&root, copy.to_str().unwrap(), bytes)
                .unwrap()
                .sidecar
                .unwrap()["annotations"][0]["id"],
            "doc-c"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_claim_survives_alias_write_failure_and_another_move() {
        let root = temp_root("move-alias-failure");
        let old = root.join("a.pdf");
        let moved = root.join("b.pdf");
        let next = root.join("c.pdf");
        let copy = root.join("copy.pdf");
        let bytes = b"same-pdf";
        std::fs::write(&old, bytes).unwrap();
        write_stable(&root, &sample(old.to_str().unwrap(), bytes, "doc-a")).unwrap();
        std::fs::rename(&old, &moved).unwrap();
        std::fs::create_dir(alias_path(&root, moved.to_str().unwrap())).unwrap();
        assert_eq!(
            load_from_root(&root, moved.to_str().unwrap(), bytes)
                .unwrap()
                .status,
            "recovered"
        );
        std::fs::copy(&moved, &copy).unwrap();
        assert!(load_from_root(&root, copy.to_str().unwrap(), bytes)
            .unwrap()
            .sidecar
            .is_none());
        std::fs::rename(&moved, &next).unwrap();
        assert_eq!(
            load_from_root(&root, next.to_str().unwrap(), bytes)
                .unwrap()
                .status,
            "recovered"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repairs_legacy_recovery_alias_without_sharing_its_key() {
        let root = temp_root("old-recovery");
        let old = root.join("missing.pdf");
        let moved = root.join("b.pdf");
        let copy = root.join("c.pdf");
        let bytes = b"same-pdf";
        std::fs::write(&moved, bytes).unwrap();
        std::fs::write(&copy, bytes).unwrap();
        // Reproduce the disk layout left behind by the previous implementation.
        write_stable(&root, &sample(old.to_str().unwrap(), bytes, "doc-a")).unwrap();
        write_alias(
            &root,
            moved.to_str().unwrap(),
            &sample(moved.to_str().unwrap(), bytes, "doc-a"),
        )
        .unwrap();
        write_alias(
            &root,
            copy.to_str().unwrap(),
            &sample(copy.to_str().unwrap(), bytes, "doc-a"),
        )
        .unwrap();
        assert_eq!(
            load_from_root(&root, moved.to_str().unwrap(), bytes)
                .unwrap()
                .status,
            "exact"
        );
        assert!(load_from_root(&root, copy.to_str().unwrap(), bytes)
            .unwrap()
            .sidecar
            .is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_path_alias_for_changed_pdf_contents() {
        let root = temp_root("mismatch");
        let path = root.join("changed.pdf");
        let old = sample(path.to_str().unwrap(), b"old", "doc-a");
        write_alias(&root, path.to_str().unwrap(), &old).unwrap();

        let loaded = load_from_root(&root, path.to_str().unwrap(), b"new").unwrap();
        assert_eq!(loaded.status, "mismatch");
        assert!(loaded.sidecar.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn staged_fingerprint_record_survives_either_side_of_pdf_commit() {
        let root = temp_root("commit-window");
        let path = root.join("document.pdf");
        let path_string = path.to_string_lossy().into_owned();
        let old_bytes = b"old-pdf-generation";
        let new_bytes = b"new-pdf-generation";

        let old_sidecar = sample(&path_string, old_bytes, "doc-a");
        write_stable(&root, &old_sidecar).unwrap();
        write_alias(&root, &path_string, &old_sidecar).unwrap();

        // This is the transaction's pre-PDF-commit stage. The path alias is
        // deliberately still for the old bytes.
        let new_sidecar = sample(&path_string, new_bytes, "doc-a");
        write_stable(&root, &new_sidecar).unwrap();

        let before_commit = load_from_root(&root, &path_string, old_bytes).unwrap();
        assert_eq!(before_commit.status, "exact");
        assert_eq!(
            before_commit.sidecar.unwrap()["pdfFingerprint"],
            sha256_hex(old_bytes)
        );

        let after_commit = load_from_root(&root, &path_string, new_bytes).unwrap();
        assert_eq!(after_commit.status, "exact");
        assert_eq!(
            after_commit.sidecar.unwrap()["pdfFingerprint"],
            sha256_hex(new_bytes)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stable_record_wins_when_same_fingerprint_alias_is_stale() {
        let root = temp_root("stale-alias");
        let path = root.join("document.pdf");
        let path_string = path.to_string_lossy().into_owned();
        let bytes = b"unchanged-pdf-generation";

        let old_sidecar = sample(&path_string, bytes, "doc-a");
        write_alias(&root, &path_string, &old_sidecar).unwrap();

        let mut new_sidecar = sample(&path_string, bytes, "doc-a");
        new_sidecar["annotations"] = json!([{"id": "newest"}]);
        write_stable(&root, &new_sidecar).unwrap();

        let loaded = load_from_root(&root, &path_string, bytes).unwrap();
        assert_eq!(loaded.status, "exact");
        assert_eq!(loaded.sidecar.unwrap()["annotations"][0]["id"], "newest");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_alias_does_not_hide_stable_record() {
        let root = temp_root("corrupt-alias");
        let path = root.join("document.pdf");
        let path_string = path.to_string_lossy().into_owned();
        let bytes = b"pdf-generation";
        let sidecar = sample(&path_string, bytes, "doc-a");
        write_stable(&root, &sidecar).unwrap();
        atomic_write(alias_path(&root, &path_string), b"not json").unwrap();

        let loaded = load_from_root(&root, &path_string, bytes).unwrap();
        assert_eq!(loaded.status, "exact");
        assert_eq!(loaded.sidecar.unwrap()["annotations"][0]["id"], "doc-a");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replaces_unsafe_document_key_before_building_storage_path() {
        let sidecar = enrich_sidecar(
            "/tmp/document.pdf",
            b"pdf",
            json!({
                "documentKey": "../../outside",
                "annotations": []
            }),
        );
        let key = value_string(&sidecar, "documentKey").unwrap();
        assert!(valid_document_key(key));
        assert!(!key.contains('/'));
        assert!(!key.contains('\\'));
    }
}
