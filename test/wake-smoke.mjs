// Smoke test for the "Hey Jibo" wake-word pipeline.
//
// This box's headless Chrome exposes no audio devices, so we shim getUserMedia
// to a WebAudio-synthesized stream (same trick as phoenix-voice-browser.mjs):
// 600 ms silence -> 1.2 s 440 Hz tone -> silence. Everything downstream is real:
// our 16 kHz AudioContext, the capture worklet, and the openWakeWord ONNX chain
// (mel -> embedding -> wake model) run live via onnxruntime-web.
//
// We drive src/skill-runtime/wake-word.js directly (no full jibo-be boot needed)
// with threshold raised so the tone never "detects", and observe onScore to
// prove the pipeline produces real, in-range scores every frame.
//
// Usage: node test/wake-smoke.mjs   (sim server must be on :8080)

import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';

const base = process.env.SIM_URL || 'http://localhost:8080';

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  timeout: 60000,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-capture', '--use-fake-device-for-media-capture',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();
const log = [];
const push = (s) => { log.push(s); process.stdout.write(s + '\n'); };
page.on('console', (m) => { const t = m.text(); if (/wake-word|\[smoke\]|onnx|ort/i.test(t)) push(`[${m.type()}] ${t}`); });
page.on('pageerror', (e) => push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400 && /wake-word/.test(r.url())) push(`[${r.status()}] ${r.url()}`); });

// Synthesize a mic stream so getUserMedia resolves with no real audio device.
await page.evaluateOnNewDocument(() => {
  try {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, Math.floor(sr * 3.8), sr);
      const d = buf.getChannelData(0);
      const t0 = Math.floor(sr * 0.6), t1 = Math.floor(sr * 1.8);
      for (let i = t0; i < t1; i++) d[i] = 0.7 * Math.sin(2 * Math.PI * 440 * (i - t0) / sr);
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest); src.start();
      return dest.stream;
    };
  } catch (e) { console.warn('[smoke] gum shim failed', e.message); }
});

let result = {};
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Drive the detector module directly; the page's importmap resolves
  // 'onnxruntime-web' for the dynamic import just as it does for main.js.
  await page.evaluate(async () => {
    const { createWakeWord } = await import('/src/skill-runtime/wake-word.js');
    window.__scores = []; window.__status = [];
    const w = createWakeWord({
      threshold: 2,        // unreachable -> never fires; we only watch onScore
      onStatus: (s) => { window.__status.push(typeof s === 'string' ? s : JSON.stringify(s)); console.log('[smoke] status', JSON.stringify(s)); },
      onScore: (v) => window.__scores.push(v),
    });
    await w.start();
  });
  await new Promise((r) => setTimeout(r, 14000));   // models load (~few s) then frames flow
  result = await page.evaluate(() => {
    const s = window.__scores || [];
    return {
      status: window.__status || [],
      frames: s.length,
      allFinite: s.every((x) => Number.isFinite(x)),
      inRange: s.every((x) => x >= 0 && x <= 1),
      min: s.length ? Math.min(...s) : null,
      max: s.length ? Math.max(...s) : null,
    };
  });
} catch (e) {
  push(`[FAIL] ${e.message}`);
} finally {
  const blob = log.join('\n');
  const checks = {
    listening: (result.status || []).includes('listening'),
    framesProduced: (result.frames || 0) > 0,
    scoresFinite: !!result.allFinite,
    scoresInRange: !!result.inRange,
    noPageErrors: !/\[pageerror\]/.test(blob),
    noStartFailure: !/failed to start/.test(blob),
  };
  console.log('\n===== RESULT =====');
  console.log(JSON.stringify({ ...checks, frames: result.frames, scoreRange: [result.min, result.max] }, null, 2));
  console.log(Object.values(checks).every(Boolean) ? 'PASS ✅' : 'CHECK ⚠️');
  await browser.close();
}
