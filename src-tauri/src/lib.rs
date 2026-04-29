mod ipc;
mod pdf;

use ipc::AppState;
use pdf::annotations::export_flattened_pdf;
use pdf::document::{close_document, open_document, OpenedDocument};
use pdf::edit::{
    capture_region, copy_pages_to_clipboard, delete_pages, duplicate_pages, paste_pages,
    save_doc_as, PdfPageEditResult,
};
use pdf::ocr::{
    load_sidecar_into_cache, ocr_page as ocr_page_impl, persist_sidecar, OcrLine, OcrPage,
};
use pdf::render::render_page;
use pdf::text::{extract_native_text_lines, search as text_search, SearchHit};
use pdf::PdfError;
use serde_json::Value;
use std::path::PathBuf;
use tauri::ipc::Response;
use tauri::State;

#[tauri::command(rename_all = "camelCase")]
async fn pdf_open(state: State<'_, AppState>, path: String) -> Result<OpenedDocument, PdfError> {
    let opened = open_document(&state.registry, path.clone())?;
    // Best-effort sidecar load — missing file just means no prior OCR yet.
    let _ = load_sidecar_into_cache(&state.ocr, &opened.id, &path);
    Ok(opened)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_close(state: State<'_, AppState>, doc_id: String) -> Result<bool, PdfError> {
    state.cache.purge_doc(&doc_id);
    state.text.invalidate(&doc_id);
    state.ocr.invalidate(&doc_id);
    Ok(close_document(&state.registry, &doc_id))
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_ocr_page(
    state: State<'_, AppState>,
    doc_id: String,
    page_index: usize,
) -> Result<OcrPage, PdfError> {
    let page = ocr_page_impl(&state.registry, &state.cache, &state.ocr, &doc_id, page_index)?;
    // Persist sidecar so subsequent opens of this PDF skip the slow path.
    if let Ok(handle) = state.registry.get(&doc_id) {
        let _ = persist_sidecar(&state.ocr, &doc_id, &handle.path);
    }
    // Refresh the text-search cache so the newly OCR'd page is searchable.
    state.text.invalidate(&doc_id);
    Ok(page)
}

/// Return the structured text layer for a page (lines + bboxes, normalized
/// 0–1 with origin top-left) so the frontend can render an invisible
/// selectable layer on top of the bitmap. Returns `None` if no OCR data
/// exists yet for this page — the frontend can decide to trigger OCR.
#[tauri::command(rename_all = "camelCase")]
async fn pdf_ocr_lines(
    state: State<'_, AppState>,
    doc_id: String,
    page_index: usize,
) -> Result<Option<Vec<OcrLine>>, PdfError> {
    Ok(state.ocr.get(&doc_id, page_index).map(|p| p.lines))
}

/// Extract the embedded text layer from the PDF itself (no OCR). PDFs
/// exported from Excel / Word / browsers carry actual text characters with
/// known positions; pulling them out lets us render a native selection
/// layer instantly, no OCR required.
#[tauri::command(rename_all = "camelCase")]
async fn pdf_text_lines(
    state: State<'_, AppState>,
    doc_id: String,
    page_index: usize,
) -> Result<Vec<OcrLine>, PdfError> {
    extract_native_text_lines(&state.registry, &doc_id, page_index)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_ocr_status(
    state: State<'_, AppState>,
    doc_id: String,
) -> Result<Vec<usize>, PdfError> {
    // Return the list of page indices we already have OCR for. The frontend
    // uses this to compute progress and skip already-processed pages.
    let snap = state.ocr.snapshot_for_doc(&doc_id);
    let mut keys: Vec<usize> = snap.keys().copied().collect();
    keys.sort_unstable();
    Ok(keys)
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
    text_search(&state.text, &state.registry, &state.ocr, &doc_id, &query)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_delete_pages(
    state: State<'_, AppState>,
    doc_id: String,
    indices: Vec<usize>,
) -> Result<PdfPageEditResult, PdfError> {
    delete_pages(
        &state.registry,
        &state.cache,
        &state.text,
        &doc_id,
        &indices,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_copy_pages(
    state: State<'_, AppState>,
    doc_id: String,
    indices: Vec<usize>,
) -> Result<String, PdfError> {
    copy_pages_to_clipboard(&state.registry, &state.clipboard, &doc_id, &indices)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_paste_pages(
    state: State<'_, AppState>,
    doc_id: String,
    after_index: i64,
    clipboard_id: String,
) -> Result<PdfPageEditResult, PdfError> {
    paste_pages(
        &state.registry,
        &state.cache,
        &state.text,
        &state.clipboard,
        &doc_id,
        after_index,
        &clipboard_id,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_duplicate_pages(
    state: State<'_, AppState>,
    doc_id: String,
    indices: Vec<usize>,
) -> Result<PdfPageEditResult, PdfError> {
    duplicate_pages(
        &state.registry,
        &state.cache,
        &state.text,
        &doc_id,
        &indices,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_save_as(
    state: State<'_, AppState>,
    doc_id: String,
    target_path: String,
) -> Result<(), PdfError> {
    save_doc_as(&state.registry, &doc_id, &target_path)
}

#[tauri::command(rename_all = "camelCase")]
async fn pdf_capture_region(
    state: State<'_, AppState>,
    doc_id: String,
    page_index: usize,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    scale: f32,
) -> Result<tauri::ipc::Response, PdfError> {
    let bytes = capture_region(&state.registry, &doc_id, page_index, x, y, w, h, scale)?;
    Ok(tauri::ipc::Response::new(bytes))
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

/// PDF paths passed via command-line at launch (e.g. "Open With" from Finder
/// / Explorer). Returns ALL pdf-extension args so multi-file open lands as
/// multiple tabs.
#[tauri::command(rename_all = "camelCase")]
async fn initial_open_paths() -> Vec<String> {
    let mut out: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| {
            PathBuf::from(arg)
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .collect();

    // Drain pending paths queued before the frontend was ready. Always
    // append, never overwrite — a user could legitimately drop more files
    // before the JS listener wires up.
    out.extend(crate::ipc::take_pending_open_paths());
    out
}

/// Tell the OS that the user just used this file. macOS Dock right-click and
/// the Apple menu's "Recent Items" pick this up via `NSDocumentController`.
/// On Windows, the equivalent populates the Start Menu jump list. No-op on
/// other platforms.
///
/// Tauri runs `async` commands on a tokio worker thread, but AppKit and the
/// objc runtime require the main thread — calling `[NSApp sharedApplication]`
/// or `[NSDocumentController noteNewRecentDocumentURL:]` from anywhere else
/// raises an obj-c exception that Rust can't catch and the process aborts.
/// So we hop to the main thread before any obj-c work.
#[tauri::command(rename_all = "camelCase")]
async fn note_recent_document(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path_clone = path.clone();
        let _ = app.run_on_main_thread(move || {
            note_recent_document_native(&path_clone);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        note_recent_document_native(&path);
    }
    Ok(())
}

/// Replace the macOS dock-tile custom menu with the given recents
/// (most-recent first). Clicks on items emit an "open-pdfs" Tauri event back
/// to the frontend. Same main-thread caveat as `note_recent_document` applies.
#[tauri::command(rename_all = "camelCase")]
async fn set_dock_recents(
    app: tauri::AppHandle,
    paths: Vec<String>,
    names: Vec<String>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            set_dock_recents_native(&app_clone, &paths, &names);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        set_dock_recents_native(&app, &paths, &names);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn note_recent_document_native(path: &str) {
    // We invoke `NSDocumentController` through Apple's `objc_msgSend` ABI.
    // Keeping the call narrow avoids dragging in the full AppKit binding for
    // this one feature. The call is best-effort: any missing symbol just means
    // the file won't show in the system recent-documents list; the in-app
    // recents list is unaffected.
    use std::ffi::c_void;
    use std::os::raw::c_char;

    type Sel = *const c_void;
    type Class = *const c_void;
    type Object = *mut c_void;

    extern "C" {
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_getClass(name: *const c_char) -> Class;
    }

    // Manual dispatch via objc_msgSend has different ABIs per arg count and
    // type — we only need a couple of forms here.
    type MsgSend0 = unsafe extern "C" fn(Object, Sel) -> Object;
    type MsgSend1Ptr = unsafe extern "C" fn(Object, Sel, *const c_void) -> Object;
    type MsgSendVoid1Ptr = unsafe extern "C" fn(Object, Sel, *const c_void);
    type MsgSendPtr = unsafe extern "C" fn(Class, Sel, *const c_char) -> Object;

    extern "C" {
        fn objc_msgSend();
    }

    unsafe {
        let s = |s: &str| -> std::ffi::CString {
            std::ffi::CString::new(s).unwrap()
        };

        // Build NSURL.fileURLWithPath:NSString
        let ns_string_class = objc_getClass(s("NSString").as_ptr());
        if ns_string_class.is_null() {
            return;
        }
        let with_utf8_string = sel_registerName(s("stringWithUTF8String:").as_ptr());
        let send_ptr: MsgSendPtr = std::mem::transmute(objc_msgSend as *const ());
        let path_cstr = match std::ffi::CString::new(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        let ns_path = send_ptr(ns_string_class, with_utf8_string, path_cstr.as_ptr());
        if ns_path.is_null() {
            return;
        }

        let ns_url_class = objc_getClass(s("NSURL").as_ptr());
        if ns_url_class.is_null() {
            return;
        }
        let file_url_with_path = sel_registerName(s("fileURLWithPath:").as_ptr());
        let send_obj: MsgSend1Ptr = std::mem::transmute(objc_msgSend as *const ());
        let url = send_obj(
            ns_url_class as Object,
            file_url_with_path,
            ns_path as *const c_void,
        );
        if url.is_null() {
            return;
        }

        // [[NSDocumentController sharedDocumentController] noteNewRecentDocumentURL:url];
        let doc_class = objc_getClass(s("NSDocumentController").as_ptr());
        if doc_class.is_null() {
            return;
        }
        let shared = sel_registerName(s("sharedDocumentController").as_ptr());
        let send0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
        let controller = send0(doc_class as Object, shared);
        if controller.is_null() {
            return;
        }
        let note = sel_registerName(s("noteNewRecentDocumentURL:").as_ptr());
        let send_void: MsgSendVoid1Ptr = std::mem::transmute(objc_msgSend as *const ());
        send_void(controller, note, url as *const c_void);
    }
}

#[cfg(target_os = "windows")]
fn note_recent_document_native(path: &str) {
    // Windows Jump List + recent docs: SHAddToRecentDocs. Done via direct
    // FFI to avoid pulling in the full `windows` crate just for one call.
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn SHAddToRecentDocs(uFlags: u32, pv: *const u16);
    }
    const SHARD_PATHW: u32 = 0x00000003;

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        SHAddToRecentDocs(SHARD_PATHW, wide.as_ptr());
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn note_recent_document_native(_path: &str) {}

#[cfg(target_os = "macos")]
mod dock_menu {
    //! Dynamic obj-c hooks for the app Dock menu.
    //!
    //! AppKit asks the NSApplication delegate for `applicationDockMenu:` when
    //! the user opens the Dock context menu. Tauri's delegate class does not
    //! implement that optional method, so we add it at runtime and return a
    //! menu built from the frontend's persisted recent-file list. Menu item
    //! clicks are routed through a tiny target/action object whose single
    //! method forwards the item's representedObject path back to the webview.
    use parking_lot::Mutex;
    use std::ffi::c_void;
    use std::os::raw::c_char;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, Manager};

    type Sel = *const c_void;
    type Class = *const c_void;
    type Object = *mut c_void;

    extern "C" {
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_getClass(name: *const c_char) -> Class;
        fn objc_allocateClassPair(superclass: Class, name: *const c_char, extra_bytes: usize) -> Class;
        fn objc_registerClassPair(cls: Class);
        fn class_addMethod(
            cls: Class,
            name: Sel,
            imp: *const c_void,
            types: *const c_char,
        ) -> bool;
        fn object_getClass(obj: Object) -> Class;
        fn objc_msgSend();
    }

    type MsgSend0 = unsafe extern "C" fn(Object, Sel) -> Object;
    type MsgSend1 = unsafe extern "C" fn(Object, Sel, Object) -> Object;
    type MsgSend1Ptr = unsafe extern "C" fn(Object, Sel, *const c_void) -> Object;
    type MsgSend3StringSelString =
        unsafe extern "C" fn(Object, Sel, *const c_void, Sel, *const c_void) -> Object;
    type MsgSendVoidPtr = unsafe extern "C" fn(Object, Sel) -> *const c_void;

    static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
    static RECENT_ITEMS: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
    static CURRENT_MENU: OnceLock<Mutex<Option<usize>>> = OnceLock::new();
    static DOCK_MENU_METHOD_INSTALLED: OnceLock<Mutex<bool>> = OnceLock::new();
    // Pointers aren't Send/Sync, but ObjC class objects and instances are
    // shared globally and never deallocated for our app lifetime, so it's
    // safe to store as opaque integers and round-trip through casts.
    static HANDLER_CLASS: OnceLock<usize> = OnceLock::new();
    static SHARED_HANDLER: OnceLock<usize> = OnceLock::new();

    fn handle_lock() -> &'static Mutex<Option<AppHandle>> {
        APP_HANDLE.get_or_init(|| Mutex::new(None))
    }

    fn recent_items_lock() -> &'static Mutex<Vec<(String, String)>> {
        RECENT_ITEMS.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn current_menu_lock() -> &'static Mutex<Option<usize>> {
        CURRENT_MENU.get_or_init(|| Mutex::new(None))
    }

    fn dock_menu_method_installed_lock() -> &'static Mutex<bool> {
        DOCK_MENU_METHOD_INSTALLED.get_or_init(|| Mutex::new(false))
    }

    fn cstr(s: &str) -> std::ffi::CString {
        std::ffi::CString::new(s).unwrap()
    }

    /// Called from the obj-c runtime when the user clicks a recent-items
    /// submenu entry. `sender` is the NSMenuItem; its representedObject is
    /// the NSString path. We extract the UTF-8 path and forward it to the
    /// frontend through the shared `open-pdfs` channel.
    extern "C" fn handle_click(_self: Object, _cmd: Sel, sender: Object) {
        unsafe {
            if sender.is_null() {
                return;
            }
            let send0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
            let represented_object = sel_registerName(cstr("representedObject").as_ptr());
            let path_obj = send0(sender, represented_object);
            if path_obj.is_null() {
                return;
            }
            let utf8_string = sel_registerName(cstr("UTF8String").as_ptr());
            let send_void: MsgSendVoidPtr = std::mem::transmute(objc_msgSend as *const ());
            let cstr_ptr = send_void(path_obj, utf8_string) as *const c_char;
            if cstr_ptr.is_null() {
                return;
            }
            let path = std::ffi::CStr::from_ptr(cstr_ptr)
                .to_string_lossy()
                .to_string();

            if let Some(handle) = handle_lock().lock().clone() {
                let pdfs = vec![path.clone()];
                crate::ipc::queue_open_paths(pdfs.clone());
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.emit("open-pdfs", &pdfs);
                    let _ = window.set_focus();
                } else {
                    let _ = handle.emit("open-pdfs", &pdfs);
                }
            }
        }
    }

    // The objc runtime keeps these string pointers for the lifetime of the
    // class, so they MUST outlive a stack-local CString. Using byte-literal
    // statics gives them 'static lifetime and eliminates the dangling-pointer
    // class corruption that was triggering "fatal runtime error: Rust cannot
    // catch foreign exceptions" on app startup.
    const CLASS_NAME: &[u8] = b"RustpdfDockHandler\0";
    const METHOD_TYPES: &[u8] = b"v@:@\0";
    const DOCK_MENU_METHOD_TYPES: &[u8] = b"@@:@\0";

    unsafe fn ensure_class() -> Class {
        if let Some(c) = HANDLER_CLASS.get() {
            return *c as Class;
        }
        let ns_object = objc_getClass(cstr("NSObject").as_ptr());
        // If a previous (failed) registration left this class around — say,
        // the dev process re-attached without a clean exit — reuse it
        // rather than calling allocateClassPair again (which returns NULL
        // for an existing name and would crash on the next class_addMethod).
        let existing = objc_getClass(CLASS_NAME.as_ptr() as *const c_char);
        let cls = if !existing.is_null() {
            existing
        } else {
            let cls = objc_allocateClassPair(
                ns_object,
                CLASS_NAME.as_ptr() as *const c_char,
                0,
            );
            if cls.is_null() {
                // Couldn't create the class — bail without crashing.
                return std::ptr::null();
            }
            // Method type encoding: void return ('v'), self ('@'), _cmd (':'),
            // sender ('@'). See Apple's "Type Encodings" docs.
            let sel = sel_registerName(cstr("openRecent:").as_ptr());
            class_addMethod(
                cls,
                sel,
                handle_click as *const () as *const c_void,
                METHOD_TYPES.as_ptr() as *const c_char,
            );
            objc_registerClassPair(cls);
            cls
        };
        let _ = HANDLER_CLASS.set(cls as usize);
        cls
    }

    unsafe fn ensure_shared_handler() -> Object {
        if let Some(p) = SHARED_HANDLER.get() {
            return *p as Object;
        }
        let cls = ensure_class();
        if cls.is_null() {
            return std::ptr::null_mut();
        }
        let alloc = sel_registerName(cstr("alloc").as_ptr());
        let init = sel_registerName(cstr("init").as_ptr());
        let send0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
        let allocated = send0(cls as Object, alloc);
        let initialized = send0(allocated, init);
        let _ = SHARED_HANDLER.set(initialized as usize);
        initialized
    }

    unsafe fn ns_string(s: &str) -> Object {
        let cls = objc_getClass(cstr("NSString").as_ptr());
        let sel = sel_registerName(cstr("stringWithUTF8String:").as_ptr());
        let cstring = match std::ffi::CString::new(s) {
            Ok(c) => c,
            Err(_) => return std::ptr::null_mut(),
        };
        let send: MsgSend1Ptr = std::mem::transmute(objc_msgSend as *const ());
        send(cls as Object, sel, cstring.as_ptr() as *const c_void)
    }

    pub fn install_app_handle(app: &AppHandle) {
        *handle_lock().lock() = Some(app.clone());
    }

    extern "C" fn application_dock_menu(_self: Object, _cmd: Sel, _sender: Object) -> Object {
        unsafe {
            let menu = build_menu();
            *current_menu_lock().lock() = if menu.is_null() {
                None
            } else {
                Some(menu as usize)
            };
            menu
        }
    }

    unsafe fn ensure_application_dock_menu_method() {
        let mut installed = dock_menu_method_installed_lock().lock();
        if *installed {
            return;
        }

        let send0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
        let ns_app_class = objc_getClass(cstr("NSApplication").as_ptr());
        if ns_app_class.is_null() {
            return;
        }
        let shared = sel_registerName(cstr("sharedApplication").as_ptr());
        let app = send0(ns_app_class as Object, shared);
        if app.is_null() {
            return;
        }
        let delegate_sel = sel_registerName(cstr("delegate").as_ptr());
        let delegate = send0(app, delegate_sel);
        if delegate.is_null() {
            return;
        }
        let delegate_class = object_getClass(delegate);
        if delegate_class.is_null() {
            return;
        }

        let dock_menu_sel = sel_registerName(cstr("applicationDockMenu:").as_ptr());
        let added = class_addMethod(
            delegate_class,
            dock_menu_sel,
            application_dock_menu as *const () as *const c_void,
            DOCK_MENU_METHOD_TYPES.as_ptr() as *const c_char,
        );
        // If AppKit/Tauri already provides this optional delegate method, do
        // not replace it. Current Tauri builds do not, so `added` is the path
        // that enables our recents menu.
        if added {
            *installed = true;
        }
    }

    unsafe fn build_menu() -> Object {
        let items = recent_items_lock().lock().clone();
        if items.is_empty() {
            return std::ptr::null_mut();
        }

        unsafe {
            let send0: MsgSend0 = std::mem::transmute(objc_msgSend as *const ());
            let send1: MsgSend1 = std::mem::transmute(objc_msgSend as *const ());
            let send3: MsgSend3StringSelString =
                std::mem::transmute(objc_msgSend as *const ());

            // [[NSMenu alloc] init]
            let ns_menu_class = objc_getClass(cstr("NSMenu").as_ptr());
            if ns_menu_class.is_null() {
                return std::ptr::null_mut();
            }
            let alloc = sel_registerName(cstr("alloc").as_ptr());
            let init = sel_registerName(cstr("init").as_ptr());
            let menu = send0(send0(ns_menu_class as Object, alloc), init);

            let action_sel = sel_registerName(cstr("openRecent:").as_ptr());
            let target = ensure_shared_handler();
            if target.is_null() {
                return std::ptr::null_mut();
            }

            let ns_menu_item_class = objc_getClass(cstr("NSMenuItem").as_ptr());
            if ns_menu_item_class.is_null() {
                return std::ptr::null_mut();
            }
            let init_with = sel_registerName(
                cstr("initWithTitle:action:keyEquivalent:").as_ptr(),
            );
            let set_target = sel_registerName(cstr("setTarget:").as_ptr());
            let set_represented = sel_registerName(cstr("setRepresentedObject:").as_ptr());
            let add_item = sel_registerName(cstr("addItem:").as_ptr());

            for (path, name) in items.iter() {
                let title = ns_string(name);
                let key = ns_string("");
                let alloced = send0(ns_menu_item_class as Object, alloc);
                let item = send3(
                    alloced,
                    init_with,
                    title as *const c_void,
                    action_sel,
                    key as *const c_void,
                );
                if item.is_null() {
                    continue;
                }
                send1(item, set_target, target);
                let path_obj = ns_string(path);
                send1(item, set_represented, path_obj);
                send1(menu, add_item, item);
            }

            menu
        }
    }

    pub fn set_recents(paths: &[String], names: &[String]) {
        let items = paths
            .iter()
            .zip(names.iter())
            .take(10)
            .map(|(path, name)| (path.clone(), name.clone()))
            .collect();
        *recent_items_lock().lock() = items;
        unsafe {
            ensure_application_dock_menu_method();
        }
    }
}

#[cfg(target_os = "macos")]
fn set_dock_recents_native(app: &tauri::AppHandle, paths: &[String], names: &[String]) {
    dock_menu::install_app_handle(app);
    dock_menu::set_recents(paths, names);
}

#[cfg(not(target_os = "macos"))]
fn set_dock_recents_native(_app: &tauri::AppHandle, _paths: &[String], _names: &[String]) {
    // Windows Jump List with custom recents requires `JumpList` APIs from
    // the Windows.UI.Shell namespace, which we don't have wired up yet.
    // For now, the per-file `SHAddToRecentDocs` call inside
    // `note_recent_document_native` is enough to populate the Start Menu
    // recent files list.
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

fn collect_pdf_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|arg| {
            PathBuf::from(arg)
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // To re-enable Windows / Linux single-instance routing (forwarding PDF
    // paths from a second invocation to the already-running instance):
    // uncomment the dependency in Cargo.toml and the block below.
    // #[cfg(any(target_os = "windows", target_os = "linux"))]
    // let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
    //     let pdfs = collect_pdf_paths(args);
    //     if pdfs.is_empty() { return; }
    //     ipc::queue_open_paths(pdfs.clone());
    //     use tauri::{Emitter, Manager};
    //     if let Some(window) = app.get_webview_window("main") {
    //         let _ = window.emit("open-pdfs", pdfs);
    //         let _ = window.set_focus();
    //     } else {
    //         let _ = app.emit("open-pdfs", pdfs);
    //     }
    // }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pdf_open,
            pdf_close,
            pdf_render_page,
            pdf_search,
            pdf_delete_pages,
            pdf_copy_pages,
            pdf_paste_pages,
            pdf_duplicate_pages,
            pdf_save_as,
            pdf_capture_region,
            pdf_ocr_page,
            pdf_ocr_lines,
            pdf_text_lines,
            pdf_ocr_status,
            annotations_load,
            annotations_save,
            initial_open_paths,
            export_annotated_pdf,
            note_recent_document,
            set_dock_recents,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: when the app is already running and the OS asks it to
            // open files (Finder double-click, drag onto Dock icon),
            // tauri-runtime delivers them via `RunEvent::Opened`. Convert
            // them to PDF paths and either forward to the webview or queue.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.into_os_string().into_string().ok())
                    .collect();
                let pdfs = collect_pdf_paths(paths);
                if !pdfs.is_empty() {
                    ipc::queue_open_paths(pdfs.clone());
                    use tauri::{Emitter, Manager};
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("open-pdfs", pdfs);
                        let _ = window.set_focus();
                    } else {
                        let _ = app.emit("open-pdfs", pdfs);
                    }
                }
            }
            let _ = app;
            let _ = event;
        });
}
