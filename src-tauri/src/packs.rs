//! Voice packs for the installed app.
//!
//! Packs are sherpa-onnx model archives from the sherpa-onnx GitHub release.
//! They live in the same per-user data folder as the command-line installer
//! (`nvr voices install`), so a pack installed either way works in both:
//!
//! - Linux: `$XDG_DATA_HOME/nvr` (default `~/.local/share/nvr`)
//! - macOS: `~/Library/Application Support/nvr`
//! - Windows: `%LOCALAPPDATA%\nvr`
//! - Android: the app's private data folder
//!
//! `NVR_DATA_HOME` overrides the folder on desktop.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use crate::speech::{KITTEN_DIR, KOKORO_DIR};

pub struct NativePack {
    pub id: &'static str,
    url: &'static str,
    pub dir: &'static str,
    /// Files that must exist, with sha256 where it is known.
    files: &'static [(&'static str, Option<&'static str>)],
}

pub const PACKS: [NativePack; 2] = [
    NativePack {
        id: "kittentts",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-mini-en-v0_8.tar.bz2",
        dir: KITTEN_DIR,
        files: &[
            ("model.onnx", Some("d2ba2913a135bf255840c053f6c77d23f735337992f3258cc238caf404e1949c")),
            ("voices.bin", Some("0e4965b46333db53ce09c73842623bf7055ea62c67f78803cb7ea9c16da6ac2b")),
            ("tokens.txt", Some("934a4188addc7665dd3410256bb622169242357fbb99d840d9351209b486dabb")),
        ],
    },
    NativePack {
        id: "kokoro",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2",
        dir: KOKORO_DIR,
        files: &[
            ("model.int8.onnx", Some("75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e")),
            ("voices.bin", Some("1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29")),
            ("tokens.txt", Some("6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425")),
            ("lexicon-gb-en.txt", None),
        ],
    },
];

pub fn pack(id: &str) -> Option<&'static NativePack> {
    PACKS.iter().find(|p| p.id == id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pack_id: String,
    state: &'static str, // downloading | verifying | removing | error
    percent: Option<f64>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackState {
    id: &'static str,
    installed: bool,
    installing: bool,
    progress: Option<Progress>,
}

#[derive(Default)]
pub struct Packs {
    progress: Mutex<Option<Progress>>,
}

/// The per-user `nvr` data folder, shared with the command-line tools.
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if cfg!(mobile) {
        return app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    if let Some(custom) = std::env::var_os("NVR_DATA_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(custom);
    }
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("nvr")
}

pub fn sherpa_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    data_root(app).join("sherpa")
}

fn is_installed(root: &Path, pack: &NativePack) -> bool {
    pack.files.iter().all(|(name, _)| root.join(pack.dir).join(name).is_file())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

impl Packs {
    fn set(&self, progress: Option<Progress>) {
        if let Ok(mut p) = self.progress.lock() {
            *p = progress;
        }
    }

    fn update(&self, id: &str, state: &'static str, percent: Option<f64>, message: impl Into<String>) {
        self.set(Some(Progress { pack_id: id.into(), state, percent, message: message.into() }));
    }

    pub fn start(&self, id: &str) {
        self.update(id, "downloading", Some(0.0), "Starting download…");
    }

    pub fn busy(&self) -> Option<String> {
        let p = self.progress.lock().ok()?;
        p.as_ref().filter(|p| p.state != "error").map(|p| p.pack_id.clone())
    }

    pub fn list(&self, root: &Path) -> Vec<PackState> {
        let progress = self.progress.lock().ok().and_then(|p| p.clone());
        PACKS
            .iter()
            .map(|pack| {
                let mine = progress.as_ref().filter(|p| p.pack_id == pack.id).cloned();
                PackState {
                    id: pack.id,
                    installed: is_installed(root, pack),
                    installing: mine.as_ref().is_some_and(|p| p.state != "error"),
                    progress: mine,
                }
            })
            .collect()
    }

    /// Download, verify, and unpack a pack. Runs to completion; callers spawn it.
    /// Install a pack, always ending in "installed" or a visible error. The
    /// work runs in its own task so that a panic (for example from the TLS
    /// layer) is reported instead of leaving the pack stuck at 0% and busy.
    pub async fn install(self: Arc<Self>, root: PathBuf, pack: &'static NativePack) {
        let worker = Arc::clone(&self);
        let joined = tauri::async_runtime::spawn(async move { worker.install_inner(&root, pack).await }).await;
        match joined {
            Ok(Ok(())) => self.set(None),
            Ok(Err(message)) => {
                crate::applog::error(&format!("Installing {} failed: {message}", pack.id));
                self.update(pack.id, "error", None, message);
            }
            Err(err) => {
                let why = panic_text(err);
                crate::applog::error(&format!("Installing {} crashed: {why}", pack.id));
                self.update(pack.id, "error", None, format!("The download stopped unexpectedly ({why}). Try again."));
            }
        }
    }

    async fn install_inner(&self, root: &Path, pack: &'static NativePack) -> Result<(), String> {
        std::fs::create_dir_all(root).map_err(|e| format!("Could not create the voice folder: {e}"))?;
        let archive = root.join(format!(".download-{}.tar.bz2", pack.id));
        self.update(pack.id, "downloading", Some(0.0), "Downloading voices…");

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // A stalled transfer errors out instead of hanging at the same percent.
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("Could not start the download: {}", crate::applog::root_cause(&e)))?;
        let mut res = client.get(pack.url).send().await.map_err(|e| {
            crate::applog::error(&format!("Download request for {} failed: {}", pack.id, crate::applog::chain(&e)));
            format!("Could not reach the download server ({}). Check your connection.", crate::applog::root_cause(&e))
        })?;
        if !res.status().is_success() {
            return Err(format!("The download server returned {}.", res.status().as_u16()));
        }
        let total = res.content_length();
        let mut file = std::fs::File::create(&archive).map_err(|e| format!("Could not save the download: {e}"))?;
        let mut done: u64 = 0;
        while let Some(chunk) = res.chunk().await.map_err(|e| {
            crate::applog::error(&format!("Download of {} interrupted: {}", pack.id, crate::applog::chain(&e)));
            format!("The download was interrupted ({}). Try again.", crate::applog::root_cause(&e))
        })? {
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("Could not save the download: {e}"))?;
            done += chunk.len() as u64;
            let percent = total.map(|t| (done as f64 / t as f64 * 100.0).min(100.0));
            let mb = done as f64 / 1_048_576.0;
            self.update(pack.id, "downloading", percent, format!("Downloading voices… {mb:.0} MB"));
        }
        drop(file);

        self.update(pack.id, "verifying", None, "Unpacking and checking files…");
        let staging = root.join(format!(".unpack-{}", pack.id));
        let (archive2, staging2, root2) = (archive.clone(), staging.clone(), root.to_path_buf());
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let _ = std::fs::remove_dir_all(&staging2);
            std::fs::create_dir_all(&staging2).map_err(|e| e.to_string())?;
            let file = std::fs::File::open(&archive2).map_err(|e| e.to_string())?;
            let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
            tar.unpack(&staging2).map_err(|_| "The download was damaged. Try again.".to_string())?;
            let unpacked = staging2.join(pack.dir);
            for (name, sha) in pack.files {
                let path = unpacked.join(name);
                if !path.is_file() {
                    return Err(format!("The voice pack is missing {name}."));
                }
                if let Some(want) = sha {
                    if sha256_file(&path).map_err(|e| e.to_string())? != *want {
                        return Err(format!("{name} did not match its checksum, so it was not installed."));
                    }
                }
            }
            let target = root2.join(pack.dir);
            let _ = std::fs::remove_dir_all(&target);
            std::fs::rename(&unpacked, &target).map_err(|e| format!("Could not move the voices into place: {e}"))?;
            Ok(())
        })
        .await
        .map_err(|_| "Unpacking stopped unexpectedly.".to_string())?;
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    /// On first launch, install the default pack (KittenTTS) like the
    /// command-line installer does. A marker file records that this ran, so
    /// a pack the user removes later is not reinstalled.
    pub fn first_run_install(self: &std::sync::Arc<Self>, root: PathBuf) {
        let marker = root.join(".app-default-packs");
        if marker.exists() {
            return;
        }
        let kitten = &PACKS[0];
        if std::fs::create_dir_all(&root).is_err() || std::fs::write(&marker, "kittentts\n").is_err() {
            return;
        }
        if is_installed(&root, kitten) {
            return;
        }
        self.start(kitten.id);
        let worker = std::sync::Arc::clone(self);
        tauri::async_runtime::spawn(async move { worker.install(root, kitten).await });
    }

    pub fn remove(&self, root: &Path, pack: &NativePack) -> Result<(), String> {
        let target = root.join(pack.dir);
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("Could not remove the voice pack: {e}"))?;
        }
        self.set(None);
        Ok(())
    }
}

/// The message of a panicked task, or the join error itself.
fn panic_text(err: tauri::Error) -> String {
    match err {
        tauri::Error::JoinError(join) if join.is_panic() => {
            let payload = join.into_panic();
            payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "a crash in the download task".into())
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Downloads a real pack when `NVR_TEST_PACK_ROOT` is set. Skipped otherwise.
    #[test]
    fn installs_and_removes_kitten() {
        let Ok(root) = std::env::var("NVR_TEST_PACK_ROOT") else { return };
        let root = PathBuf::from(root);
        let packs = Arc::new(Packs::default());
        let kitten = pack("kittentts").unwrap();
        packs.start(kitten.id);
        assert!(packs.list(&root).iter().any(|p| p.id == "kittentts" && p.installing));
        tauri::async_runtime::block_on(Arc::clone(&packs).install(root.clone(), kitten));
        let state = packs.list(&root);
        let k = state.iter().find(|p| p.id == "kittentts").unwrap();
        assert!(k.installed && !k.installing, "progress: {:?}", k.progress.as_ref().map(|p| &p.message));
        assert!(!root.join(".download-kittentts.tar.bz2").exists());
        packs.remove(&root, kitten).unwrap();
        assert!(!root.join(KITTEN_DIR).exists());
    }
}
