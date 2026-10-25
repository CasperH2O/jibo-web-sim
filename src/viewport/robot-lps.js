// Sends the LPS tab's look-at target to robot-os (the robot backend that runs Jibo's real
// expression service) as one simulated LPS entity, so the real attention manager turns the
// head toward it. The dev server relays robot-os's state hub at /robot/lps:
//   {type: 'target', id, x, y, z} | {type: 'remove', id}
// in metres, robot frame: x forward, y left, z up. robot-os keeps a target visible until it
// is removed, and removes it when this socket closes.
//
// The robot frame is the rig root's local frame (jibo.js mounts the Z-up skeleton under a
// wrapper rotated -90 deg about X), so a scene point maps to (x, -z, y).

import * as THREE from 'three';

const SEND_INTERVAL_MS = 100;   // a followed camera moves every frame; send at most 10 Hz
const MIN_MOVE_M = 0.001;

export function createRobotLpsLink({ rig }) {
  // One entity per page; random so two open tabs do not remove each other's target.
  const id = 1000 + Math.floor(Math.random() * 1e6);
  let socket = null;
  let active = false;
  let retry = 0;
  let target = null;      // robot-frame {x, y, z} | null
  let sent = null;        // what robot-os has, as far as we know
  let sentAt = 0;
  let timer = 0;

  const local = new THREE.Vector3();
  function toRobotFrame(p) {
    rig.root.updateMatrixWorld();
    rig.root.worldToLocal(local.set(p.x, p.y, p.z));
    return { x: local.x, y: local.y, z: local.z };
  }

  function send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  // Bring robot-os up to date with `target`, at most every SEND_INTERVAL_MS.
  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (!active) return;
    if (!target) {
      if (sent && send({ type: 'remove', id })) sent = null;
      return;
    }
    if (sent && Math.max(Math.abs(target.x - sent.x), Math.abs(target.y - sent.y), Math.abs(target.z - sent.z)) < MIN_MOVE_M) return;
    const wait = sentAt + SEND_INTERVAL_MS - performance.now();
    if (wait > 0) { timer = setTimeout(flush, wait); return; }
    if (send({ type: 'target', id, ...target })) { sent = target; sentAt = performance.now(); }
  }

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/robot/lps`);
    socket.onopen = () => { sent = null; flush(); };
    socket.onmessage = (ev) => console.warn('[robot-os] lps:', ev.data);   // only errors come back
    socket.onclose = () => {
      socket = null;
      sent = null;   // robot-os drops a closed socket's entities
      if (active) retry = setTimeout(connect, 1000);
    };
  }

  return {
    get active() { return active; },
    id,
    start() {
      if (active) return;
      active = true;
      sent = null;
      connect();
    },
    stop() {
      if (!active) return;
      if (sent) send({ type: 'remove', id });
      active = false;
      sent = null;
      clearTimeout(retry);
      clearTimeout(timer);
      if (socket) { try { socket.close(); } catch (_) { /* closed */ } }
      socket = null;
    },
    // Scene-space point (three.js world coordinates) or null to remove. Kept while inactive,
    // so a target set before the backend is known is sent once it is.
    setTarget(p) {
      target = p ? toRobotFrame(p) : null;
      flush();
    },
  };
}
