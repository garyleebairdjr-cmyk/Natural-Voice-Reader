//! Neural pronunciation guesser for words that are not in the dictionary.
//!
//! A direct port of the GRU encoder-decoder in g2p_en 2.1.0
//! (https://github.com/Kyubyong/g2p, Apache-2.0). The weights are
//! `checkpoint20.npz` from that package, stored as raw little-endian f32 in
//! `resources/g2p_en.bin` (see THIRD_PARTY.md). Output is ARPAbet with
//! stress digits, the same notation as CMUdict.

const GRAPHEMES: &str = "abcdefghijklmnopqrstuvwxyz";
const PHONEMES: [&str; 74] = [
    "<pad>", "<unk>", "<s>", "</s>", "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1",
    "AO2", "AW0", "AW1", "AW2", "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2",
    "EY0", "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG",
    "OW0", "OW1", "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2", "UW", "UW0",
    "UW1", "UW2", "V", "W", "Y", "Z", "ZH",
];
const EMB: usize = 256;
const HID: usize = 256;
const N_G: usize = 29; // <pad>, <unk>, </s>, a-z
const N_P: usize = PHONEMES.len();
const MAX_STEPS: usize = 20;

static WEIGHTS: &[u8] = include_bytes!("../../resources/g2p_en.bin");

struct Gru {
    w_ih: Vec<f32>, // (3*HID, EMB)
    w_hh: Vec<f32>, // (3*HID, HID)
    b_ih: Vec<f32>,
    b_hh: Vec<f32>,
}

pub struct G2pNet {
    enc_emb: Vec<f32>, // (N_G, EMB)
    enc: Gru,
    dec_emb: Vec<f32>, // (N_P, EMB)
    dec: Gru,
    fc_w: Vec<f32>, // (N_P, HID)
    fc_b: Vec<f32>,
}

fn matvec(w: &[f32], x: &[f32], b: &[f32], out: &mut [f32]) {
    let cols = x.len();
    for (i, o) in out.iter_mut().enumerate() {
        let row = &w[i * cols..(i + 1) * cols];
        *o = b[i] + row.iter().zip(x).map(|(a, b)| a * b).sum::<f32>();
    }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

impl Gru {
    /// One GRU step, gate order r, z, n as in PyTorch and g2p_en.
    fn step(&self, x: &[f32], h: &mut [f32]) {
        let mut gi = vec![0.0; 3 * HID];
        let mut gh = vec![0.0; 3 * HID];
        matvec(&self.w_ih, x, &self.b_ih, &mut gi);
        matvec(&self.w_hh, h, &self.b_hh, &mut gh);
        for j in 0..HID {
            let r = sigmoid(gi[j] + gh[j]);
            let z = sigmoid(gi[HID + j] + gh[HID + j]);
            let n = (gi[2 * HID + j] + r * gh[2 * HID + j]).tanh();
            h[j] = (1.0 - z) * n + z * h[j];
        }
    }
}

impl G2pNet {
    pub fn load() -> Self {
        let mut floats = WEIGHTS
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        let mut take = |n: usize| -> Vec<f32> { floats.by_ref().take(n).collect() };
        let enc_emb = take(N_G * EMB);
        let enc = Gru { w_ih: take(3 * HID * EMB), w_hh: take(3 * HID * HID), b_ih: take(3 * HID), b_hh: take(3 * HID) };
        let dec_emb = take(N_P * EMB);
        let dec = Gru { w_ih: take(3 * HID * EMB), w_hh: take(3 * HID * HID), b_ih: take(3 * HID), b_hh: take(3 * HID) };
        let fc_w = take(N_P * HID);
        let fc_b = take(N_P);
        assert_eq!(fc_b.len(), N_P, "g2p_en.bin is truncated");
        Self { enc_emb, enc, dec_emb, dec, fc_w, fc_b }
    }

    /// ARPAbet for a lowercase word, e.g. "zorblax" -> ["Z", "AO1", "R", ...].
    pub fn predict(&self, word: &str) -> Vec<&'static str> {
        let mut h = vec![0.0f32; HID];
        let ids = word
            .chars()
            .map(|c| GRAPHEMES.find(c).map(|i| i + 3).unwrap_or(1))
            .chain(std::iter::once(2)); // </s>
        for id in ids {
            self.enc.step(&self.enc_emb[id * EMB..(id + 1) * EMB], &mut h);
        }
        let mut out = Vec::new();
        let mut prev = 2; // <s>
        let mut logits = vec![0.0f32; N_P];
        for _ in 0..MAX_STEPS {
            self.dec.step(&self.dec_emb[prev * EMB..(prev + 1) * EMB], &mut h);
            matvec(&self.fc_w, &h, &self.fc_b, &mut logits);
            let best = logits
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, _)| i)
                .unwrap_or(3);
            if best == 3 {
                break;
            }
            out.push(PHONEMES[best]);
            prev = best;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_python_reference() {
        // Expected values come from running g2p_en's own algorithm on the same weights.
        let net = G2pNet::load();
        assert_eq!(net.predict("hello").join(" "), "HH EH1 L OW0");
        assert_eq!(net.predict("cat").join(" "), "K AE1 T");
        assert_eq!(net.predict("zorblax").join(" "), "Z AO1 R B AH0 L K S");
        assert_eq!(net.predict("arjun").join(" "), "AA1 R JH AH0 N");
    }
}
