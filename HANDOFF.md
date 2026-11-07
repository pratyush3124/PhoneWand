# PhoneWand: handoff notes

Goal: use a phone as a Wii-style controller for a web app on a laptop.
The user aims the phone's TOP EDGE at the laptop screen. Two pages:
- `/play`: 2D cursor from the pointing direction, 4-corner calibration, modes Buttons / Targets / Keyboard / Paint
- `/`: point left = "Yes", point right = "No"
Phone screen: top half = controls (Calibrate, Recenter, Start motion), bottom half = touchpad (tap = click, drag = fine move, hold 0.7 s = recenter).

## Architecture
Phone (`/phone`) -> WebSocket relay (`server.js`) -> web app (`/`), paired by a random room code (QR code).

## Done
- `package.json`: ESM project, depends on `ws`
- `server.js`: static file server + WebSocket relay at `/ws?role=phone|app&room=CODE`
  - room code validated (`[A-Za-z0-9_-]{4,64}`), phone -> app relay only, message types limited to highlight/click/tilt/point/recenter/drag/calibrate
  - sends `peer-joined` / `peer-left` so each side knows if the other is connected
  - idle empty rooms expire after 6h
- `public/tilt.js`: tilt classifier with hysteresis (enter at 20 deg, exit at 10 deg)
- `public/remote-client.js`: `connectRemote({ room, onHighlight, onClick, onTilt, onStatus })` and `makeRoomCode()`, with auto-reconnect. This is what the real web app should import.
- `public/phone.html`: controls on top, touchpad below; iOS motion permission, vibration, wake lock, reconnect. Calibrate sends `calibrate` first, then asks for motion. Touchpad sends `drag` {dx, dy, w} only after 8 px of movement, so taps stay taps.
  Streams `point` (top-edge world direction, ~60/s, with a per-page-load `sid`); `click`/`recenter` carry `v` = direction averaged over the 100 ms before the finger touched down. Also still sends 1D `highlight`/`tilt` from the top-edge yaw.
- `public/pointer.js`: top-edge vector, central projection + 4-point homography calibration (exact for a flat screen), yaw-only recenter for gyro drift, One Euro smoothing
- `public/pairing.js`: shared room code + QR panel used by both pages
- `public/play.html`: 2D playground; calibration saved in sessionStorage per phone `sid`. Touchpad drags add a "nudge" offset applied after smoothing (DRAG_GAIN 0.5 = full-width swipe moves half the screen); recenter and calibration clear it.

- `public/app.html`: demo app (Yes/No prompt, QR pairing panel, localhost public-URL input, status pills, tilt gauge, keyboard fallback)
- QR library: `qrcode-generator` 2.x, served from `dist/qrcode.mjs` at `/vendor/qrcode.mjs` (ES module)
- Server: max 6 clients per room (close 1013 "room full"); `peer-left` only sent when no other client of that role remains
- `test.js`: 26 tests (server, relay incl. point/recenter/drag/calibrate, tilt classifier, pointer math with a simulated screen, smoothing presets, desktop helper with a fake mouse), all passing
- `README.md`: run, tunnel setup, integration snippet, troubleshooting
- `desktop/`: OS mouse helper (`npm run mouse -- --public https://<tunnel>`). `controller.js` is pure logic (calibration by parking the real cursor on each corner target with a small wiggle, One Euro smoothing, touchpad nudge, recenter, backs off 1.5 s when the real mouse moves, new phone `sid` = recalibrate). `remote-mouse.js` wires it to `@nut-tree-fork/libnut-<platform>` (optional deps; note the `@nut-tree-fork/libnut` wrapper package is broken, missing `@nut-tree-fork/shared`, so load the platform package directly), Node's global WebSocket via `public/remote-client.js`, a terminal QR code, and raw-mode keys. Phone also sends `scroll` {dx,dy,w} (two-finger drag or right-edge strip on the touchpad), `text` (diff of the phone keyboard box, so autocorrect works) and `key` {key, mods, repeat}; the helper maps them to wheel / typeString / keyTap (`desktop/native.js`; keyboard ops are queued in order, non-ASCII on Windows goes through `desktop/win-unicode.ps1` because libnut's typeString drops it; verified with a WinForms test window). Phone has a main ON/OFF switch: while off it sends only `power` {on:false} (resent on connect and when the app joins); the helper tracks it separately from its own `p` pause. Primary monitor only. Smoke-tested on Windows (125% scaling: getScreenSize and moveMouse share the same logical px) with a simulated phone; not yet with a real phone.

- Packaging: `relay.js` holds the HTTP + WebSocket relay (`createRelay({ root })`), used by `server.js` and embedded in the desktop app. `/` is the landing page (`public/index.html`), the Yes/No demo moved to `/yesno`. `/downloads/` lists and serves archives from `downloads/`. `desktop/remote-mouse.js` starts its own relay (or reuses one on the port) and a cloudflared quick tunnel. `desktop/resources.js` finds files from the repo or, in the packaged app, `resources/` next to the exe. `scripts/build-desktop.mjs` = esbuild bundle -> SEA blob -> postject into a copy of node -> zip in `downloads/`. Windows build smoke-tested (relay, pages, libnut load). Not yet tested: the cloudflared tunnel path, macOS/Linux builds (CI workflow), the Dockerfile.

- macOS / Linux readiness (2026-11-07): CI builds macOS arm64 + x64 (`macos-15-intel`) and Linux x64, smoke-tests each exe (`--help`; Linux also runs under xvfb until it prints "Room"). `native.js` `checkPlatform()` refuses Linux non-x64 / no DISPLAY / pure Wayland with a message (libX11 would abort), warns on XWayland; on macOS it loads `libnut.node` directly (the package wrapper warns on every call without permission) and `remote-mouse.js` asks for Accessibility once via node-mac-permissions and waits. The packager copies each native module with its deps (picks up node-mac-permissions on macOS), zips macOS with `ditto`. Packaged Linux app reopens itself in a terminal when double-clicked. Phone Ctrl = Command on macOS. Fixed: relay crashed with an unhandled `ws` error when the port was busy instead of falling back.
- GitHub Pages: `pages.yml` deploys `build:web --base /PhoneWand/` (rewrites root-relative links); landing page falls back to the latest GitHub release for downloads. Not yet tested on a real Mac or Linux desktop.

## Still to do
- Try /play on a real phone: calibration feel, cursor jitter (One Euro minCutoff/beta in pointer.js), drift rate
- Ideas: snap the cursor to the nearest button, dwell-to-click, bigger hit areas on small grids

## Things to remember
- Phones only expose motion sensors on HTTPS, so use a tunnel (`cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) and open the tunnel URL on the laptop too so the QR code is correct.
- iOS needs `DeviceOrientationEvent.requestPermission()` called from a tap.
- Phone held in portrait, top edge toward the screen. Device alpha is relative (gyro), so it drifts in yaw; pitch is gravity-referenced and doesn't.
- The original tilt version worked on the user's real phone. Pointing (1D and /play) has only been tested with a simulated phone socket in the browser.
- When patching files with JS `String.replace`, `$$` in the replacement becomes `$`. Use split/join.
