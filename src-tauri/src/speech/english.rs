//! English text to espeak-style IPA, without espeak-ng.
//!
//! Words are read from CMUdict through piper-plus-g2p (MIT), which also
//! handles stress and common suffixes. Words that are still unknown (names,
//! new coinages) are guessed by the g2p_en neural model and added to the
//! dictionary, instead of being spelled out letter by letter. Short all-caps
//! words and CamelCase brand names are left to piper-plus-g2p, which spells
//! acronyms and splits CamelCase.

use std::collections::HashMap;
use std::sync::LazyLock;

use piper_plus_g2p::english::EnglishPhonemizer;
use piper_plus_g2p::Phonemizer;
use regex::Regex;

use super::neural::G2pNet;

static CMUDICT_JSON: &[u8] = include_bytes!("../../resources/cmudict.json");
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z][A-Za-z']*").unwrap());

pub struct EnglishG2p {
    dict: HashMap<String, String>,
    learned: HashMap<String, String>,
    phonemizer: EnglishPhonemizer,
    net: G2pNet,
}

fn is_acronym(word: &str) -> bool {
    word.len() <= 5 && word.chars().all(|c| c.is_ascii_uppercase())
}

fn is_camel_case(word: &str) -> bool {
    word.chars().skip(1).any(|c| c.is_ascii_uppercase())
}

impl EnglishG2p {
    pub fn new() -> Self {
        let dict: HashMap<String, String> =
            serde_json::from_slice(CMUDICT_JSON).expect("bundled CMUdict is valid JSON");
        let phonemizer = EnglishPhonemizer::new_with_hashmap(dict.clone());
        Self { dict, learned: HashMap::new(), phonemizer, net: G2pNet::load() }
    }

    /// True when the dictionary has the word or, like piper-plus-g2p's
    /// fallback, its stem with a common suffix removed.
    fn known(&self, w: &str) -> bool {
        let has = |s: &str| self.dict.contains_key(s) || self.learned.contains_key(s);
        if has(w) {
            return true;
        }
        for suffix in ["ing", "ed", "es", "s", "er", "ly", "est"] {
            let Some(base) = w.strip_suffix(suffix) else { continue };
            if base.len() < 2 {
                continue;
            }
            let doubled = base.len() > 2 && base.as_bytes()[base.len() - 1] == base.as_bytes()[base.len() - 2];
            if has(base)
                || has(&format!("{base}e"))
                || (doubled && has(&base[..base.len() - 1]))
                || base.strip_suffix('i').is_some_and(|b| has(&format!("{b}y")))
            {
                return true;
            }
        }
        false
    }

    /// Guess and remember pronunciations for unknown words in `text`.
    fn learn(&mut self, text: &str) {
        let mut added = false;
        for m in WORD.find_iter(text) {
            let raw = m.as_str().trim_end_matches('\'');
            if raw.len() < 2 || is_acronym(raw) || is_camel_case(raw) {
                continue;
            }
            let word = raw.to_ascii_lowercase().replace('\'', "");
            if self.known(&raw.to_ascii_lowercase()) || self.known(&word) {
                continue;
            }
            let arpa = self.net.predict(&word);
            if !arpa.is_empty() {
                self.learned.insert(word, arpa.join(" "));
                added = true;
            }
        }
        if added {
            let mut dict = self.dict.clone();
            dict.extend(self.learned.iter().map(|(k, v)| (k.clone(), v.clone())));
            self.phonemizer = EnglishPhonemizer::new_with_hashmap(dict);
        }
    }

    /// IPA for already-normalized text, e.g. "hello world." -> "həlˈoʊ wˈɜːld."
    pub fn ipa(&mut self, normalized: &str) -> String {
        self.learn(normalized);
        match self.phonemizer.phonemize_with_prosody(normalized) {
            Ok((tokens, _)) => tokens.concat(),
            Err(_) => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_word() {
        let mut g2p = EnglishG2p::new();
        let ipa = g2p.ipa("Gary asked Arjun or Zorblax.");
        // Unknown names are guessed, not spelled letter by letter ("ˈeɪˈɑːɹ...").
        assert!(!ipa.contains("ˈeɪˈɑːɹdʒˈeɪ"), "{ipa}");
        assert!(ipa.contains("ɔːɹ") || ipa.contains("ɔɹ"), "'or' should be read: {ipa}");
        assert!(ipa.starts_with("ɡˈɛɹ"), "{ipa}");
        // Acronyms are still spelled.
        let nasa = g2p.ipa("The FBI said.");
        assert!(nasa.contains("ˈɛf"), "{nasa}");
    }
}
