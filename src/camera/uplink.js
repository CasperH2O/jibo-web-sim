// Camera uplink: the webcam's frames to robot-os, where Jibo's own LPS sees them.
//
// The dev server relays robot-os's camera feed at /robot/camera. Each binary message is
// one JPEG, 1280x720 (the frame size the LPS reads), cover-cropped to 16:9 and mirrored
// like a selfie view: that is how the robot's cameras delivered frames to the LPS, whose
// camera model puts the right of the image on Jibo's left. robot-os answers about once a
// second with {type: 'stats', written, dropped, fps, decodeMs, ...}.
//
// JPEG, not raw pixels: a raw 1280x720 frame is 2.7 MB, too much for the Windows -> WSL
// localhost relay at 10 fps. No frame is queued: a tick that comes while the previous
// frame is still being encoded starts the next one as soon as that finishes (encoding can
// take longer than the interval), and a frame is skipped while the socket is backed up.

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
const SEND_INTERVAL_MS = 100;            // 10 fps, what the LPS's cameras read
const JPEG_QUALITY = 0.92;
const MAX_BUFFERED_BYTES = 1e6;
const RATE_WINDOW_MS = 2000;

export function createCameraUplink({ video, onStatus = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(-1, 0, 0, 1, FRAME_WIDTH, 0);   // mirror
  let socket = null;
  let active = false;
  let encoding = false;
  let due = false;            // a tick came while encoding
  let timer = 0;
  let retry = 0;
  let remote = null;          // robot-os's last stats message
  let error = '';
  const sentTimes = [];

  function status() {
    const now = performance.now();
    while (sentTimes.length && now - sentTimes[0] > RATE_WINDOW_MS) sentTimes.shift();
    return {
      connected: !!socket && socket.readyState === WebSocket.OPEN,
      sentFps: sentTimes.length / (RATE_WINDOW_MS / 1000),
      remote,
      error,
    };
  }

  function sendFrame() {
    if (encoding) { due = true; return; }
    due = false;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    const s = Math.max(FRAME_WIDTH / vw, FRAME_HEIGHT / vh);
    const sw = FRAME_WIDTH / s, sh = FRAME_HEIGHT / s;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    encoding = true;
    canvas.toBlob(async (blob) => {
      try {
        if (!blob || !socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(await blob.arrayBuffer());
        sentTimes.push(performance.now());
      } finally {
        encoding = false;
        if (due && active) sendFrame();
      }
    }, 'image/jpeg', JPEG_QUALITY);
  }

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/robot/camera`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { error = ''; onStatus(status()); };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'stats') remote = msg;
      } catch (_) { /* not JSON */ }
      onStatus(status());
    };
    socket.onclose = (ev) => {
      socket = null;
      remote = null;
      if (!active) return;
      error = `robot-os camera feed not reachable${ev.reason ? ` (${ev.reason})` : ''}`;
      onStatus(status());
      retry = setTimeout(connect, 2000);
    };
  }

  return {
    status,
    start() {
      if (active) return;
      active = true;
      error = '';
      connect();
      timer = setInterval(sendFrame, SEND_INTERVAL_MS);
    },
    stop() {
      if (!active) return;
      active = false;
      due = false;
      clearInterval(timer);
      clearTimeout(retry);
      if (socket) { try { socket.close(); } catch (_) { /* closed */ } }
      socket = null;
      remote = null;
      sentTimes.length = 0;
    },
    isActive: () => active,
  };
}
