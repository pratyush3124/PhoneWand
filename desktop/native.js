// Real mouse + keyboard through the prebuilt native libnut module for this OS.
// loadMouse() returns { lib, mouse, close }, where mouse is what createDesktopController expects.
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { ROOT, IS_PACKAGED } from "./resources.js";

// Resolve native packages from ROOT/node_modules (works inside the packaged app too).
const require = createRequire(path.join(ROOT, "package.json"));

// Problems we can spot before loading the native library, which can crash
// instead of throwing (libX11 aborts without a display). Returns { error } or { warning }.
export function checkPlatform(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform === "linux") {
    if (arch !== "x64") return { error: `Mouse control on Linux needs an x64 PC (this is ${arch}).` };
    if (!env.DISPLAY) {
      return {
        error: env.WAYLAND_DISPLAY
          ? "This is a Wayland session without X11 support, and Wayland blocks apps from moving the mouse.\nLog out, pick \"GNOME on Xorg\" (or your desktop's X11 session) on the login screen, and start this again."
          : "No X11 display found. Run this from a terminal inside your desktop session (DISPLAY isn't set).",
      };
    }
    if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) {
      return { warning: "This is a Wayland session: the cursor only moves over X11 (XWayland) windows, if at all.\nFor full control, log out and pick \"GNOME on Xorg\" (or your desktop's X11 session) on the login screen." };
    }
  }
  return {};
}

export function loadMouse() {
  const pkg = { win32: "libnut-win32", darwin: "libnut-darwin", linux: "libnut-linux" }[process.platform];
  if (!pkg) throw new Error(`Mouse control isn't supported on ${process.platform}.`);
  const { error } = checkPlatform();
  if (error) throw new Error(error);
  let lib;
  try {
    // On macOS, load the native module itself: the package's wrapper re-asks for
    // Accessibility permission and logs a warning on every call until it's granted.
    lib = process.platform === "darwin"
      ? require(path.join(path.dirname(require.resolve(`@nut-tree-fork/${pkg}/package.json`)), "build", "Release", "libnut.node"))
      : require(`@nut-tree-fork/${pkg}`);
  } catch (e) {
    const hint = process.platform === "linux" && /libX(tst|11)/.test(e.message)
      ? "Install the X11 test library and try again: sudo apt install libxtst6 (Fedora: sudo dnf install libXtst)."
      : IS_PACKAGED ? "Re-download the app; the resources folder may be incomplete." : 'Run "npm install" and try again.';
    throw new Error(`Couldn't load the mouse library (@nut-tree-fork/${pkg}). ${hint}\n${e.message}`);
  }
  lib.setMouseDelay(0);
  lib.setKeyboardDelay(0);

  // Wheel units differ per OS: Windows uses 120 per notch (about 100 page px),
  // macOS takes pixels, Linux (X11) takes whole notches. Positive = up / right
  // on Windows and Linux; macOS horizontal is reversed. Keep the fractions.
  const unit = { win32: 1.2, darwin: 1, linux: 1 / 50 }[process.platform];
  let accX = 0, accY = 0;
  function scroll(dx, dy) {
    accX += dx * unit; accY += -dy * unit;
    const x = Math.trunc(accX), y = Math.trunc(accY);
    accX -= x; accY -= y;
    if (x || y) lib.scrollMouse(process.platform === "darwin" ? -x : x, y);
  }

  // Keyboard actions run one after another, because non-ASCII text on Windows
  // goes through a helper process and must not overtake later keys.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
  const unicode = process.platform === "win32" ? startWinUnicode() : null;

  function type(text) {
    if (!unicode) return enqueue(() => lib.typeString(text));
    // ASCII through libnut (fast), everything else through SendInput(KEYEVENTF_UNICODE).
    for (const run of text.match(/[\x20-\x7e]+|[^\x20-\x7e]+/g) || []) {
      enqueue(/^[\x20-\x7e]/.test(run) ? () => lib.typeString(run) : () => unicode.type(run));
    }
    return chain;
  }

  // On macOS the phone's Ctrl acts as Command, so Ctrl+C copies like the user expects.
  const MOD_NAMES = { ctrl: process.platform === "darwin" ? "command" : "control", alt: "alt", shift: "shift", meta: "command" };
  return {
    lib,
    close: () => unicode?.close(),
    mouse: {
      move: (x, y) => lib.moveMouse(x, y),
      click: () => lib.mouseClick("left"),
      getPos: () => lib.getMousePos(),
      scroll,
      type,
      key: (name, mods) => enqueue(() => lib.keyTap(name, mods.map((m) => MOD_NAMES[m]))),
    },
  };
}

// macOS only moves the mouse for apps with Accessibility permission (granted to the
// terminal the app runs in). Returns null elsewhere, or when the check isn't available.
export function macAccessibility() {
  if (process.platform !== "darwin") return null;
  let perms;
  try { perms = require("@nut-tree-fork/node-mac-permissions"); } catch { return null; }
  return {
    granted: () => perms.getAuthStatus("accessibility") === "authorized",
    ask: () => perms.askForAccessibilityAccess(),
  };
}

// A long-lived PowerShell process that types Unicode text (see win-unicode.ps1).
function startWinUnicode() {
  const script = path.join(ROOT, "desktop", "win-unicode.ps1");
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const waiting = []; // resolvers, one per line sent, plus one for "ready"
  let buf = "";
  let alive = true;
  ps.on("error", () => { alive = false; });
  ps.on("exit", () => { alive = false; waiting.splice(0).forEach((r) => r()); });
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      buf = buf.slice(i + 1);
      waiting.shift()?.();
    }
  });
  const ready = new Promise((r) => waiting.push(r));
  return {
    async type(text) {
      await ready;
      if (!alive) return;
      await new Promise((r) => {
        waiting.push(r);
        ps.stdin.write(Buffer.from(text, "utf8").toString("base64") + "\n");
      });
    },
    close() { ps.stdin.end(); ps.kill(); },
  };
}
