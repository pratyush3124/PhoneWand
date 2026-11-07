// Real mouse + keyboard through the prebuilt native libnut module for this OS.
// loadMouse() returns { lib, mouse, close }, where mouse is what createDesktopController expects.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function loadMouse() {
  const pkg = { win32: "libnut-win32", darwin: "libnut-darwin", linux: "libnut-linux" }[process.platform];
  if (!pkg) throw new Error(`Mouse control isn't supported on ${process.platform}.`);
  let lib;
  try {
    lib = require(`@nut-tree-fork/${pkg}`);
  } catch (e) {
    throw new Error(`Couldn't load the mouse library (@nut-tree-fork/${pkg}). Run "npm install" and try again.\n${e.message}`);
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

  const MOD_NAMES = { ctrl: "control", alt: "alt", shift: "shift", meta: "command" };
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

// A long-lived PowerShell process that types Unicode text (see win-unicode.ps1).
function startWinUnicode() {
  const script = fileURLToPath(new URL("./win-unicode.ps1", import.meta.url));
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
