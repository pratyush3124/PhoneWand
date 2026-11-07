# Mobile Remote: handoff notes

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
- `test.js`: 19 tests (server, relay incl. point/recenter/drag/calibrate, tilt classifier, pointer math with a simulated screen, smoothing presets), all passing
- `README.md`: run, tunnel setup, integration snippet, troubleshooting

## Still to do
- Try /play on a real phone: calibration feel, cursor jitter (One Euro minCutoff/beta in pointer.js), drift rate
- Ideas: snap the cursor to the nearest button, dwell-to-click, bigger hit areas on small grids

## Things to remember
- Phones only expose motion sensors on HTTPS, so use a tunnel (`cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) and open the tunnel URL on the laptop too so the QR code is correct.
- iOS needs `DeviceOrientationEvent.requestPermission()` called from a tap.
- Phone held in portrait, top edge toward the screen. Device alpha is relative (gyro), so it drifts in yaw; pitch is gravity-referenced and doesn't.
- The original tilt version worked on the user's real phone. Pointing (1D and /play) has only been tested with a simulated phone socket in the browser.
- When patching files with JS `String.replace`, `$$` in the replacement becomes `$`. Use split/join.
