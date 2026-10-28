// Viewfinder: the live camera on Jibo's screen (jibo.media.setViewfinder).
//
// On the robot the media service drew the camera preview on the display, inside a window
// {x, y, width, height} of the 1280x720 screen, above the skill. robot-os's media service
// has no display, so the dev server passes on what the skill asked for (/robot/viewfinder)
// and the page draws it here: a second <video> playing the webcam's stream inside a
// 1280x720 box, projected onto the screen quad with the same homography as the skill
// iframe and layered above it (so it must be created after the iframe). Mirrored, like the
// frames Jibo's LPS and photographer get (camera/uplink.js). Black while the camera is off.

import { createFaceOverlay } from '../bridge/face-overlay.js';

export function createViewfinder({ viewportEl, mesh, camera, getStream }) {
  const el = document.createElement('div');
  el.id = 'viewfinder';
  el.style.pointerEvents = 'none';
  el.style.overflow = 'hidden';
  el.style.display = 'none';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  Object.assign(video.style, { position: 'absolute', objectFit: 'cover', transform: 'scaleX(-1)', background: '#000' });
  el.appendChild(video);
  viewportEl.appendChild(el);
  const overlay = createFaceOverlay({ viewportEl, element: el, mesh, camera });
  let on = false;
  let rect = { x: 0, y: 0, width: 1280, height: 720 };

  // Follow the webcam being switched on/off (or to another device) while shown.
  function syncStream() {
    const stream = getStream() || null;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      if (stream) video.play().catch(() => {});
    }
  }

  function set({ enable, window: win }) {
    on = !!enable;
    if (!on) {
      el.style.display = 'none';
      video.srcObject = null;
      return;
    }
    const r = rect = win || { x: 0, y: 0, width: 1280, height: 720 };
    Object.assign(video.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    el.style.display = '';
    syncStream();
  }

  function update() {
    if (!on) return;
    syncStream();
    overlay.update();
  }

  // The same picture on a flat canvas (the screen dock): `k` is canvas pixels per face pixel.
  // The <video> and its CSS live outside the skill iframe, so the dock can't copy them.
  function paint(ctx, k) {
    if (!on) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x * k, rect.y * k, rect.width * k, rect.height * k);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.x * k, rect.y * k, rect.width * k, rect.height * k);
    if (video.readyState >= 2 && video.videoWidth) {
      const f = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);   // object-fit: cover
      const w = video.videoWidth * f * k, h = video.videoHeight * f * k;
      ctx.translate((rect.x + rect.width / 2) * k, (rect.y + rect.height / 2) * k);
      ctx.scale(-1, 1);                                                                      // mirrored
      ctx.drawImage(video, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  return { set, update, paint, isOn: () => on };
}
