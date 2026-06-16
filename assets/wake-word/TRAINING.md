# Training the "Hey Jibo" wake word

The wake-word pipeline (`src/skill-runtime/wake-word.js`) is a browser port of
[openWakeWord](https://github.com/dscripka/openWakeWord). Three ONNX models chain
together; only the **last** one is phrase-specific:

| File | Role | Phrase-specific? |
|------|------|------------------|
| `melspectrogram.onnx` | raw 16 kHz audio → 32-bin mel frames | no (shared) |
| `embedding_model.onnx` | mel frames → 96-dim speech embeddings | no (shared) |
| `hey_jibo.onnx` | embeddings → detection score | **yes — you train this** |
| `hey_jarvis_v0.1.onnx` | stock fallback so the pipeline runs today | — |

The loader tries `hey_jibo.onnx` first and falls back to `hey_jarvis_v0.1.onnx`,
so dropping a trained `hey_jibo.onnx` into this folder switches the wake phrase
with no code change.

## How to produce `hey_jibo.onnx`

openWakeWord trains entirely on **synthetic** speech — you don't record your own
voice. The whole thing runs in a free Google Colab in well under an hour:

1. Open the official notebook:
   <https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb>
2. Set the target phrase to `hey jibo` (also add close variants like
   `hey gibo`, `hey jeebo` so TTS pronunciation spread is covered).
3. Run all cells. It generates several thousand synthetic positive clips, mixes
   in openWakeWord's negative/background data, and trains a small head on top of
   the frozen shared feature extractor.
4. Download the resulting `.onnx`, rename it to **`hey_jibo.onnx`**, and drop it
   in this directory (`assets/wake-word/`).
5. Reload the sim and toggle **🎤 "Hey Jibo"** in the topbar.

## Tuning

- **Threshold** — `createWakeWord({ threshold })` in `main.js` (default `0.5`).
  Raise toward `0.7` if it false-fires; lower toward `0.4` if it misses you.
- **Cooldown** — `cooldownMs` (default `1500`) is the minimum gap between fires.
- Watch the browser console: every detection logs its score, which is the
  fastest way to pick a threshold for your room/mic.

## Notes / known limitations

- The detector keeps its own always-on mic stream, separate from the voice-turn
  capture inside the skill iframe. Two concurrent captures of one device is fine.
- Echo: the mic stays open while Jibo speaks (SpeechSynthesis). Jibo won't say
  "hey jibo", so self-triggering is unlikely, but pausing detection during TTS
  is a reasonable future hardening step.
- Requires a secure context (https or `http://localhost`) for mic access — same
  constraint as the voice-turn mic button.
