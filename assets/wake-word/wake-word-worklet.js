// Always-on mic capture for wake-word detection.
//
// Runs on the audio render thread. The AudioContext that loads this worklet is
// forced to 16 kHz (new AudioContext({ sampleRate: 16000 })), so the browser
// resamples the mic to exactly the rate openWakeWord expects and we never touch
// resampling here. We buffer the 128-sample render quanta into fixed 1280-sample
// (80 ms) frames and post each one to the main thread, where the ONNX pipeline
// (mel -> embedding -> wake model) runs. See src/skill-runtime/wake-word.js.
class WakeWordCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = new Float32Array(1280);
    this._n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;                 // mic not delivering this quantum; keep alive
    for (let i = 0; i < ch.length; i++) {
      this._frame[this._n++] = ch[i];
      if (this._n === 1280) {
        // Hand a copy to the main thread; the next quantum reuses _frame.
        this.port.postMessage(this._frame.slice(0));
        this._n = 0;
      }
    }
    return true;                          // never let the node be GC'd while running
  }
}

registerProcessor('wake-word-capture', WakeWordCapture);
