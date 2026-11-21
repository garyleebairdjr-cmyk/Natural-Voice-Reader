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
| Kokoro-82M int8 multilingual v1.0 | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via the [sherpa-onnx `kokoro-int8-multi-lang-v1_0`](https://github.com/k2-fsa/sherpa-onnx/releases) pack | Apache-2.0 | Used for Butler (British) and the Indian and Japanese English voices. Served by a reader-owned helper on `127.0.0.1:3901` because VoiceStudio's sherpa adapter only wires VITS/Piper on this Linux CPU. About 180 MB unpacked. |

Piper `en_GB-alan-medium` was used only as a private comparison sample for the butler search. It is not a product voice: its model card points at Mycroft `apope_low` with a "See URL" license, which is not clear enough to ship.


## Other runtime libraries (via VoiceStudio)

These are installed into VoiceStudio's environment, not copied into this repo:

- `kittentts` (KittenML wheel) — Apache-2.0
- ONNX Runtime — MIT
- PyTorch (used by OmniVoice) — BSD-style / PyTorch license
- espeak-ng (phonemizer data used by KittenTTS) — GPL-3.0

Keep their notices if you redistribute those binaries.
