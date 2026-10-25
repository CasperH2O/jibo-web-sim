// Drives the viewport rig from robot-os (the robot backend that runs Jibo's real
// expression service). The dev server relays robot-os's state hub at /robot/state:
//   {t, axes: {pelvis, torso, neck: {pos, vel}}, led: [r, g, b]}   ~30 Hz
// pelvis/torso/neck are bottomSection_r/middleSection_r/topSection_r. Frames are
// extrapolated with the reported velocity for up to one frame interval, so the
// rig moves smoothly at the display rate.

const AXIS_DOFS = { pelvis: 'bottomSection_r', torso: 'middleSection_r', neck: 'topSection_r' };
const MAX_EXTRAPOLATE_S = 0.05;

export function createRobotStateDriver({ rig }) {
  let socket = null;
  let active = false;
  let frame = null;
  let frameAt = 0;
  let retry = 0;

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/robot/state`;
    socket = new WebSocket(url);
    socket.onmessage = (ev) => {
      try { frame = JSON.parse(ev.data); frameAt = performance.now(); } catch (_) { /* not JSON */ }
    };
    socket.onclose = () => {
      socket = null;
      if (active) retry = setTimeout(connect, 1000);
    };
  }

  return {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      frame = null;
      connect();
    },
    stop() {
      active = false;
      clearTimeout(retry);
      if (socket) { try { socket.close(); } catch (_) { /* closed */ } }
      socket = null;
    },
    // Per render frame.
    update() {
      if (!active || !frame) return;
      const dt = Math.min((performance.now() - frameAt) / 1000, MAX_EXTRAPOLATE_S);
      for (const [axis, dof] of Object.entries(AXIS_DOFS)) {
        const a = frame.axes[axis];
        if (a) rig.setDof(dof, a.pos + a.vel * dt);
      }
      if (Array.isArray(frame.led) && rig.setLEDColor) rig.setLEDColor(frame.led[0], frame.led[1], frame.led[2]);
    },
  };
}
