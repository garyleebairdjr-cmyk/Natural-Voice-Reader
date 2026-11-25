# Third-party notices

This file lists the main third-party software and model weights used by
Natural Voice Reader's local voice path. It is not legal advice.

## VoiceStudio (not vendored)

VoiceStudio (https://github.com/debpalash/VoiceStudio) is a separate project
licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). This
repository does not copy VoiceStudio's source. The installer clones a pinned
commit (`scripts/pins.env`) into its own directory and the launcher talks to
it over a local HTTP API.

If you later open-source or distribute this reader:

- VoiceStudio itself stays AGPL-3.0. Anyone who receives or uses a modified
  VoiceStudio over a network must be offered the corresponding source.
- Keeping VoiceStudio as a separate process and a separate repository is
  intentional. Combining the two into one distributed product, or tightly
  linking them into a single program, can bring AGPL obligations to the
  combined work. Get legal advice before shipping a packaged app or a hosted
  service that includes VoiceStudio.
- VoiceStudio also offers a commercial / Pro license if you need to distribute
  a proprietary build without AGPL obligations. That license does not change
  any model-weight terms.

## Model weights

| Component | Source | License | Notes |
| --- | --- | --- | --- |
| KittenTTS mini 0.8 | [KittenML/kitten-tts-mini-0.8](https://huggingface.co/KittenML/kitten-tts-mini-0.8) | Apache-2.0 | Default engine. English-only ONNX model, about 80 MB. Suitable for later on-device / mobile use. |
| OmniVoice | [k2-fsa/OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) | Weights: CC-BY-NC (version not stated on the card). Code around the model is Apache-2.0. The `audio_tokenizer` folder also carries the Boson Higgs Audio 2 Community License and Meta Llama 3 Community License terms. | Optional "Best quality (slow)" engine. Not for paid, client, or monetized work. Several GB. Accept the upstream terms before downloading. |
| OmniVoice tokenizer notices | Boson AI / Meta | Boson Higgs Audio 2 Community License; Meta Llama 3 Community License | Redistribution of those tokenizer files must keep the required copyright notices. Those terms also restrict using outputs to improve other large models and require an expanded license above a large active-user threshold. |
| Kokoro-82M int8 multilingual v1.0 | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via the [sherpa-onnx `kokoro-int8-multi-lang-v1_0`](https://github.com/k2-fsa/sherpa-onnx/releases) pack | Apache-2.0 | Used for Butler (British) and the Indian English voices (Mira, Arjun). Served by a reader-owned helper on `127.0.0.1:3901` because VoiceStudio's sherpa adapter only wires VITS/Piper on this Linux CPU. About 180 MB unpacked. |

Piper `en_GB-alan-medium` was used only as a private comparison sample for the butler search. It is not a product voice: its model card points at Mycroft `apope_low` with a "See URL" license, which is not clear enough to ship.

Installed weights are stored in the per-user data directory (`~/.local/share/nvr` on Linux, `~/Library/Application Support/nvr` on macOS, `%LOCALAPPDATA%\nvr` on Windows), not in the shared Hugging Face cache. `nvr` sets `HF_HOME` only for the processes it launches.

## Other runtime libraries (via VoiceStudio)

These are installed into VoiceStudio's environment, not copied into this repo:

- `kittentts` (KittenML wheel) — Apache-2.0
- ONNX Runtime — MIT
- PyTorch (used by OmniVoice) — BSD-style / PyTorch license
- espeak-ng (phonemizer data used by KittenTTS) — GPL-3.0

Keep their notices if you redistribute those binaries.

## Installed app (src-tauri/)

The packaged app does not use VoiceStudio, Python, or espeak-ng. These parts
are compiled into the app or bundled with it:

| Component | License | How it is used |
| --- | --- | --- |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 2.0 (Rust crate and native library) | Apache-2.0 | Runs the KittenTTS and Kokoro models on the device. Linked statically. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (inside sherpa-onnx) | MIT | Model inference. Linked statically. |
| [piper-plus-g2p](https://github.com/ayutaz/piper-plus) 0.5 | MIT | English text normalization and CMUdict-based pronunciation, without espeak-ng. |
| [CMUdict](https://github.com/cmusphinx/cmudict) (`src-tauri/resources/cmudict.json`, from piper-plus-g2p) | BSD-2-Clause, Copyright (C) 1993-2015 Carnegie Mellon University | Pronunciation dictionary, built into the app. |
| [g2p_en](https://github.com/Kyubyong/g2p) 2.1.0 weights (`src-tauri/resources/g2p_en.bin`, from `checkpoint20.npz`) | Apache-2.0, Copyright Kyubyong Park | Neural pronunciation guesser for words that are not in CMUdict. The model is re-implemented in Rust (`src-tauri/src/speech/neural.rs`); the weights are unchanged, stored as raw float32. |
| [Tauri](https://tauri.app) 2 and its dependencies | MIT / Apache-2.0 | App shell. |

Voice models are downloaded by the app, not bundled, from the sherpa-onnx
`tts-models` release:

| Pack | Archive | License |
| --- | --- | --- |
| KittenTTS (default) | `kitten-mini-en-v0_8.tar.bz2`, converted by sherpa-onnx from KittenML/kitten-tts-mini-0.8 | Apache-2.0 |
| Kokoro | `kokoro-int8-multi-lang-v1_0.tar.bz2` | Apache-2.0 |

OmniVoice is not offered in the app; it needs PyTorch and stays with the
script install.

### CMUdict license

```text
Copyright (C) 1993-2015 Carnegie Mellon University. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
   The contents of this file are deemed to be source code.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in
   the documentation and/or other materials provided with the
   distribution.

This work was supported in part by funding from the Defense Advanced
Research Projects Agency, the Office of Naval Research and the National
Science Foundation of the United States of America, and by member
companies of the Carnegie Mellon Sphinx Speech Consortium. We acknowledge
the contributions of many volunteers to the expansion and improvement of
this dictionary.

THIS SOFTWARE IS PROVIDED BY CARNEGIE MELLON UNIVERSITY ``AS IS'' AND
ANY EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL CARNEGIE MELLON UNIVERSITY
NOR ITS EMPLOYEES BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The Apache-2.0 components above are used under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). This file and `LICENSE` are
installed with the app.
