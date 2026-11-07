#!/usr/bin/env node
// Desktop app: the phone remote moves and clicks your real mouse, so it works
// in any browser tab (or any app), not just pages that load remote-client.js.
//
//   npm run mouse                 (or double-click the packaged PhoneWand app)
//
// With no options it runs everything itself: a relay on localhost (reusing one that's
// already running there), plus a free Cloudflare quick tunnel when `cloudflared` is
// installed, so the phone gets the HTTPS link it needs. Then it prints a QR code.
//
// Options:
//   --server URL   use this relay instead of starting one (e.g. your hosted web app)
//   --public URL   public https URL of the relay, for the QR code (skips the tunnel)
//   --port N       port for the built-in relay (default $PORT or 8080)
//   --no-tunnel    don't start cloudflared
//   --room CODE    room code to use (default: a new random one)
//   --smooth light|medium|strong   cursor smoothing (default medium)
//
// Keys while running: c = calibrate, p = pause/resume, Esc = cancel calibration, q = quit.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import qrcode from "qrcode-generator";
import { connectRemote, makeRoomCode } from "../public/remote-client.js";
import { createRelay } from "../relay.js";
import { createDesktopController } from "./controller.js";
import { checkPlatform, loadMouse, macAccessibility } from "./native.js";
import { ROOT, IS_PACKAGED } from "./resources.js";

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const USAGE = `Usage: ${IS_PACKAGED ? "phonewand" : "npm run mouse --"} [--server URL] [--public URL] [--port N] [--no-tunnel] [--room CODE] [--smooth light|medium|strong]`;

const stamp = () => new Date().toLocaleTimeString();
const log = (text) => console.log(`[${stamp()}] ${text}`);
const cleanups = [];

// In the packaged app the console window closes as soon as we exit, so keep it
// open long enough to read the error.
function fail(msg) {
  console.error("\n" + msg);
  cleanups.forEach((f) => f());
  if (IS_PACKAGED && process.stdin.isTTY) {
    console.error("\nPress Enter to close.");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } else process.exit(1);
}

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      public: { type: "string" },
      server: { type: "string" },
      port: { type: "string", default: String(process.env.PORT || 8080) },
      "no-tunnel": { type: "boolean" },
      room: { type: "string" },
      smooth: { type: "string", default: "medium" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (e) {
  fail(`${e.message}\n${USAGE}`);
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

async function isRelay(port) {
  try {
    const res = await fetch(`http://localhost:${port}/remote-client.js`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes("connectRemote");
  } catch {
    return false;
  }
}

// Start the built-in relay. If the port is taken by another relay (say `npm start`), use that one.
async function startLocalRelay(port) {
  const { server } = createRelay({ root: ROOT });
  const listen = (p) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, () => { server.off("error", reject); resolve(server.address().port); });
  });
  try {
    return await listen(port);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    if (await isRelay(port)) {
      log(`Using the relay already running on port ${port}.`);
      return port;
    }
    const p = await listen(0);
    log(`Port ${port} is busy, so the relay is on port ${p}.`);
    return p;
  }
}

function cloudflaredCandidates() {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const local = [path.join(ROOT, exe), path.join(path.dirname(process.execPath), exe)];
  if (process.platform === "win32") {
    for (const dir of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (dir) local.push(path.join(dir, "cloudflared", exe));
    }
  } else local.push("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared");
  return [...local.filter((f) => fs.existsSync(f)), "cloudflared"];
}

// Free Cloudflare quick tunnel: resolves to its https origin, or null if it can't start.
async function startTunnel(port) {
  for (const bin of cloudflaredCandidates()) {
    const url = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        return resolve(null);
      }
      let found = false;
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 30000);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      proc.on("error", () => done(null)); // not installed at this path
      proc.on("exit", () => {
        if (found) log("The tunnel stopped. Restart the app to get a new link.");
        else done(null);
      });
      const scan = (d) => {
        const m = !found && d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          found = true;
          cleanups.push(() => proc.kill());
          done(m[0]);
        }
      };
      proc.stdout.on("data", scan);
      proc.stderr.on("data", scan);
    });
    if (url) {
      // A new quick tunnel takes a few seconds before it answers.
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        try {
          if ((await fetch(url + "/healthz", { signal: AbortSignal.timeout(3000) })).ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      return url;
    }
  }
  return null;
}

// Linux file managers start a double-clicked program without a window, so the
// packaged app reopens itself in a terminal (where the QR code and keys live).
function reopenInTerminal() {
  if (!IS_PACKAGED || process.platform !== "linux" || process.stdin.isTTY || process.env.PHONEWAND_TERMINAL) return false;
  const args = [process.execPath, ...process.argv.slice(2)];
  const terminals = [
    ["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xfce4-terminal", "-x"],
    ["mate-terminal", "-x"], ["tilix", "-e"], ["kitty"], ["alacritty", "-e"], ["xterm", "-e"],
  ];
  const dirs = (process.env.PATH || "/usr/bin:/bin").split(":");
  for (const [term, ...flag] of terminals) {
    if (!dirs.some((d) => fs.existsSync(path.join(d, term)))) continue;
    spawn(term, [...flag, ...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PHONEWAND_TERMINAL: "1" },
    }).unref();
    return true;
  }
  return false;
}

// Waits until the terminal running the app may control the mouse.
async function waitForMacAccessibility() {
  const access = macAccessibility();
  if (!access) {
    if (process.platform === "darwin") log("If the cursor doesn't move, allow this terminal under System Settings > Privacy & Security > Accessibility.");
    return;
  }
  if (access.granted()) return;
  access.ask();
  console.log(
    "\nmacOS needs your permission before PhoneWand can move the mouse.\n" +
      "  Open System Settings > Privacy & Security > Accessibility and switch on the app\n" +
      "  this runs in (Terminal, or your terminal app). Waiting for it...",
  );
  while (!access.granted()) await new Promise((r) => setTimeout(r, 1000));
  log("Accessibility permission granted.");
}

async function main() {
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (reopenInTerminal()) process.exit(0);
  console.log("\nPhoneWand: your phone is the mouse.\n");

  const room = opts.room ?? makeRoomCode();
  if (!ROOM_RE.test(room)) return fail("Room codes must be 4-64 letters, digits, - or _.");

  let publicOrigin = null;
  if (opts.public) {
    let u;
    try { u = new URL(opts.public); } catch { return fail(`--public: "${opts.public}" isn't a URL.`); }
    if (u.protocol !== "https:") return fail("--public must be an https URL: phones only give motion data on HTTPS.");
    publicOrigin = u.origin;
  }

  let serverUrl = opts.server;
  if (serverUrl) {
    let u;
    try { u = new URL(serverUrl); } catch { return fail(`--server: "${serverUrl}" isn't a URL.`); }
    if (!publicOrigin && u.protocol === "https:") publicOrigin = u.origin;
  } else {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail(`--port: "${opts.port}" isn't a port number.`);
    let actual;
    try { actual = await startLocalRelay(port); } catch (e) { return fail(`Couldn't start the relay: ${e.message}`); }
    serverUrl = `http://localhost:${actual}`;
    if (!publicOrigin && !opts["no-tunnel"]) {
      log("Opening a secure tunnel for the phone (cloudflared)...");
      publicOrigin = await startTunnel(actual);
      if (publicOrigin) log(`Tunnel ready: ${publicOrigin}`);
    }
  }

  const { warning } = checkPlatform();
  if (warning) console.log(`\n${warning}`);
  await waitForMacAccessibility();

  let lib, mouse, closeMouse;
  try {
    ({ lib, mouse, close: closeMouse } = loadMouse());
  } catch (e) {
    return fail(e.message);
  }
  cleanups.push(() => closeMouse?.());
  const screen = lib.getScreenSize();
  const ctl = createDesktopController({ mouse, screen, log, smoothing: opts.smooth });

  console.log(`\nRoom ${room}, screen ${screen.width}x${screen.height}, relay ${serverUrl}`);
  if (publicOrigin) {
    const url = `${publicOrigin}/phone?room=${encodeURIComponent(room)}`;
    console.log(`\nScan with your phone (or open ${url}):\n`);
    printQr(url);
  } else {
    const install = {
      win32: "winget install --id Cloudflare.cloudflared",
      darwin: "brew install cloudflared",
    }[process.platform] ?? "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
    console.log(
      "\nNo public https link, so there's no QR code yet. Phones only share motion data over HTTPS.\n" +
        `  Easiest: install cloudflared (${install}) and start this again.\n` +
        `  Or run your own tunnel to ${serverUrl} and start this with --public https://<tunnel-url>.`,
    );
  }
  console.log("\nKeys: c = calibrate, p = pause/resume, Esc = cancel calibration, q = quit\n");

  let phone = false;
  let status = null;
  const remote = connectRemote({
    room,
    server: serverUrl,
    ...ctl.handlers,
    onStatus(s) {
      if (s.server !== status) {
        status = s.server;
        if (status === "connected") log("Connected to the relay.");
        else if (status === "disconnected") log(`Can't reach the relay at ${serverUrl}. Retrying...`);
      }
      if (s.phone !== phone) {
        phone = s.phone;
        log(phone ? "Phone connected. Tap Start motion on the phone." : "Phone disconnected.");
      }
    },
  });

  function quit() {
    remote.close();
    cleanups.forEach((f) => f());
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.log("Bye.");
    process.exit(0);
  }

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
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
}

main().catch((e) => fail(e.stack || e.message));
