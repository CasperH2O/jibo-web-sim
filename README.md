# jibo-web-sim

![Jibo twerks on command](assets/screenshots/jibo-twerk.gif)

A browser-only simulator for Jibo skill bundles. Loads a production skill
bundle into a sandboxed iframe, talks to in-browser stand-ins for the
on-device services, and (optionally) bridges out to a real cloud backend
for cloud-routed turns.

The sim works two ways:

- **Offline** — voice/typed input is parsed by an in-browser implementation
  of the launch-rule DSL against whatever rule files the loaded bundle ships
  with. Anything the bundle can handle locally (scripted responses,
  on-device skills) runs to completion: speech, body animation, music,
  screen content. No backend required.
- **With a cloud backend** — typed/voice input is forwarded to the
  configured hub; the cloud's intent router routes the turn back to the
  bundle the same way the on-device runtime does.

## Running it

```sh
npm install     # express only
node server.js  # http://localhost:8080/
```

Drop unpacked skill bundles into `./skills/` (two demo bundles already
live there); they show up in the picker. Open the page, click
**Start Jibo** — the click also unlocks the page's audio context.

To connect to a cloud backend, enter its host:port in the host UI field
before starting.

### Unpacking a jibo-be tarball

For a downloaded `jibo-be-12.0.0.tar.gz` (or any other version), unpack
it under `./skills/jibo-be/`:

```sh
mkdir -p skills/jibo-be && tar xzf jibo-be-12.0.0.tar.gz -C skills/jibo-be
```

The bundle shows up in the picker on the next reload.

### Importing the rule pack

The [companion rule pack][rule-pack] is fetched automatically as part of
`npm install` (postinstall hook → `scripts/fetch-rules.js`). It lands in
`./rules/`. If the directory already has content the script skips, so
manual or custom rule packs stay put.

Re-fetch any time:

```sh
npm run fetch-rules
```

Or skip the automatic fetch — set `SKIP_RULE_FETCH=1` before `npm
install`, or pull manually with:

```sh
curl -sSL https://github.com/Paskooter/jibo-web-sim-rules/archive/refs/heads/main.tar.gz \
  | tar xz -C rules --strip-components=1
```

Same shape works for any other rule pack — just drop the tree into
`./rules/`.

[rule-pack]: https://github.com/Paskooter/jibo-web-sim-rules

### Pointing elsewhere

The defaults `./skills` and `./rules` are overridable per process:

```sh
EXTERNAL_SKILLS=/path/to/bundles \
EXTERNAL_RULES=/path/to/rule-pack \
node server.js
```

Either tree is walked the same way as a bundle — any `launch.rule` files
under `<root>/node_modules/<scope>/<name>/` register as that skill, and any
`*.grm` files register as factory grammars. A bundle's own skills root
(BEam's `@be/be/skills/<name>/launch.rule`) registers as `@be/<name>`.

### The robot's file system

Bundles that keep state on the robot (BEam: its settings, BEacon's data,
the jukebox library) need somewhere to write it. With `ROBOT_FS_DIR` set,
the robot paths `/opt/jibo`, `/var/jibo`, `/opt/tmp` and `/tmp` map onto
that host directory: the page's `fs` reads and writes them through the
server's `/__robotfs` API, and `file://` images under them load from it.

```sh
ROBOT_FS_DIR=/path/to/robot-fs node server.js
```

Without it those paths stay absent, as on any other bundle. The server
never creates `/opt/jibo/Jibo` (BEam would then act as if it runs on a
robot, with OTA updates), and drops a public 5x1.com `endpoint` from
`/var/jibo/credentials.json`.

### Host processes

Some bundles start processes of their own: BEam's music skill starts its
player's helper, a Node server on `127.0.0.1:18701`. With a robot file
system, the page's `child_process.spawn` asks the server to run it on the
host over the `/__host-process` socket. Only Node may run, only a script
inside the skill bundles or BEacon's revisioned custom-skill packages, and only with a few memory flags. The process is
preloaded with `scripts/robot-host.cjs`, which maps the robot paths onto
`ROBOT_FS_DIR` and keeps its servers on 127.0.0.1. It ends when the page
does. `HOST_RELAY_PORTS` lists the ports the page may reach through
`/__host/<port>/`: the page's `http`, `fetch` and `<audio>`/`<video>`
requests to `http://127.0.0.1:<port>` go there.

```sh
ROBOT_FS_DIR=/path/to/robot-fs HOST_RELAY_PORTS='18700 18701' node server.js
```

BEacon-installed skills are loaded from the simulated robot filesystem and can use
the BEam bundle's dependencies. The BE profile relays ports 18700 (JiboTube Pro)
and 18701 (BEam music); other helper ports must be added to `HOST_RELAY_PORTS`.
Helper start and exit messages are in `logs/simulator.log`. Skill errors appear in
the browser developer console. Restart the simulator after changing relay ports.

The same preload runs BEam's control panel on its own, on the same robot
file system: `node --require ./scripts/robot-host.cjs
<bundle>/beacon/server.js 8123`.

## What you supply

The simulator ships **no skill content of its own**. You bring:

- A skill bundle (typically a `jibo-be` build) dropped into `./skills/`
  (or a custom dir via `EXTERNAL_SKILLS`).
- The bundle's own `launch.rule` files, anywhere under
  `<bundle>/node_modules/**/launch.rule` — they're auto-discovered on
  boot. Same for `.grm` factory grammars.
- Optionally, a companion rule pack in `./rules/` (gitignored) or a
  custom dir via `EXTERNAL_RULES`, for skills whose `launch.rule` isn't
  shipped on-device.

If neither source has rules for a given input, the regex-backed
quick-match table is the fallback.

## Architecture

```
┌────────────────────── browser tab ───────────────────────────────────┐
│                                                                      │
│  ┌──── host ─────────────────────┐  ┌── sandboxed iframe ─────────┐  │
│  │ Three.js viewport (body rig)  │  │  user-supplied skill bundle │  │
│  │ face-overlay homography       │←→│  loaded in place:           │  │
│  │ TTS via Web Speech            │  │   - real jibo runtime       │  │
│  │ audio playback                │  │   - PixiJS face renderer    │  │
│  │ touch/tap forwarding          │  │   - require() shim          │  │
│  └──────────────┬────────────────┘  │   - in-memory service bus   │  │
│                 │ postMessage       └────────┬────────────────────┘  │
│                 ▼                            │ /__cloud-ws (optional) │
│             host bridge                      │                        │
└──────────────────────────────────────────────│────────────────────────┘
                                               ▼
                                     express dev server
                                  (forwards to a cloud hub
                                  with injected auth headers)
```

## Layout

```
index.html                      page shell, "Start Jibo" gate
server.js                       express; cloud WS proxy + cross-origin image proxy
src/
  main.js                       boot: viewport + skill iframe + bridge
  viewport/                     three.js scene + body rig
  ui/                           sidebar panels (chat / rig / etc.), screen dock
  bridge/                       host bridge + face overlay homography
  skill-runtime/                in-iframe machinery
    boot.js                       shim mode (own demo skills) | real-runtime mode (user bundle)
    cjs-require.js                browser require() + cloud WS bridge
    live-eye.js                   DOF playback, audio routing
    nlu/                          rule-DSL lexer/parser/matcher
    services/                     in-memory service bus + stand-ins
skills/                           drop unpacked bundles here (demos pre-installed)
rules/                            drop a launch-rule pack here (empty by default)
assets/jibo-legacy/               body geom/skel/kin + texture for the rig
```

## What works

![Asking for the time runs the clock skill end-to-end](assets/screenshots/jibo-time.gif)

- Bundle boots clean; the on-device runtime loads, plugins init, face renders.
- Local NLU with the full launch-rule DSL: alternation precedence,
  group-tag scope, tag append (`+=`), char-class grammar, factory refs.
  Rule files are discovered from the loaded bundle.
- Scripted-response lookups against whatever MIM set the bundle ships.
- Animation engine: DOF arbiter priority preemption, eased start poses,
  PIXI timeline overlays, real animation durations, eye lookAt, blink, LED.
- Cloud path (when a backend is configured): typed chat → cloud hub →
  intent router → skill switch → speech + music + screen content.

## What you'll hit

Limits, not bugs:

- **Offline NLU coverage depends on what rules the bundle ships.** A
  stock bundle typically ships rules for a handful of skills. Skills
  without on-device rules need either the cloud or local rule files
  added to the bundle.
- **Cloud-only flows** (general question answering, news, weather, music
  streaming, etc.) need a configured backend.
- **Live mic input** isn't wired — the chat field is the input path.
- **Hardware-backed services** (real wifi, scheduler, OTA) are
  no-op stand-ins by design.

## License

Code in `src/`, `server.js`, `index.html`: this repo's license.
Vendored libraries (`vendor/three.module.js`, etc.): MIT, per their
upstream headers.
