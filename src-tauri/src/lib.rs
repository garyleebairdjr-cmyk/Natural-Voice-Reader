//! Natural Voice Reader app shell (desktop and Android).
//!
//! The UI is the same React app as the web build, compiled as a static bundle
//! (`npm run build:desktop`). Anything the web build does on its Node server
//! is a Tauri command here; see `src/lib/platform/` on the TypeScript side.

mod packs;
mod page;
mod speech;

use std::sync::Arc;

use packs::{PackState, Packs};
use speech::{Engine, Speech};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn list_packs(app: AppHandle, packs: State<'_, Arc<Packs>>) -> Vec<PackState> {
    packs.list(&packs::sherpa_root(&app))
}

#[tauri::command]
fn install_pack(app: AppHandle, packs: State<'_, Arc<Packs>>, id: String) -> Result<Vec<PackState>, String> {
    let pack = packs::pack(&id).ok_or("This voice pack is not available in the app.")?;
    if let Some(busy) = packs.busy() {
        return Err(format!("Another pack ({busy}) is being changed. Try again when it finishes."));
    }
    let root = packs::sherpa_root(&app);
    // Mark the pack busy before returning, so the UI starts polling progress.
    packs.start(pack.id);
    let (worker, task_root) = (Arc::clone(&packs), root.clone());
    tauri::async_runtime::spawn(async move { worker.install(task_root, pack).await });
    Ok(packs.list(&root))
}

#[tauri::command]
fn remove_pack(
    app: AppHandle,
    packs: State<'_, Arc<Packs>>,
    speech: State<'_, Speech>,
    id: String,
) -> Result<Vec<PackState>, String> {
    let pack = packs::pack(&id).ok_or("This voice pack is not available in the app.")?;
    if packs.busy().is_some() {
        return Err("A voice pack is being changed. Try again when it finishes.".into());
    }
    speech.unload(if id == "kokoro" { Engine::Kokoro } else { Engine::Kitten });
    let root = packs::sherpa_root(&app);
    packs.remove(&root, pack)?;
    Ok(packs.list(&root))
}

#[tauri::command]
async fn synthesize(
    app: AppHandle,
    engine: String,
    speaker: String,
    text: String,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let engine = if engine == "kokoro" { Engine::Kokoro } else { Engine::Kitten };
    let root = packs::sherpa_root(&app);
    let handle = app.clone();
    let wav = tauri::async_runtime::spawn_blocking(move || {
        let speech: State<'_, Speech> = handle.state();
        speech.synthesize(&root, engine, &speaker, &text, speed)
    })
    .await
    .map_err(|_| "The voice engine stopped unexpectedly.".to_string())??;
    Ok(tauri::ipc::Response::new(wav))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let packs = Arc::new(Packs::default());
    tauri::Builder::default()
        .setup({
            let packs = Arc::clone(&packs);
            move |app| {
                packs.first_run_install(packs::sherpa_root(app.handle()));
                Ok(())
            }
        })
        .manage(packs)
        .manage(Speech::default())
        .invoke_handler(tauri::generate_handler![
            page::fetch_page,
            list_packs,
            install_pack,
            remove_pack,
            synthesize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Natural Voice Reader");
}
