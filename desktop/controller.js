// Turns phone remote messages into real mouse movement on the desktop.
// Pure logic: the actual mouse and screen are passed in, so this is testable.
//
//   const ctl = createDesktopController({
//     mouse: {
//       move(x, y), click(), getPos() -> { x, y },
//       scroll(dx, dy),        // page px; positive = page moves down / right
//       type(text), key(name, mods), // name from KEYS or one character; mods from MODS
//     },
//     screen: { width, height },          // in the same units as mouse.move
//     log: (text) => {},                  // optional status messages
//   });
//   connectRemote({ room, server, ...ctl.handlers });
//
// Calibration has no on-screen dots: the controller parks the real mouse
// cursor on each corner target (wiggling it a little so it's easy to spot),
// and the user aims the phone at it and taps.
//
// If the user moves the real mouse, the phone stops steering for a moment so
// the two don't fight.
import { createCalibration, CORNER_TARGETS, createOneEuro, SMOOTHING } from "../public/pointer.js";

export const STEP_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];
const DRAG_GAIN = 0.5; // a full-width swipe on the phone touchpad moves half the screen
const SNAP_PX = 40; // a tap this close to the shown cursor clicks at the cursor
const USER_MOVE_PX = 3; // real mouse moved more than this since we set it = the user took over
const USER_PAUSE_MS = 1500; // phone steering pauses this long after the last real mouse move
const WIGGLE_PX = 10;
const SCROLL_GAIN = 2.5; // page px scrolled per phone px of finger movement
export const KEYS = new Set(["backspace", "delete", "enter", "tab", "escape", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
export const MODS = new Set(["ctrl", "alt", "shift", "meta"]);
const MAX_TEXT = 500;
const MAX_REPEAT = 200;

export function createDesktopController({
  mouse,
  screen,
  log = () => {},
  now = () => performance.now(),
  smoothing = "medium",
}) {
  const W = screen.width, H = screen.height;
  const preset = SMOOTHING[smoothing] || SMOOTHING.medium;
  const fx = createOneEuro(preset), fy = createOneEuro(preset);

  let calibration = null;
  let calibSid = null; // phone page session the calibration belongs to
  let seenSid = null;
  let calib = null; // { step, dirs } while calibrating
  let nudge = [0, 0]; // touchpad offset in px, added after smoothing
  let gyroPos = null; // smoothed pointing position in px, before the nudge
  let cursor = null; // where we last put the cursor (px)
  let lastSet = null; // last position we gave mouse.move (rounded), to spot real mouse moves
  let userUntil = 0;
  let paused = false;
  let lastV = null;

  const clampX = (x) => Math.min(W - 1, Math.max(0, x));
  const clampY = (y) => Math.min(H - 1, Math.max(0, y));

  function moveTo(x, y) {
    const p = { x: Math.round(clampX(x)), y: Math.round(clampY(y)) };
    if (lastSet && p.x === lastSet.x && p.y === lastSet.y) return;
    mouse.move(p.x, p.y);
    lastSet = p;
  }

  // True while the user is using the real mouse (or the helper is paused).
  function userHasMouse(t) {
    if (paused) return true;
    const p = mouse.getPos();
    if (lastSet && Math.hypot(p.x - lastSet.x, p.y - lastSet.y) > USER_MOVE_PX) {
      if (t >= userUntil) log("Mouse moved by hand: phone pointing paused");
      userUntil = t + USER_PAUSE_MS;
      lastSet = p; // compare future moves against where the user left it
    }
    if (t < userUntil) return true;
    if (userUntil) {
      userUntil = 0;
      fx.reset(); fy.reset();
      log("Phone pointing resumed");
    }
    return false;
  }

  function resetSmoothing() { fx.reset(); fy.reset(); gyroPos = null; }

  function startCalibration(reason = "") {
    calib = { step: 0, dirs: [] };
    nudge = [0, 0];
    resetSmoothing();
    userUntil = 0;
    log((reason ? reason + " " : "") + "Calibrating: aim the phone's top edge at the mouse cursor in each corner and tap the touchpad.");
    logStep();
    showTarget();
  }

  function targetPx(step) {
    const [tx, ty] = CORNER_TARGETS[step];
    return [tx * W, ty * H];
  }

  function showTarget(t = now()) {
    const [x, y] = targetPx(calib.step);
    const a = (t / 1000) * 2 * Math.PI; // one small circle per second
    moveTo(x + WIGGLE_PX * Math.cos(a), y + WIGGLE_PX * Math.sin(a));
  }

  function logStep() {
    log(`  ${calib.step + 1}/4: point at the cursor in the ${STEP_NAMES[calib.step]} corner and tap`);
  }

  function calibrationTap(v, sid) {
    if (!v) return log("No pointing data yet: tap Start motion on the phone.");
    calib.dirs.push(v);
    calib.step++;
    if (calib.step < 4) {
      logStep();
      return showTarget();
    }
    const c = createCalibration(calib.dirs);
    if (c.error) {
      log(c.error);
      calib = { step: 0, dirs: [] };
      logStep();
      return showTarget();
    }
    calibration = c;
    calibSid = sid;
    calib = null;
    nudge = [0, 0];
    resetSmoothing();
    moveTo(W / 2, H / 2);
    log("Calibrated. Touchpad: tap = click, drag = fine move, hold = recenter.");
  }

  function mapRaw(v) {
    const f = calibration?.map(v);
    return f ? [f[0] * W, f[1] * H] : null;
  }

  function render() {
    if (!gyroPos) return;
    cursor = [clampX(gyroPos[0] + nudge[0]), clampY(gyroPos[1] + nudge[1])];
    moveTo(cursor[0], cursor[1]);
  }

  function onPoint(msg) {
    lastV = msg.v;
    const t = now();
    if (msg.sid !== seenSid) {
      seenSid = msg.sid;
      if (msg.sid !== calibSid) {
        // New phone page session: its sensor reference may differ, so recalibrate.
        const had = !!calibration || !!calib;
        calibration = null;
        startCalibration(had ? "Phone page reloaded." : "");
      }
    }
    if (calib) {
      if (!paused) showTarget(t);
      return;
    }
    if (!calibration || userHasMouse(t)) return;
    const p = mapRaw(msg.v);
    if (!p) return;
    gyroPos = [fx.filter(p[0], t), fy.filter(p[1], t)];
    render();
  }

  function onClick(msg) {
    const v = msg.v || lastV;
    if (calib) return calibrationTap(v, msg.sid ?? seenSid);
    if (!calibration) return startCalibration();
    if (userHasMouse(now())) {
      // The user is steering with the real mouse: the phone is just a clicker.
      mouse.click();
      return;
    }
    // Click where the phone was aimed when the finger touched down (before the
    // tap jolted it), unless that's right next to the cursor the user can see.
    let p = v && mapRaw(v);
    if (p) p = [p[0] + nudge[0], p[1] + nudge[1]];
    if (!p || (cursor && Math.hypot(p[0] - cursor[0], p[1] - cursor[1]) < SNAP_PX)) p = cursor;
    if (!p) return;
    moveTo(p[0], p[1]);
    mouse.click();
  }

  function onDrag(msg) {
    if (!calibration || calib || !gyroPos || paused) return;
    const w = msg.w > 50 ? msg.w : 360;
    const k = (DRAG_GAIN * W) / w; // phone px -> screen px
    nudge = [nudge[0] + msg.dx * k, nudge[1] + msg.dy * k];
    userUntil = 0;
    render();
  }

  function onRecenter(msg) {
    if (!calibration || calib || !msg.v) return;
    calibration.recenter(msg.v);
    nudge = [0, 0];
    resetSmoothing();
    userUntil = 0;
    moveTo(W / 2, H / 2);
    log("Recentered: the cursor is now in the middle of the screen.");
  }

  function onCalibrate() {
    startCalibration();
  }

  // Natural scrolling, like a phone: fingers move up = the page moves up (you read further down).
  function onScroll(msg) {
    if (paused || calib) return;
    mouse.scroll(-msg.dx * SCROLL_GAIN, -msg.dy * SCROLL_GAIN);
  }

  function onText(text) {
    if (paused || typeof text !== "string" || !text) return;
    mouse.type(text.slice(0, MAX_TEXT));
  }

  function onKey({ key, mods = [], repeat = 1 }) {
    if (paused || typeof key !== "string") return;
    key = key.toLowerCase();
    if (!KEYS.has(key) && !(key.length === 1 && key.trim())) return;
    const m = [...new Set(mods)].filter((x) => MODS.has(x));
    const n = Math.min(MAX_REPEAT, Math.max(1, Math.floor(Number(repeat)) || 1));
    for (let i = 0; i < n; i++) mouse.key(key, m);
  }

  return {
    handlers: { onPoint, onClick, onDrag, onRecenter, onCalibrate, onScroll, onText, onKey },
    startCalibration: onCalibrate,
    cancelCalibration() {
      if (!calib) return;
      calib = null;
      log(calibration ? "Calibration cancelled: keeping the previous one." : "Calibration cancelled.");
    },
    setPaused(p) {
      paused = p;
      if (!p) { resetSmoothing(); userUntil = 0; lastSet = null; }
      log(p ? "Paused: the phone won't move the mouse." : "Resumed.");
    },
    get paused() { return paused; },
    get calibrated() { return !!calibration; },
    get calibrating() { return calib ? calib.step : null; },
  };
}
