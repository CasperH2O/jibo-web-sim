// Preload (`node --require scripts/robot-host.cjs`) for a host process that stands in for one
// on the robot: BEam's music player helper, which the page starts through the dev server's
// process bridge (server.js), and BEam's BEacon run on its own. With ROBOT_FS_DIR set, the
// robot's paths (/opt/jibo, /var/jibo, /opt/tmp, /tmp) map onto that directory, the same
// robot file system the page reads and writes through /__robotfs. With
// ROBOT_HOST_LOOPBACK=1, servers that listen on every interface listen on 127.0.0.1 only.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { fileURLToPath } = require('url');

const ROBOT_FS_DIR = process.env.ROBOT_FS_DIR ? path.resolve(process.env.ROBOT_FS_DIR) : '';
const ROBOT_FS_ROOTS = ['/opt/jibo', '/var/jibo', '/opt/tmp', '/tmp'];

// mapPath('/opt/jibo/x') -> '<ROBOT_FS_DIR>/opt/jibo/x'; other values are returned unchanged.
function mapPath(p) {
  let s = p;
  if (s instanceof URL) {
    if (s.protocol !== 'file:') return p;
    s = fileURLToPath(s);
  }
  if (typeof s !== 'string' || !path.isAbsolute(s)) return p;
  const norm = path.posix.normalize(s);
  if (norm === ROBOT_FS_DIR || norm.startsWith(`${ROBOT_FS_DIR}/`)) return p;
  return ROBOT_FS_ROOTS.some((r) => norm === r || norm.startsWith(`${r}/`)) ? path.join(ROBOT_FS_DIR, norm) : p;
}

// Calls whose first argument is a path, and those whose first two are.
const ONE = ['access', 'appendFile', 'chmod', 'chown', 'createReadStream', 'createWriteStream', 'exists', 'lchown',
  'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm',
  'rmdir', 'stat', 'statfs', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'unwatchFile', 'writeFile'];
const TWO = ['copyFile', 'cp', 'link', 'rename', 'symlink'];

function wrap(target, name, count) {
  const original = target[name];
  if (typeof original !== 'function') return;
  const wrapped = function (...args) {
    for (let i = 0; i < count && i < args.length; i += 1) args[i] = mapPath(args[i]);
    return original.apply(this, args);
  };
  Object.assign(wrapped, original);   // realpath.native and friends
  target[name] = wrapped;
}

if (ROBOT_FS_DIR) {
  for (const target of [fs, fs.promises]) {
    for (const name of ONE) { wrap(target, name, 1); wrap(target, `${name}Sync`, 1); }
    for (const name of TWO) { wrap(target, name, 2); wrap(target, `${name}Sync`, 2); }
  }
  if (fs.realpath.native) wrap(fs.realpath, 'native', 1);
  if (fs.realpathSync.native) wrap(fs.realpathSync, 'native', 1);
  if (process.env.HOME) process.env.HOME = mapPath(process.env.HOME);
}

if (process.env.ROBOT_HOST_LOOPBACK === '1') {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
      if (typeof args[1] !== 'string' || args[1] === '0.0.0.0' || args[1] === '::') {
        args.splice(1, typeof args[1] === 'string' ? 1 : 0, '127.0.0.1');
      }
    } else if (args[0] && typeof args[0] === 'object' && (!args[0].host || args[0].host === '0.0.0.0' || args[0].host === '::')) {
      args[0] = { ...args[0], host: '127.0.0.1' };
    }
    return listen.apply(this, args);
  };
}

module.exports = { mapPath };
