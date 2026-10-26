// Webcam capture: the sim's stand-in for Jibo's head cameras.
//
// Wraps getUserMedia around a single <video> element. The element is owned
// here and handed to the Camera tab for its preview, so the uplink and the
// preview read the same frames. getUserMedia needs a secure context
// (http://localhost or https://), same as the mic.

export function createWebcam() {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  let stream = null;

  function available() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // Resolves once frames are flowing. `deviceId` picks a specific camera;
  // otherwise the browser's default (user-facing) one. 1280x720 is the size
  // of the frames robot-os's LPS reads; other sizes are cropped and scaled.
  async function start(deviceId) {
    stop();
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId ? { ...size, deviceId: { exact: deviceId } } : { ...size, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();
  }

  function stop() {
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
  }

  // Video inputs; labels are only filled in after camera permission is granted.
  async function listDevices() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  }

  function currentDeviceId() {
    const track = stream && stream.getVideoTracks()[0];
    return track ? track.getSettings().deviceId || null : null;
  }

  return {
    video,
    available,
    start,
    stop,
    listDevices,
    currentDeviceId,
    isActive: () => !!stream,
  };
}
