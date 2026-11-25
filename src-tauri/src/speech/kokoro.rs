//! Phonemes for Kokoro voices (Butler, Mira, Arjun).
//!
//! Kokoro uses misaki-style IPA, where diphthongs are single letters
//! (A = eɪ, I = aɪ, Q = əʊ, W = aʊ, Y = ɔɪ) and dʒ/tʃ are ʤ/ʧ. Words come
//! from the pack's British lexicon so the accent stays British; anything
//! missing goes through the English pipeline and is converted, with the
//! r dropped where British English does not say it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use super::english::EnglishG2p;

static PIECE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z][A-Za-z'-]*|[.,!?;:—…]").unwrap());

pub struct KokoroLexicon {
    words: HashMap<String, String>,
}

const VOWELS: &str = "aeiouæɐɑɒɔəɚɛɜɪʊʌAIOQWYᵊ";

/// Espeak-style US IPA to Kokoro's British symbols.
pub fn to_kokoro_gb(ipa: &str) -> String {
    let mut s = ipa.to_string();
    for (from, to) in [
        ("ɑːɹ", "ɑː"),
        ("ɔːɹ", "ɔː"),
        ("ɪɹ", "ɪə"),
        ("ɛɹ", "ɛə"),
        ("ʊɹ", "ʊə"),
        ("ɜːɹ", "ɜː"),
        ("ɚ", "ə"),
        ("eɪ", "A"),
        ("aɪ", "I"),
        ("oʊ", "Q"),
        ("aʊ", "W"),
        ("ɔɪ", "Y"),
        ("dʒ", "ʤ"),
        ("tʃ", "ʧ"),
        ("ɾ", "t"),
    ] {
        s = s.replace(from, to);
    }
    // Non-rhotic: keep ɹ only before a vowel (stress marks skipped).
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == 'ɹ' {
            let next = chars[i + 1..].iter().find(|c| !matches!(c, 'ˈ' | 'ˌ' | 'ː'));
            if !next.is_some_and(|n| VOWELS.contains(*n)) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

impl KokoroLexicon {
    /// Load `lexicon-gb-en.txt` ("word p h o n e s" per line).
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        let words = text
            .lines()
            .filter_map(|line| {
                let (word, phones) = line.split_once(' ')?;
                Some((word.to_lowercase(), phones.split_whitespace().collect::<String>()))
            })
            .collect();
        Ok(Self { words })
    }

    /// Kokoro phonemes for normalized text.
    pub fn phonemes(&self, normalized: &str, english: &mut EnglishG2p) -> String {
        let mut out = String::new();
        for m in PIECE.find_iter(normalized) {
            let piece = m.as_str();
            if piece.chars().next().is_some_and(|c| !c.is_alphabetic()) {
                out.push_str(piece);
                out.push(' ');
                continue;
            }
            let lower = piece.to_lowercase();
            let found = self.words.get(&lower).or_else(|| self.words.get(&lower.replace('\'', "")));
            match found {
                Some(phones) => out.push_str(phones),
                None => out.push_str(&to_kokoro_gb(english.ipa(piece).trim_end_matches(['.', ' ']))),
            }
            out.push(' ');
        }
        // Punctuation attaches to the word before it.
        out.replace(" .", ".").replace(" ,", ",").replace(" !", "!").replace(" ?", "?").replace(" ;", ";").replace(" :", ":").trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_to_british_kokoro_symbols() {
        assert_eq!(to_kokoro_gb("həlˈoʊ"), "həlˈQ");
        assert_eq!(to_kokoro_gb("kˈɑːɹ"), "kˈɑː");
        assert_eq!(to_kokoro_gb("wˈɔːɾɚ"), "wˈɔːtə");
        assert_eq!(to_kokoro_gb("ɹˈɛd"), "ɹˈɛd");
        assert_eq!(to_kokoro_gb("dʒˈʌdʒ"), "ʤˈʌʤ");
    }
}
