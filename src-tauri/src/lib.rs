//! Natural Voice Reader app shell (desktop and Android).
//!
//! The UI is the same React app as the web build, compiled as a static bundle
//! (`npm run build:desktop`). Anything the web build does on its Node server
//! is a Tauri command here; see `src/lib/platform/` on the TypeScript side.

mod page;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![page::fetch_page])
        .run(tauri::generate_context!())
        .expect("error while running Natural Voice Reader");
}
