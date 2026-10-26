// Tiny Express dev server for the simulator. Serves the repo root as static
// files. No build step, no bundler — index.html + ESM does the rest.

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';

// Cloud hub auth: the hub accepts a Bearer JWT signed with HS256. The secret
// and credential identifiers are fully configurable via env vars — any
// non-default deployment can override them without touching this file.
const HUB_SECRET = process.env.HUB_AUTH_SECRET || 'uHGhXhdXzBybGX7YHuEwAFZC';
const HUB_CREDENTIALS = {
  id: process.env.HUB_AUTH_ID || 'hub-client-account-id',
  accessKeyId: process.env.HUB_AUTH_ACCESS_KEY_ID || 'hub-client-access-key-id',
  secretAccessKey: process.env.HUB_AUTH_SECRET_ACCESS_KEY || 'hub-client-secret-access-key',
  friendlyId: process.env.HUB_AUTH_FRIENDLY_ID || 'hub-client-friendly-id',
};
const HUB_BEARER = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(HUB_CREDENTIALS);
  const sig = crypto.createHmac('sha256', HUB_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
})();
// Expose the friendlyId so the iframe/bridge can stamp CONTEXT.general explicitly
// if it ever wants to skip the hub's auto-fill path.
const HUB_AUTH_PUBLIC = { id: HUB_CREDENTIALS.id, friendlyId: HUB_CREDENTIALS.friendlyId };

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

// Disable any caching so edits are picked up on refresh.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Skill bundle directory. Drop unpacked skill bundles in here and they
// show up in the picker; the demos already shipped in ./skills work the
// same way. Override via EXTERNAL_SKILLS if you want to point elsewhere.
const EXTERNAL_SKILLS = process.env.EXTERNAL_SKILLS || join(__dirname, 'skills');
// Optional launch-rule pack — a separate tree of launch.rule + .grm files
// the NLU registry picks up in addition to anything the loaded bundle
// ships. Defaults to ./rules (gitignored, empty by default) so users can
// drop a rule pack in without configuration. Override via EXTERNAL_RULES.
const EXTERNAL_RULES = process.env.EXTERNAL_RULES || join(__dirname, 'rules');
// The CommonJS require shim probes extensionless paths (`index`) and bare
// directories. Disable the `extensions`/`index`/`redirect` fallbacks so those
// 404 instead of returning a directory's index.html — letting the shim fall
// through to `.js` / package.json `main`.
// Compat patch (must precede the static handler): the CRN texture-decode
// worker posts its decoded texture back to the main thread as a TRANSFERABLE
// (`postMessage({...}, [dxtData.buffer])`), but that buffer is a view into the
// emscripten heap and isn't detachable in our Chrome — the worker's postMessage
// throws and ANY .crn asset load hangs forever.
// Serve the worker with the transfer list dropped so the buffer is
// structured-cloned (copied) instead — identical result, just not zero-copy.
// Served at its real URL (not a blob) so the worker's relative .crn XHR still
// resolves against its http origin.
app.get(/webgl-texture-util\.js$/, (req, res, next) => {
  const prefix = '/skills/';
  if (!req.path.startsWith(prefix)) { next(); return; }
  const abs = normalize(join(EXTERNAL_SKILLS, req.path.slice(prefix.length)));
  if (!abs.startsWith(normalize(EXTERNAL_SKILLS))) { next(); return; }
  let src;
  try { src = readFileSync(abs, 'utf8'); } catch (_) { next(); return; }
  res.type('application/javascript').send(src.replace(/,\s*\[\s*dxtData\.buffer\s*\|\|\s*dxtData\s*\]\s*\)/g, ')'));
});

// Some skills reference animation textures (White_Eye.png etc.) under their
// own animations/textures/ folder, but the directory doesn't exist in their
// bundle — the textures live in the shared animation database's
// animations/textures/. Animations themselves come from that shared database
// (loaded by name from the global manifest), and their texture refs are
// resolved relative to the *playing skill's* assetPack root, so each
// consuming skill needs the same redirect.
//
// Match any of the affected skill paths and probe the shared database copy.
// The capture is greedy on the subpath because the textures are organized
// in subdirectories — not just leaf filenames.
app.get(/\/@be\/[^/]+\/animations\/textures\/(.+)$/, (req, res, next) => {
  const m = /\/@be\/[^/]+\/animations\/textures\/(.+)$/.exec(req.path);
  if (!m) { next(); return; }
  const subpath = m[1];
  const fallback = `/skills/jibo-be/node_modules/jibo-anim-db-animations/animations/textures/${subpath}`;
  // Probe disk to avoid an infinite loop if the fallback is also missing.
  try {
    const abs = normalize(join(EXTERNAL_SKILLS, fallback.slice('/skills/'.length)));
    if (existsSync(abs)) return res.redirect(302, fallback);
  } catch (_) { /* fall through */ }
  next();
});

app.use('/skills', express.static(EXTERNAL_SKILLS, { index: false, redirect: false }));

// Optional companion rule pack served at /external-rules. The boot loader
// walks this tree the same way it walks the bundle's own tree, so both
// contribute launch.rule and *.grm files to the registry.
if (EXTERNAL_RULES) {
  app.use('/external-rules', express.static(EXTERNAL_RULES, { index: false, redirect: false }));
}

// Recursive file manifest for a served dir. The CommonJS require shim uses
// this to resolve modules WITHOUT probing (each missing probe is a console 404),
// which otherwise floods the devtools console with thousands of failed requests.
// Accepts /skills (the bundle tree) and /external-rules (the rule pack). With
// a manifest in hand the shim treats every path outside the skill root as
// known-missing, eliminating the require()-walk's higher-up node_modules/
// probes (e.g. /node_modules/pixi.js → 404 cascade in shim mode).
app.get('/__list', (req, res) => {
  const root = String(req.query.root || '');
  let baseAbs = null;
  if (root === '/skills' || root.startsWith('/skills/')) {
    const sub = root === '/skills' ? '' : root.slice('/skills/'.length);
    baseAbs = normalize(join(EXTERNAL_SKILLS, sub));
    if (!baseAbs.startsWith(normalize(EXTERNAL_SKILLS))) { res.status(400).json({ files: [] }); return; }
  } else if (root.startsWith('/external-rules')) {
    if (!EXTERNAL_RULES) { res.json({ files: [] }); return; }
    baseAbs = normalize(join(EXTERNAL_RULES, root.slice('/external-rules'.length).replace(/^\//, '')));
    if (!baseAbs.startsWith(normalize(EXTERNAL_RULES))) { res.status(400).json({ files: [] }); return; }
  } else {
    res.json({ files: [] }); return;
  }
  // Files are { url, size } so the browser shim can satisfy fstat() WITHOUT
  // pre-fetching every file body. Chitchat's postInit walks thousands of MIM
  // files and only checks isFile/isDirectory — sending sizes here lets open()
  // return a lazy fd whose body is fetched only on first read.
  const files = [];
  const walk = (absDir, urlDir) => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const url = `${urlDir}/${e.name}`;
      const abs = join(absDir, e.name);
      // Local resurrection workspaces keep proprietary bundles outside this
      // repository and expose them through controlled directory symlinks.
      // Dirent reports those as links, so consult stat() before deciding
      // whether to recurse. express.static follows the same links when the
      // browser later requests a discovered file.
      let isDirectory = e.isDirectory();
      if (!isDirectory && e.isSymbolicLink()) {
        try { isDirectory = statSync(abs).isDirectory(); } catch (_) { /* broken link */ }
      }
      if (isDirectory) walk(abs, url);
      else {
        let size = 0;
        try { size = statSync(abs).size; } catch (_) { /* keep 0 */ }
        files.push({ url, size });
      }
    }
  };
  walk(baseAbs, root.replace(/\/$/, ''));
  res.json({ files });
});

// Cross-origin image proxy. Skill SKILL_ACTIONs (notably news reporting)
// reference remote thumbnail/article images by absolute URL.
// PIXI loads them through HTMLImageElement with crossOrigin='anonymous', but
// most public image servers don't return Access-Control-Allow-Origin — the
// image displays in <img> tags but texImage2D refuses to upload it as a
// WebGL texture ("SecurityError: image element contains cross-origin data").
// Once the upload fails, the sprite's _texture stays null and PIXI's
// SpriteRenderer.flush crashes every frame reading baseTexture → endless
// console spam.
// /__img?url=<encoded> fetches the remote image server-side and replays
// the bytes back as same-origin, side-stepping CORS entirely.
app.get('/__img', (req, res) => {
  const target = String(req.query.url || '');
  if (!/^https?:\/\//i.test(target)) { res.status(400).type('text/plain').send('bad url'); return; }
  const libFor = (u) => (u.startsWith('https') ? https : http);
  const proxyOne = (url, allowRedirect) => {
    libFor(url).get(url, { headers: { 'User-Agent': 'jibo-web-sim' } }, (upstream) => {
      if (allowRedirect && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const loc = upstream.headers.location;
        const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
        upstream.resume();           // discard the redirect body
        proxyOne(next, false);
        return;
      }
      res.status(upstream.statusCode || 502);
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (/^(transfer-encoding|connection|content-security-policy|access-control-allow-origin)$/i.test(k)) continue;
        res.setHeader(k, v);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      upstream.pipe(res);
    }).on('error', (e) => res.status(502).type('text/plain').send(e.message));
  };
  proxyOne(target, true);
});

// Same-origin proxy to a cloud backend, to dodge CORS. The iframe sends
// `/__cloud<path>` with `X-Cloud-Upstream: <host>:<port>` (or `?upstream=`); we
// forward the request to that upstream and stream the response back. Browsers
// don't enforce CORS on the server-to-server hop, so the cloud backend
// (designed for desktop runtimes, no CORS) works unmodified through the proxy.
app.use('/__cloud', express.raw({ type: '*/*', limit: '32mb' }), (req, res) => {
  const upstream = String(req.headers['x-cloud-upstream'] || req.query.upstream || '').trim();
  if (!upstream || !/^[\w.-]+(:\d+)?$/.test(upstream)) {
    res.status(400).type('text/plain').send('missing or invalid X-Cloud-Upstream');
    return;
  }
  const [uhost, uportStr] = upstream.split(':');
  const uport = uportStr ? Number(uportStr) : 80;
  // Forward all headers except hop-by-hop + the cloud-upstream pointer itself.
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|content-length|x-cloud-upstream|origin|referer)$/i.test(k)) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders.host = upstream;
  if (!fwdHeaders.authorization) fwdHeaders.authorization = `Bearer ${HUB_BEARER}`;
  const upreq = http.request({
    host: uhost, port: uport, path: req.url || '/', method: req.method, headers: fwdHeaders,
  }, (upres) => {
    res.status(upres.statusCode || 502);
    for (const [k, v] of Object.entries(upres.headers)) {
      if (/^(transfer-encoding|connection)$/i.test(k)) continue;
      res.setHeader(k, v);
    }
    upres.pipe(res);
  });
  upreq.on('error', (e) => { res.status(502).type('text/plain').send(`upstream error: ${e.message}`); });
  if (req.body && req.body.length) upreq.write(req.body);
  upreq.end();
});

// Chat mirror: the browser POSTs each chat message (see main.js) and we append
// it as one JSON line to $CHAT_LOG so the conversation is readable outside the
// browser. Disabled (204, nothing written) when CHAT_LOG is unset.
const CHAT_LOG = process.env.CHAT_LOG || '';
app.post('/__chatlog', express.json({ type: '*/*', limit: '64kb' }), (req, res) => {
  const { ts, who, text, skill, server } = req.body || {};
  if (CHAT_LOG && typeof who === 'string' && typeof text === 'string') {
    try {
      mkdirSync(dirname(CHAT_LOG), { recursive: true });
      appendFileSync(CHAT_LOG, JSON.stringify({ ts, who, text, skill, server }) + '\n');
    } catch (e) { console.error('chatlog write failed:', e.message); }
  }
  res.status(204).end();
});

// robot-os: Jibo's real expression service plus a state hub, running as a separate
// local Node process (the resurrection workspace's robot-os/launcher.mjs). The
// browser only ever talks to this server; these relays forward to 127.0.0.1.
//   GET /robot/config        -> {defaultBackend}: the backend the page uses without
//                            ?backend= (ROBOT_BACKEND=local|robot-os, default local)
//   GET /robot/status        -> hub /status (503 JSON when robot-os is not running)
//   WS  /robot/expression    -> expression service RemoteClient socket
//   WS  /robot/state, /lps   -> hub /state, /lps
//   /robot/lps-service/<path> -> the skill runtime's jibo.lps client: HTTP (/lps/faces, ...)
//                            goes to the simulated LPS service, WS (/lps/visual_awareness,
//                            /lps/audible_awareness) to the hub's mirrors of its streams (the
//                            service has one subscriber per stream: the attention manager)
//   /robot/tts/<path>        -> robot-os's TTS bridge (Jibo's real voice, robot-os/tts.mjs):
//                            /status, /tts_speak (streamed audio/L16), /tts_token_times, ...
//                            Independent of the backend choice; 503 when it is not running.
//   WS  /robot/camera        -> robot-os's camera feed (robot-os/camera.mjs): the Camera tab's
//                            webcam frames (binary JPEG) for Jibo's own LPS; stats come back
const ROBOT_OS_EXPRESSION_PORT = Number(process.env.ROBOT_OS_EXPRESSION_PORT) || 10015;
const ROBOT_OS_HUB_PORT = Number(process.env.ROBOT_OS_HUB_PORT) || 8190;
const ROBOT_OS_LPS_PORT = Number(process.env.ROBOT_OS_LPS_PORT) || 8484;
const ROBOT_OS_TTS_PORT = Number(process.env.ROBOT_OS_TTS_PORT) || 8189;
const ROBOT_OS_CAMERA_PORT = Number(process.env.ROBOT_OS_CAMERA_PORT) || 8187;
const ROBOT_BACKEND = process.env.ROBOT_BACKEND === 'robot-os' ? 'robot-os' : 'local';
if (process.env.ROBOT_BACKEND && process.env.ROBOT_BACKEND !== ROBOT_BACKEND) {
  console.warn(`ROBOT_BACKEND must be 'local' or 'robot-os' (got '${process.env.ROBOT_BACKEND}'); using local`);
}
const ROBOT_OS_LPS_PREFIX = '/robot/lps-service/';
const ROBOT_OS_ROUTES = {
  '/robot/expression': `ws://127.0.0.1:${ROBOT_OS_EXPRESSION_PORT}/`,
  '/robot/state': `ws://127.0.0.1:${ROBOT_OS_HUB_PORT}/state`,
  '/robot/lps': `ws://127.0.0.1:${ROBOT_OS_HUB_PORT}/lps`,
  '/robot/camera': `ws://127.0.0.1:${ROBOT_OS_CAMERA_PORT}/frames`,
};
function robotOsUpstream(pathname) {
  if (ROBOT_OS_ROUTES[pathname]) return ROBOT_OS_ROUTES[pathname];
  if (pathname.startsWith(ROBOT_OS_LPS_PREFIX)) return `ws://127.0.0.1:${ROBOT_OS_HUB_PORT}/${pathname.slice(ROBOT_OS_LPS_PREFIX.length)}`;
  return null;
}
app.use(ROBOT_OS_LPS_PREFIX, express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const upstream = await fetch(`http://127.0.0.1:${ROBOT_OS_LPS_PORT}${req.url}`, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {},
      body: ['GET', 'HEAD'].includes(req.method) || !Buffer.isBuffer(req.body) ? undefined : req.body,
      signal: AbortSignal.timeout(5000),
    });
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.set('Content-Type', type);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.status(503).json({ ok: false, error: `robot-os LPS not reachable on 127.0.0.1:${ROBOT_OS_LPS_PORT} (${e.message})` });
  }
});
// Streamed both ways (speech audio arrives while it is being synthesised). A browser that
// goes away mid-utterance closes the upstream request, which makes the bridge stop speaking.
app.use('/robot/tts/', (req, res) => {
  const upstream = http.request({
    host: '127.0.0.1',
    port: ROBOT_OS_TTS_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {},
  }, (up) => {
    res.status(up.statusCode);
    res.set('Cache-Control', 'no-store');
    if (up.headers['content-type']) res.set('Content-Type', up.headers['content-type']);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.status(503).json({ ok: false, error: `robot-os TTS not reachable on 127.0.0.1:${ROBOT_OS_TTS_PORT} (${e.message})` });
    else res.end();
  });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
});
app.get('/robot/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ defaultBackend: ROBOT_BACKEND });
});
app.get('/robot/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const upstream = await fetch(`http://127.0.0.1:${ROBOT_OS_HUB_PORT}/status`, { signal: AbortSignal.timeout(1500) });
    if (!upstream.ok) throw new Error(`hub answered ${upstream.status}`);
    // skillsDir: the directory served at /skills. robot-os runs on this machine and
    // reads animation files itself, so the skill runtime turns its /skills/<name>
    // URL into this path for expression.setSkillRoot.
    res.json({ ...(await upstream.json()), skillsDir: EXTERNAL_SKILLS });
  } catch (e) {
    res.status(503).json({ ok: false, error: `robot-os not reachable on 127.0.0.1:${ROBOT_OS_HUB_PORT} (${e.message})` });
  }
});

// Browser defaults to fetching /favicon.ico — a 204 keeps the address bar
// from showing a 404 and stops devtools from logging it on every reload.
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.static(__dirname, { extensions: ['html'] }));

const server = app.listen(PORT, HOST, () => {
  console.log(`jibo-web-sim dev server listening on http://${HOST}:${PORT}/`);
});

// Optional HTTPS listener: getUserMedia (the 🎤 voice path) only exists in a
// secure context, and http://<lan-ip>:8080 is not one — only localhost and
// https origins are. HTTPS=1 (or HTTPS_PORT=<n>) serves the same app + WS
// proxy on HTTPS_PORT (default 8443) with a self-signed cert, auto-generated
// via the openssl CLI with SANs for localhost and every local IPv4 address.
// Browsers show a one-time "not private" interstitial for self-signed certs;
// proceed past it once and the mic works.
let httpsServer = null;
if (process.env.HTTPS === '1' || process.env.HTTPS_PORT) {
  const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
  const certDir = join(__dirname, '.https-cert');
  const keyPath = process.env.HTTPS_KEY || join(certDir, 'key.pem');
  const certPath = process.env.HTTPS_CERT || join(certDir, 'cert.pem');
  try {
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      const sans = ['DNS:localhost', 'IP:127.0.0.1'];
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) if (i.family === 'IPv4' && !i.internal) sans.push(`IP:${i.address}`);
      }
      mkdirSync(certDir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
        '-days', '825', '-nodes', '-subj', '/CN=jibo-web-sim', '-addext', `subjectAltName=${sans.join(',')}`], { stdio: 'ignore' });
      console.log(`generated self-signed cert for ${sans.join(' ')} in ${certDir}`);
    }
    httpsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, app);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`jibo-web-sim HTTPS (mic-capable) listening on https://${HOST}:${HTTPS_PORT}/`);
    });
  } catch (e) {
    console.warn(`HTTPS listener disabled: ${e.message} (is the openssl CLI installed?)`);
  }
}

// WebSocket proxy to the cloud hub. Browsers can't set custom WS-upgrade headers
// (the hub requires X-JIBO-transID per connection and uses a new socket per
// turn), so the browser opens
//   ws://<sim>/__cloud-ws?upstream=<host>:<port>&path=<p>&transID=<id>[&robotID=<r>]
// and the server upgrades both sides and pipes frames between them, injecting
// the X-JIBO-transID / X-JIBO-robotID headers on the upstream handshake.
const wss = new WebSocketServer({ noServer: true });
const onUpgrade = (req, sock, head) => {
  const robotUpstream = req.url && robotOsUpstream(new URL(req.url, 'http://x').pathname);
  if (robotUpstream) { relayRobotOs(req, sock, head, robotUpstream); return; }
  if (!req.url || !req.url.startsWith('/__cloud-ws')) { sock.destroy(); return; }
  const u = new URL(req.url, 'http://x');
  const upstream = u.searchParams.get('upstream');
  const path = u.searchParams.get('path') || '/';
  const transID = u.searchParams.get('transID') || '';
  const robotID = u.searchParams.get('robotID') || 'web-sim-robot';
  if (!upstream || !/^[\w.-]+(:\d+)?$/.test(upstream)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (clientWS) => {
    const upstreamWS = new WS(`ws://${upstream}${path}`, {
      headers: {
        Authorization: `Bearer ${HUB_BEARER}`,
        'X-JIBO-transID': transID,
        'X-JIBO-robotID': robotID,
      },
    });
    let opened = false;
    const cleanup = () => { try { clientWS.close(); } catch (_) {} try { upstreamWS.close(); } catch (_) {} };
    upstreamWS.on('open', () => { opened = true; });
    // The hub sends text frames. The `ws` library delivers all frames as Buffer
    // by default, and forwarding a Buffer via clientWS.send(buf) emits a BINARY
    // frame -- browsers then expose ev.data as a Blob and the client's
    // JSON.parse fails. Honor isBinary in both directions: relay text as
    // string, binary as Buffer.
    const relay = (sink, data, isBinary) => { try { sink.send(isBinary ? data : data.toString('utf8'), { binary: !!isBinary }); } catch (_) { /* sink closed */ } };
    const pending = [];
    clientWS.on('message', (data, isBinary) => { if (opened) relay(upstreamWS, data, isBinary); else pending.push([data, isBinary]); });
    upstreamWS.on('open', () => { for (const [d, b] of pending) relay(upstreamWS, d, b); pending.length = 0; });
    upstreamWS.on('message', (data, isBinary) => relay(clientWS, data, isBinary));
    upstreamWS.on('close', cleanup);
    clientWS.on('close', cleanup);
    upstreamWS.on('error', (e) => { try { clientWS.send(JSON.stringify({ type: 'ERROR', data: { message: 'upstream WS error: ' + e.message } })); } catch (_) {} cleanup(); });
    clientWS.on('error', cleanup);
  });
};
// Pipe a browser socket to a robot-os socket unchanged (text stays text). The
// client's messages are queued until the upstream opens; if robot-os is not
// running the browser socket closes with 1011 and the client's own reconnect
// logic takes over.
const robotWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function relayRobotOs(req, sock, head, upstreamUrl) {
  robotWss.handleUpgrade(req, sock, head, (clientWS) => {
    const upstreamWS = new WS(upstreamUrl, { perMessageDeflate: false });
    const relay = (sink, data, isBinary) => { try { sink.send(isBinary ? data : data.toString('utf8'), { binary: !!isBinary }); } catch (_) { /* sink closed */ } };
    const pending = [];
    clientWS.on('message', (data, isBinary) => {
      if (upstreamWS.readyState === WS.OPEN) relay(upstreamWS, data, isBinary); else pending.push([data, isBinary]);
    });
    upstreamWS.on('open', () => { for (const [d, b] of pending) relay(upstreamWS, d, b); pending.length = 0; });
    upstreamWS.on('message', (data, isBinary) => relay(clientWS, data, isBinary));
    upstreamWS.on('close', () => { try { clientWS.close(); } catch (_) {} });
    upstreamWS.on('error', (e) => { try { clientWS.close(1011, `robot-os: ${e.message}`.slice(0, 120)); } catch (_) {} });
    clientWS.on('close', () => { try { upstreamWS.close(); } catch (_) {} });
    clientWS.on('error', () => { try { upstreamWS.close(); } catch (_) {} });
  });
}

server.on('upgrade', onUpgrade);
if (httpsServer) httpsServer.on('upgrade', onUpgrade);
