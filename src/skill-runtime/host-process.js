// Node's child_process.spawn for bundles that start a process of their own (BEam's music
// skill starts its player helper). The page cannot, so the dev server runs it on the host
// and relays it over the /__host-process socket (server.js): the bundle's command, arguments,
// working directory and environment go up; stdout, stderr and the exit come back, and stdin
// goes up. Closing the socket (the page unloads) ends the process. The server only allows
// this with a robot file system (window.__ROBOT_FS__, robot-fs.js) and only for Node running
// a script inside the skill bundles.

function toBase64(data) {
  const B = typeof window !== 'undefined' && window.Buffer;
  if (B) return B.from(data).toString('base64');
  return btoa(unescape(encodeURIComponent(String(data))));
}
function fromBase64(text) {
  const B = typeof window !== 'undefined' && window.Buffer;
  return B ? B.from(text, 'base64') : atob(text);
}

export function makeChildProcess(EventEmitter) {
  function spawn(command, args = [], options = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    let ended = false;
    const finish = (code, signal) => {
      if (ended) return;
      ended = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    };
    const fail = (code, message) => {
      setTimeout(() => child.emit('error', Object.assign(new Error(message || code), { code })), 0);
    };
    if (typeof window === 'undefined' || window.__ROBOT_FS__ !== true || !window.WebSocket) {
      fail('ENOSYS', `cannot start ${command}: no host processes without a robot file system`);
      return Object.assign(child, { stdin: new EventEmitter(), kill: () => false });
    }

    const ws = new window.WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__host-process`);
    const queue = [];
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); else queue.push(obj); };
    child.stdin = Object.assign(new EventEmitter(), {
      write(data) { if (data != null) send({ type: 'stdin', data: toBase64(data) }); return true; },
      end(data) { if (data != null) this.write(data); send({ type: 'stdin-end' }); },
    });
    child.kill = (signal = 'SIGTERM') => { child.killed = true; send({ type: 'kill', signal }); return true; };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'spawn', command, args, cwd: options.cwd, env: options.env }));
      for (const obj of queue.splice(0)) ws.send(JSON.stringify(obj));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'spawned') { child.pid = msg.pid; child.emit('spawn'); }
      else if (msg.type === 'stdout') child.stdout.emit('data', fromBase64(msg.data));
      else if (msg.type === 'stderr') child.stderr.emit('data', fromBase64(msg.data));
      else if (msg.type === 'error') fail(msg.code, msg.message);
      else if (msg.type === 'exit') { finish(msg.code, msg.signal); ws.close(); }
    };
    ws.onerror = () => fail('ECONNRESET', 'the host process bridge failed');
    ws.onclose = () => finish(null, 'SIGTERM');
    return child;
  }
  return { spawn };
}
