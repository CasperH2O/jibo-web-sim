// Smoke test for the viewfinder layer of the screen dock (robot-os branch).
//
// The viewfinder (the webcam preview Jibo's media service puts on the screen) is a <video>
// the host draws over the skill iframe, so the dock can't copy it from the iframe; it asks
// the viewfinder to paint itself (viewfinder.paint). This drives the real viewfinder.js
// with a synthetic camera stream (left half red, right half blue, 4:1) and checks the
// painted result: mirrored like the 3D screen, cropped like object-fit: cover, clipped to
// the window the skill asked for, black while the camera is off, absent once disabled.
//
// Usage: node test/screen-dock-viewfinder-smoke.mjs   (sim server must be on :8080, or SIM_URL)

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

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  timeout: 60000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => { console.log(`[pageerror] ${e.message}`); failed++; });
await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#viewport');

const r = await page.evaluate(async () => {
  const THREE = await import('three');
  const { createViewfinder } = await import('/src/ui/viewfinder.js');

  // A camera feed: left half red, right half blue, 400x100 (wider than the window, so cover crops sides).
  const feed = document.createElement('canvas');
  feed.width = 400; feed.height = 100;
  const fctx = feed.getContext('2d');
  const drawFeed = () => { fctx.fillStyle = '#f00'; fctx.fillRect(0, 0, 200, 100); fctx.fillStyle = '#00f'; fctx.fillRect(200, 0, 200, 100); };
  drawFeed();
  const stream = feed.captureStream(30);
  const timer = setInterval(drawFeed, 33);

  let current = null;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;width:800px;height:450px;left:0;top:0';
  document.body.appendChild(host);
  const vf = createViewfinder({
    viewportEl: host,
    mesh: new THREE.Mesh(new THREE.PlaneGeometry(1, 1)),
    camera: new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 100),
    getStream: () => current,
  });

  const out = document.createElement('canvas');
  out.width = 640; out.height = 360;                       // k = 0.5 face -> canvas
  const octx = out.getContext('2d');
  const k = 0.5;
  const px = (x, y) => Array.from(octx.getImageData(x, y, 1, 1).data);
  const painted = () => { octx.clearRect(0, 0, out.width, out.height); vf.paint(octx, k); };
  const results = {};
  const win = { x: 640, y: 360, width: 640, height: 360 };  // bottom-right quarter -> canvas (320,180)-(640,360)

  // Camera off: window is black, nothing outside it.
  vf.set({ enable: true, window: win });
  painted();
  results.blackInside = px(480, 270);
  results.nothingOutside = px(50, 50);

  // Camera on.
  current = stream;
  vf.update();
  for (let i = 0; i < 100; i++) {
    await new Promise((res) => setTimeout(res, 50));
    vf.update();
    if (host.querySelector('video').readyState >= 2) break;
  }
  painted();
  results.leftOfWindow = px(320 + 60, 270);                // mirrored: source blue appears on the left
  results.rightOfWindow = px(320 + 260, 270);              // source red appears on the right
  results.outsideWindow = px(300, 270);                    // just left of the window

  // Disabled: nothing at all.
  vf.set({ enable: false });
  painted();
  results.disabledInside = px(480, 270);

  clearInterval(timer);
  return results;
});

const is = (p, [R, G, B, A]) => Math.abs(p[0] - R) < 12 && Math.abs(p[1] - G) < 12 && Math.abs(p[2] - B) < 12 && Math.abs(p[3] - A) < 12;
check(is(r.blackInside, [0, 0, 0, 255]), `camera off: window is black (${r.blackInside})`);
check(r.nothingOutside[3] === 0, 'camera off: nothing outside the window');
check(is(r.leftOfWindow, [0, 0, 255, 255]), `camera on: feed is mirrored: source blue on the left (${r.leftOfWindow})`);
check(is(r.rightOfWindow, [255, 0, 0, 255]), `camera on: feed is mirrored: source red on the right (${r.rightOfWindow})`);
check(r.outsideWindow[3] === 0, 'camera on: clipped to the requested window');
check(r.disabledInside[3] === 0, 'viewfinder disabled: paints nothing');

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
