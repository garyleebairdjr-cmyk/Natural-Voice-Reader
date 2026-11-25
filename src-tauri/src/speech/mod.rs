//! On-device speech with sherpa-onnx: KittenTTS for the standard voices and
//! Kokoro for Butler, Mira, and Arjun. No Python, no espeak-ng.
//!
//! Text is normalized (numbers and symbols become words), turned into
//! phonemes in Rust (see `english` and `kokoro`), and handed to sherpa-onnx
//! as phoneme codepoints. Models load on first use and stay loaded.

pub mod english;
pub mod kokoro;
pub mod neural;
pub mod normalize;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKittenModelConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};

use english::EnglishG2p;
use kokoro::KokoroLexicon;

pub const KITTEN_DIR: &str = "kitten-mini-en-v0_8";
pub const KOKORO_DIR: &str = "kokoro-int8-multi-lang-v1_0";

/// Speaker order in sherpa-onnx's kitten v0.8 voices.bin.
const KITTEN_SPEAKERS: [&str; 8] = [
    "expr-voice-2-m", "expr-voice-2-f", "expr-voice-3-m", "expr-voice-3-f",
    "expr-voice-4-m", "expr-voice-4-f", "expr-voice-5-m", "expr-voice-5-f",
];
/// Speaker ids in kokoro-multi-lang-v1_0 used by the reader.
const KOKORO_SPEAKERS: [(&str, i32); 3] = [("bm_george", 26), ("hf_alpha", 31), ("hm_omega", 33)];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    Kitten,
    Kokoro,
}

struct Loaded {
    dir: PathBuf,
    tts: OfflineTts,
    vocab: HashSet<char>,
}

#[derive(Default)]
struct Inner {
    english: Option<EnglishG2p>,
    kitten: Option<Loaded>,
    kokoro: Option<(Loaded, KokoroLexicon)>,
}

#[derive(Default)]
pub struct Speech {
    inner: Mutex<Inner>,
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().clamp(1, 4) as i32).unwrap_or(2)
}

fn vocab(tokens: &Path) -> Result<HashSet<char>, String> {
    let text = std::fs::read_to_string(tokens).map_err(|e| format!("Could not read {}: {e}", tokens.display()))?;
    Ok(text.lines().filter_map(|l| l.chars().next()).collect())
}

fn load(dir: &Path, engine: Engine) -> Result<Loaded, String> {
    let s = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let model = match engine {
        Engine::Kitten => OfflineTtsModelConfig {
            kitten: OfflineTtsKittenModelConfig {
                model: s("model.onnx"),
                voices: s("voices.bin"),
                tokens: s("tokens.txt"),
                ..Default::default()
            },
            num_threads: threads(),
            ..Default::default()
        },
        Engine::Kokoro => OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: s("model.int8.onnx"),
                voices: s("voices.bin"),
                tokens: s("tokens.txt"),
                ..Default::default()
            },
            num_threads: threads(),
            ..Default::default()
        },
    };
    let tts = OfflineTts::create(&OfflineTtsConfig { model, ..Default::default() })
        .ok_or_else(|| "The voice model could not be loaded. Try removing and reinstalling the voice pack.".to_string())?;
    Ok(Loaded { dir: dir.to_path_buf(), tts, vocab: vocab(&dir.join("tokens.txt"))? })
}

/// Split phonemes into sentences and map them to codepoints the model knows.
fn codepoints(phonemes: &str, vocab: &HashSet<char>) -> Vec<Vec<i32>> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    for c in phonemes.chars() {
        if !vocab.contains(&c) {
            continue;
        }
        if current.is_empty() && c == ' ' {
            continue;
        }
        current.push(c as i32);
        if matches!(c, '.' | '!' | '?') {
            out.push(std::mem::take(&mut current));
        }
    }
    if current.iter().any(|&c| c != ' ' as i32) {
        out.push(current);
    }
    out
}

/// 16-bit mono PCM WAV.
fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

impl Speech {
    /// Speak `text` with `speaker` and return a WAV file.
    pub fn synthesize(&self, sherpa_root: &Path, engine: Engine, speaker: &str, text: &str, speed: f32) -> Result<Vec<u8>, String> {
        let normalized = normalize::normalize(text);
        let mut inner = self.inner.lock().map_err(|_| "The voice engine stopped. Restart the app.".to_string())?;
        let inner = &mut *inner;
        let english = inner.english.get_or_insert_with(EnglishG2p::new);

        let (loaded, phonemes, sid) = match engine {
            Engine::Kitten => {
                let dir = sherpa_root.join(KITTEN_DIR);
                if inner.kitten.as_ref().is_none_or(|l| l.dir != dir) {
                    inner.kitten = Some(load(&dir, Engine::Kitten)?);
                }
                let sid = KITTEN_SPEAKERS.iter().position(|s| *s == speaker).unwrap_or(0) as i32;
                (inner.kitten.as_ref().unwrap(), english.ipa(&normalized), sid)
            }
            Engine::Kokoro => {
                let dir = sherpa_root.join(KOKORO_DIR);
                if inner.kokoro.as_ref().is_none_or(|(l, _)| l.dir != dir) {
                    let lexicon = KokoroLexicon::load(&dir.join("lexicon-gb-en.txt"))
                        .map_err(|_| "The Kokoro pack is incomplete. Reinstall it in Settings.".to_string())?;
                    inner.kokoro = Some((load(&dir, Engine::Kokoro)?, lexicon));
                }
                let (loaded, lexicon) = inner.kokoro.as_ref().unwrap();
                let sid = KOKORO_SPEAKERS.iter().find(|(s, _)| *s == speaker).map(|(_, id)| *id).unwrap_or(26);
                (loaded, lexicon.phonemes(&normalized, english), sid)
            }
        };

        let sentences = codepoints(&phonemes, &loaded.vocab);
        if sentences.is_empty() {
            return Err("Nothing to read.".into());
        }
        let config = GenerationConfig {
            sid,
            speed: speed.clamp(0.5, 2.0),
            phoneme_codepoints: Some(sentences),
            ..Default::default()
        };
        let audio = loaded
            .tts
            .generate_with_config("", &config, None::<fn(&[f32], f32) -> bool>)
            .ok_or_else(|| "The voice could not read that text.".to_string())?;
        Ok(wav(audio.samples(), audio.sample_rate() as u32))
    }

    /// Drop a loaded model, e.g. before its pack is removed.
    pub fn unload(&self, engine: Engine) {
        if let Ok(mut inner) = self.inner.lock() {
            match engine {
                Engine::Kitten => inner.kitten = None,
                Engine::Kokoro => inner.kokoro = None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_sentences_and_drops_unknown_symbols() {
        let vocab: HashSet<char> = "abc .?".chars().collect();
        let got = codepoints("ab. cz?", &vocab);
        assert_eq!(got, vec![vec!['a' as i32, 'b' as i32, '.' as i32], vec!['c' as i32, '?' as i32]]);
    }

    /// End-to-end check against real models when `NVR_TEST_SHERPA_ROOT` points
    /// at a folder with the packs installed. Skipped otherwise.
    #[test]
    fn speaks_with_installed_packs() {
        let Ok(root) = std::env::var("NVR_TEST_SHERPA_ROOT") else { return };
        let speech = Speech::default();
        let root = PathBuf::from(root);
        let text = "Gary asked Arjun at 6:30 a.m. whether $4.99, or 3.5%, was fair.";
        for (engine, speaker, dir) in [(Engine::Kitten, "expr-voice-2-m", KITTEN_DIR), (Engine::Kokoro, "bm_george", KOKORO_DIR)] {
            if !root.join(dir).is_dir() {
                continue;
            }
            let bytes = speech.synthesize(&root, engine, speaker, text, 1.0).expect("synthesize");
            assert!(bytes.len() > 44 + 24_000 * 2, "{engine:?} produced too little audio");
            if let Ok(out) = std::env::var("NVR_TEST_WAV_DIR") {
                std::fs::write(format!("{out}/{engine:?}.wav"), &bytes).unwrap();
            }
        }
    }
}
