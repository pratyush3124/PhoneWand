#!/usr/bin/env node
// Desktop helper: the phone remote moves and clicks your real mouse, so it works
// in any browser tab (or any app), not just pages that load remote-client.js.
//
//   npm run mouse -- --public https://your-tunnel.trycloudflare.com
//
// Options:
//   --public URL   public https URL of the relay (put in the QR code for the phone)
//   --server URL   relay this helper connects to (default http://localhost:$PORT or 8080)
//   --room CODE    room code to use (default: a new random one)
//   --smooth light|medium|strong   cursor smoothing (default medium)
//
// Keys while running: c = calibrate, p = pause/resume, Esc = cancel calibration, q = quit.
import { parseArgs } from "node:util";
import qrcode from "qrcode-generator";
import { connectRemote, makeRoomCode } from "../public/remote-client.js";
import { createDesktopController } from "./controller.js";
import { loadMouse } from "./native.js";

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;

const { values: opts } = parseArgs({
  options: {
    public: { type: "string" },
    server: { type: "string", default: `http://localhost:${process.env.PORT || 8080}` },
    room: { type: "string" },
    smooth: { type: "string", default: "medium" },
    help: { type: "boolean", short: "h" },
  },
});

if (opts.help) {
  console.log("Usage: npm run mouse -- --public https://<tunnel-url> [--server URL] [--room CODE] [--smooth light|medium|strong]");
  process.exit(0);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}


function printQr(text) {
  const q = qrcode(0, "L");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  // Two QR rows per text line with half blocks; light-on-dark terminals need the
  // colours inverted, so draw dark modules as spaces on a white background.
  const lines = [];
  for (let r = -m; r < n + m; r += 2) {
    let line = "";
    for (let c = -m; c < n + m; c++) {
      const top = dark(r, c), bottom = dark(r + 1, c);
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push("  " + line);
  }
  console.log(lines.join("\n"));
}

// ---------- setup ----------
const room = opts.room ?? makeRoomCode();
if (!ROOM_RE.test(room)) fail("Room codes must be 4-64 letters, digits, - or _.");

let publicOrigin = null;
if (opts.public) {
  let u;
  try { u = new URL(opts.public); } catch { fail(`--public: "${opts.public}" isn't a URL.`); }
  if (u.protocol !== "https:") fail("--public must be an https URL: phones only give motion data on HTTPS.");
  publicOrigin = u.origin;
} else {
  try {
    const u = new URL(opts.server);
    if (u.protocol === "https:") publicOrigin = u.origin;
  } catch { fail(`--server: "${opts.server}" isn't a URL.`); }
}

let lib, mouse, closeMouse;
try {
  ({ lib, mouse, close: closeMouse } = loadMouse());
} catch (e) {
  fail(e.message);
}
const screen = lib.getScreenSize();
const stamp = () => new Date().toLocaleTimeString();
const log = (text) => console.log(`[${stamp()}] ${text}`);
const ctl = createDesktopController({ mouse, screen, log, smoothing: opts.smooth });

console.log(`\nPhone mouse: room ${room}, screen ${screen.width}x${screen.height}, relay ${opts.server}`);
if (publicOrigin) {
  const url = `${publicOrigin}/phone?room=${encodeURIComponent(room)}`;
  console.log(`\nScan with your phone (or open ${url}):\n`);
  printQr(url);
} else {
  console.log(
    "\nNo public https URL given, so there's no QR code. Start a tunnel (cloudflared tunnel --url http://localhost:8080)\n" +
      `and either rerun with --public https://<tunnel-url>, or open https://<tunnel-url>/phone?room=${room} on the phone.`,
  );
}
console.log("\nKeys: c = calibrate, p = pause/resume, Esc = cancel calibration, q = quit\n");

let phone = false;
let server = null;
const remote = connectRemote({
  room,
  server: opts.server,
  ...ctl.handlers,
  onStatus(s) {
    if (s.server !== server) {
      server = s.server;
      if (server === "connected") log("Connected to the relay.");
      else if (server === "disconnected") log(`Can't reach the relay at ${opts.server}. Is "npm start" running? Retrying...`);
    }
    if (s.phone !== phone) {
      phone = s.phone;
      log(phone ? "Phone connected. Tap Start motion on the phone." : "Phone disconnected.");
    }
  },
});

function quit() {
  remote.close();
  closeMouse?.();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log("Bye.");
  process.exit(0);
}

process.on("SIGINT", quit);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key) => {
    if (key === "\u0003" || key === "q") quit(); // Ctrl+C in raw mode arrives as a key
    else if (key === "c") ctl.startCalibration();
    else if (key === "p") ctl.setPaused(!ctl.paused);
    else if (key === "\u001b") ctl.cancelCalibration();
  });
}
