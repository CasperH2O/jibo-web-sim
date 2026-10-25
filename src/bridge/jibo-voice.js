// Jibo's real voice, played in the host window.
//
// robot-os runs the robot's own TTS service (robot-os/tts.mjs); server.js relays it at
// /robot/tts/. POST /robot/tts/tts_speak takes the robot's speak request and answers with
// the audio as it is synthesised: raw PCM, s16le mono 48 kHz (audio/L16). The service
// produces it at roughly real time, so playback starts after a short buffer and later
// chunks are queued back to back. speak() resolves once the last sample has played, which
// is when the robot's /tts_speak would have returned.

const SAMPLE_RATE = 48000;
// The service (emulated) synthesises at about real time when it has a CPU core to itself,
// so delivery can fall behind playback on a busy machine.
const PREBUFFER_S = 0.35;    // audio held back before starting, to ride out uneven delivery
const UNDERRUN_PAD_S = 0.15; // slack added when the queue runs dry; doubles on each repeat

// Is the bridge up? Resolves to its /status or null.
export async function probeJiboVoice() {
  try {
    const res = await fetch('/robot/tts/status', { cache: 'no-store' });
    const status = await res.json();
    return res.ok && status.ok ? status : null;
  } catch (_) {
    return null;
  }
}

export function createJiboVoice() {
  let ctx = null;
  let current = null;   // { abort, sources }

  function audioContext() {
    // Created on first use: by then the Start Jibo click has given the page user activation.
    if (!ctx) ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function stop() {
    if (!current) return;
    const { abort, sources } = current;
    current = null;
    abort.abort();
    for (const src of sources) { try { src.stop(); } catch (_) { /* not started */ } }
  }

  // request: the robot's /tts_speak body ({prompt, locale, voice, mode, ...}). Rejects only
  // when the voice is unavailable; stop() makes it resolve early.
  async function speak(request) {
    stop();
    const abort = new AbortController();
    const job = { abort, sources: new Set() };
    current = job;
    try {
      await play(request, job);
    } catch (e) {
      if (!abort.signal.aborted) throw e;
    } finally {
      if (current === job) current = null;
    }
  }

  async function play(request, job) {
    const audio = audioContext();
    const { abort, sources } = job;
    const res = await fetch('/robot/tts/tts_speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
    if (res.status === 204) return;                          // nothing to say
    if (!res.ok) throw new Error(`robot-os TTS answered ${res.status}: ${await res.text()}`);

    let nextAt = 0;        // AudioContext time where the next chunk starts
    let started = false;
    let held = [];         // chunks buffered before playback starts
    let heldSeconds = 0;
    let carry = null;      // odd trailing byte from the previous network chunk
    let lastSource = null;
    let underruns = 0;

    const schedule = (samples) => {
      const buffer = audio.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);
      const src = audio.createBufferSource();
      src.buffer = buffer;
      src.connect(audio.destination);
      if (nextAt < audio.currentTime + 0.02) {
        // Ran dry: one longer pause beats a stutter on every chunk.
        nextAt = audio.currentTime + 0.02 + (started ? UNDERRUN_PAD_S * 2 ** underruns++ : 0);
      }
      src.start(nextAt);
      nextAt += buffer.duration;
      sources.add(src);
      src.onended = () => sources.delete(src);
      lastSource = src;
      started = true;
    };

    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || current !== job) break;
      let bytes = carry ? concat(carry, value) : value;
      carry = bytes.length % 2 ? bytes.slice(bytes.length - 1) : null;
      if (carry) bytes = bytes.subarray(0, bytes.length - 1);
      if (!bytes.length) continue;
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
      if (started) { schedule(samples); continue; }
      held.push(samples);
      heldSeconds += samples.length / SAMPLE_RATE;
      if (heldSeconds >= PREBUFFER_S) { for (const s of held) schedule(s); held = []; }
    }
    if (current !== job) return;                              // stopped
    for (const s of held) schedule(s);
    if (!lastSource) return;
    // Wait for the last chunk to finish, bounded by wall-clock time in case the
    // AudioContext never runs (no user activation): then the queue still moves on.
    const remainingMs = (nextAt - audio.currentTime) * 1000 + 2000;
    await new Promise((resolve) => {
      lastSource.addEventListener('ended', resolve, { once: true });
      setTimeout(resolve, remainingMs);
    });
  }

  return { speak, stop };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
