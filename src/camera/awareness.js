// Reads robot-os's /lps/visual_awareness stream (the dev server relays the hub's mirror of
// it at /robot/lps-service/lps/visual_awareness) for the Camera tab's overlay. Calls
// onFrame(frame) for every frame, and onFrame(null) when no frame has arrived for a second
// or the socket closes. Reconnects while started.

const STALE_MS = 1000;

export function createAwarenessReader({ onFrame }) {
  let socket = null;
  let active = false;
  let retry = 0;
  let stale = 0;

  function markStale() {
    clearTimeout(stale);
    stale = setTimeout(() => onFrame(null), STALE_MS);
  }

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/robot/lps-service/lps/visual_awareness`);
    socket.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch (_) { return; }
      onFrame(frame);
      markStale();
    };
    socket.onclose = () => {
      socket = null;
      if (!active) return;
      onFrame(null);
      retry = setTimeout(connect, 2000);
    };
  }

  return {
    start() {
      if (active) return;
      active = true;
      connect();
      markStale();
    },
    stop() {
      if (!active) return;
      active = false;
      clearTimeout(retry);
      clearTimeout(stale);
      if (socket) { try { socket.close(); } catch (_) { /* closed */ } }
      socket = null;
    },
  };
}
