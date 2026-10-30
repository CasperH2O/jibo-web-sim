// The robot's own file system, for bundles that keep their state there (BEam: its
// settings, BEacon's data, the jukebox library and thumbnails). When the dev server has
// one (ROBOT_FS_DIR, see server.js), /robot/config says so and boot.js sets
// window.__ROBOT_FS__; the paths under ROBOT_FS_ROOTS are then read and written through
// the server's /__robotfs API. Without it they stay absent, as they always were.
// Sync calls use synchronous XHR, like the rest of the fs shim (cjs-require.js).

export const ROBOT_FS_ROOTS = ['/opt/jibo', '/var/jibo', '/opt/tmp', '/tmp'];

const NativeXHR = typeof window !== 'undefined' ? window.XMLHttpRequest : null;

// robotPath('/opt/jibo/x/../y') -> '/opt/jibo/y'; null when disabled or not a robot path.
// Accepts file:// URLs too (BEam gives the jukebox covers as file:///...).
export function robotPath(p) {
  if (typeof window === 'undefined' || window.__ROBOT_FS__ !== true) return null;
  let s = String(p == null ? '' : p);
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch (_) { return null; }
  }
  if (s[0] !== '/') return null;
  const out = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  const norm = `/${out.join('/')}`;
  return ROBOT_FS_ROOTS.some((r) => norm === r || norm.startsWith(`${r}/`)) ? norm : null;
}

// The same-origin URL a robot file is served at (fetch, <img>, XHR).
export function robotFsUrl(robot) {
  return `/__robotfs/file${robot.split('/').map(encodeURIComponent).join('/')}`;
}

function fsError(code, message, path) {
  const e = new Error(`${code}: ${message || code}, '${path}'`);
  e.code = code;
  e.path = path;
  return e;
}

function request(method, url, body, binary) {
  const xhr = new NativeXHR();
  xhr.open(method, url, false);
  if (binary) xhr.overrideMimeType('text/plain; charset=x-user-defined');
  xhr.send(body === undefined ? null : body);
  return xhr;
}

// The API answers 200 with { code, message } when a call fails (server.js), and 204 when a
// write or op succeeds. Served files answer 404 when missing.
function answer(xhr, path) {
  if (xhr.status === 204) return null;
  let info = null;
  try { info = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
  if (xhr.status === 200 && info && !info.code) return info;
  throw fsError((info && info.code) || (xhr.status === 404 ? 'ENOENT' : 'EIO'), info && info.message, path);
}

function query(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function statsOf(info) {
  const mtime = new Date(info.mtimeMs || 0);
  return {
    size: info.size || 0, mode: info.mode || 0, mtime, mtimeMs: info.mtimeMs || 0, ctime: mtime, atime: mtime, birthtime: mtime,
    nlink: info.nlink || 1, ino: info.ino || 0, uid: info.uid || 0, gid: info.gid || 0, dev: 0,
    isFile: () => info.type === 'file', isDirectory: () => info.type === 'dir', isSymbolicLink: () => false,
  };
}

// Synchronous operations on robot paths (already normalized by robotPath). They throw
// Node-style errors with a `code` (ENOENT, EEXIST, ENOTDIR, EACCES, ...).
export const robotFs = {
  stat(path) {
    return statsOf(answer(request('GET', `/__robotfs/stat?${query({ path })}`), path));
  },
  exists(path) {
    try { robotFs.stat(path); return true; } catch (_) { return false; }
  },
  readdir(path) {
    return answer(request('GET', `/__robotfs/readdir?${query({ path })}`), path).names;
  },
  // read(path) -> Uint8Array of the file's bytes.
  read(path) {
    const xhr = request('GET', robotFsUrl(path), undefined, true);
    if (xhr.status !== 200) throw fsError('ENOENT', 'no such file or directory', path);
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  },
  // write(path, bytes|string, flag): flag 'w' (default), 'wx' (fail if it exists) or 'a'.
  write(path, data, flag) {
    answer(request('PUT', `${robotFsUrl(path)}?${query({ flag: flag || 'w' })}`, data), path);
  },
  // op(name, path, extra): mkdir (recursive), rmdir, unlink, rm, rename/link/copy (to), chmod.
  op(name, path, extra = {}) {
    answer(request('POST', `/__robotfs/op?${query({ op: name, path, ...extra })}`), path);
  },
};
