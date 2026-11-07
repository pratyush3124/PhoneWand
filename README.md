# Mobile Remote

Use your phone like a Wii remote for a web app on your laptop. Aim the **top edge** of the phone at the screen.

Two demo pages:

- **`/play` (Pointer Playground):** a 2D cursor follows where the phone points. Calibrate once by pointing at 4 corner dots, then try four modes: **Buttons** (light up grids from 6 to 84 buttons), **Targets** (timed target practice), **Keyboard** (type phrases on an on-screen keyboard), **Paint** (tap to put the pen down / lift it).
- **`/` (Yes/No demo):** point left of the screen for **Yes**, right for **No**, tap to choose.

The phone screen is split in two:

- **Top half (controls):** **Calibrate** (opens the 4-corner calibration on the laptop right away), **Recenter**, **Start motion**, and **Keyboard**.
- **Bottom half (touchpad):** **tap** = click, **drag** = move the cursor precisely (a full-width swipe moves it half the screen), **hold 0.7 s** = recenter, **two fingers** or the **right-edge strip** = scroll (scroll and keyboard are handled by the desktop helper; web pages get them as `onScroll` / `onText` / `onKey`).

```
Phone (/phone) ──WebSocket──▶ server.js (relay) ──WebSocket──▶ Web page (/play or /)
                  paired by a random room code, shared through a QR code
```

## Run it

Requires Node 18+.

```bash
npm install
```

```bash
npm start
```

The server listens on `http://localhost:8080` (set `PORT` to change it).

### Phones need HTTPS

Mobile browsers only give motion-sensor data to secure (HTTPS) pages, so expose the server through a tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

or

```bash
ngrok http 8080
```

Then either:

- **Recommended:** open the tunnel's `https://…` URL on the laptop too. The QR code then points at the right place automatically.
- Or keep using `http://localhost:8080` on the laptop and paste the tunnel URL into the **Public HTTPS URL** box in the pairing panel. It's remembered for next time.

Scan the QR code with the phone and tap **Start motion** or the touchpad (on iOS, allow motion access). Hold the phone in portrait and aim its top edge at the laptop screen.

### Calibrating the 2D cursor (`/play`)

When the phone connects (or whenever you press **Calibrate** on the phone), the playground asks you to point at 4 dots near the screen corners (top-left, top-right, bottom-right, bottom-left) and tap the touchpad on each. Then a center dot checks the result and tells you how many pixels off the tap landed.

- Calibrate from where you'll actually play. The mapping is exact for that spot; walking around shifts it.
- Hold steady and tap gently. The click uses where the phone pointed the moment your finger touched, so the tap's jolt doesn't matter much.
- Phone gyros drift slowly left/right over minutes. When the cursor creeps off, aim at the middle of the screen and press **Recenter** (or hold the touchpad). No need to redo all 4 corners.
- For small targets, aim roughly and finish with a short drag on the touchpad. The drag offset stays until you recenter or recalibrate.
- Reloading the phone page resets its sensors, so the playground asks you to calibrate again. Reloading the laptop page keeps the calibration.

On the Yes/No page, pointing about 15° left or right of where you started selects.

### Testing without a phone

On the Yes/No page: `←` highlights Yes, `→` highlights No, `↓` clears, `Enter` clicks. In the playground everything also works with the mouse, and the Keyboard mode accepts real typing.

## Control your whole desktop (any browser tab)

The demo pages only react to the phone because they load `remote-client.js`. To use the phone as a mouse everywhere (YouTube, Gmail, the tab bar, other apps), run the desktop helper. It joins a room like a web page would, but it moves and clicks your **real mouse pointer**.

1. Start the relay and a tunnel as above (`npm start`, then `cloudflared tunnel --url http://localhost:8080`).
2. In another terminal:

   ```bash
   npm run mouse -- --public https://<your-tunnel>.trycloudflare.com
   ```

3. Scan the QR code it prints, then tap **Start motion** on the phone.
4. Calibrate: the helper puts the mouse pointer in each corner of the screen, wiggling it slightly. Aim the phone's top edge at it and tap the touchpad, 4 times.

Then the pointer follows the phone. **Tap** = left click, **drag** = fine move, **hold** = recenter (aim at the middle of the screen first), **Calibrate** on the phone = redo the corners.

- **Scroll:** drag with **two fingers** anywhere on the touchpad, or with one finger in the **strip on its right edge**. It scrolls like a phone: move your fingers up and the page moves up.
- **Keyboard:** tap **Keyboard** on the phone and type. Text goes to whatever has focus on the laptop. Autocorrect, emoji and accented letters work (on Windows, non-ASCII text is typed by a small PowerShell helper, `desktop/win-unicode.ps1`). The key row has Esc, Tab, arrows, Backspace, Home/End, PgUp/PgDn and Enter. **Ctrl / Alt / Shift** apply to the next key or letter, so Ctrl then `c` = copy.

- Touch the real mouse and the phone backs off for 1.5 s, so they don't fight. While it's backed off, a phone tap clicks wherever the mouse pointer is.
- Keys in the helper's terminal: `c` calibrate, `p` pause/resume, `Esc` cancel calibration, `q` quit.
- Options: `--server URL` (relay to connect to, default `http://localhost:8080`), `--room CODE` (reuse a room), `--smooth light|medium|strong`.
- It uses the primary monitor only.
- The mouse library (`@nut-tree-fork/libnut-*`) is an optional native dependency with prebuilt binaries for Windows, macOS and Linux (X11). On macOS, give your terminal Accessibility permission (System Settings → Privacy & Security → Accessibility). On Windows, it can't click inside windows running as administrator unless the helper's terminal is also running as administrator.

## Use it in your own web app

Serve this project's server (or copy its relay), then on your page:

```html
<script type="module">
  import { connectRemote, makeRoomCode } from "/remote-client.js";

  const room = sessionStorage.getItem("room") || makeRoomCode();
  sessionStorage.setItem("room", room);
  // Show `${PUBLIC_HTTPS_ORIGIN}/phone?room=${room}` as a QR code / link.

  let highlighted = "center";
  const remote = connectRemote({
    room,
    onHighlight: (v) => { highlighted = v; /* "yes" | "no" | "center": style your buttons */ },
    onClick: () => { if (highlighted !== "center") document.getElementById(highlighted).click(); },
    onTilt: (deg) => { /* optional live pointing angle from center, negative = left */ },
    onPoint: ({ v }) => { /* 2D: where the top edge points, unit vector [east, north, up] */ },
    onRecenter: ({ v }) => { /* phone was long-pressed while pointing at v */ },
    onStatus: ({ server, phone }) => { /* "connecting" | "connected" | "disconnected", phone: boolean */ },
  });
  // remote.close() when you're done
</script>
```

If your app is hosted somewhere else, pass `server: "https://your-relay-host"` to `connectRemote`. A QR library is served at `/vendor/qrcode.mjs` (`qrcode-generator`). See [public/app.html](public/app.html) for a full example.

For a 2D cursor, use [public/pointer.js](public/pointer.js): collect 4 `click.v` vectors while the user points at known spots, pass them to `createCalibration(dirs, targets)`, then `calibration.map(point.v)` gives screen fractions `[x, y]`. Smooth them with `createOneEuro()`. [public/play.html](public/play.html) shows the whole flow, including hover, clicks and recenter.

## Server details

- WebSocket endpoint: `/ws?role=phone|app&room=CODE`
- Room codes must match `[A-Za-z0-9_-]{4,64}`; anything else is closed with code 1008
- At most 6 clients per room (extra ones are closed with code 1013 "room full")
- Only the phone can send control messages, and only `highlight`, `click`, `tilt`, `point`, `recenter`, `drag` and `calibrate`; they go to app clients only
- `drag` is `{ dx, dy, w }`: finger movement on the touchpad in phone px, and the pad's width
- `point` arrives about 60 times a second: `{ type: "point", v: [x, y, z], sid }`. `sid` changes when the phone page reloads.
- Each side gets `peer-joined` / `peer-left` messages about the other side
- Empty rooms are forgotten after 6 hours

## Tests

```bash
npm test
```

Starts the server on a random port and checks static files, path-traversal blocking, relaying, room isolation, room-code validation, the client cap, the left/right classifier, the 2D pointer math (including a simulated screen at different angles, drift + recenter, and rejecting bad corner sets), and the desktop helper's logic with a fake mouse.

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone shows **Needs HTTPS** | Open the phone link through the `https://` tunnel URL, not `http://` or a LAN IP. |
| QR code says to enter a URL | You opened the laptop page on localhost. Paste the tunnel's https URL into the box, or open the tunnel URL on the laptop. |
| "No motion data received" | iOS: tap again and allow motion access (or Settings → Safari → Motion & Orientation Access). Android: check Chrome site settings → Motion sensors. |
| "Motion access denied" on iOS | Close the tab and reopen the link; iOS only asks once per page load. |
| Cursor or selection drifts sideways over time | Aim at the middle of the screen and long-press the phone screen to recenter. Phone gyros drift slowly, so recenter now and then. |
| Cursor is jittery | Click **Smooth** in the top bar to cycle Light / Medium / Strong. Strong is steadiest but trails fast moves slightly. Resting your elbow helps a lot too. |
| Cursor is off in one area of the screen | Press **Calibrate** and redo the 4 corners from where you're sitting, holding the phone steady on each dot. |
| "The corners came out in the wrong order" | Point at the dots in the order shown (the pulsing one), and move the phone clearly between them. |
| Cursor moves the wrong way vertically | Make sure you aim with the **top edge** of the phone (not the back camera) during calibration and play. |
| Phone status stays "not paired" / "No phone" | Make sure the phone's room code matches the one on the laptop (press **New code** and rescan if unsure), and that both use the same server. |
| Free tunnel URL changed | Quick tunnels get a new URL each run: update the URL box or reopen the laptop page on the new URL, then rescan. |
| Screen dims while playing | The phone page requests a wake lock; some browsers ignore it. Raise the screen timeout. |
