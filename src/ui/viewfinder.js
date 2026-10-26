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
    const r = win || { x: 0, y: 0, width: 1280, height: 720 };
    Object.assign(video.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    el.style.display = '';
    syncStream();
  }

  function update() {
    if (!on) return;
    syncStream();
    overlay.update();
  }

  return { set, update, isOn: () => on };
}
