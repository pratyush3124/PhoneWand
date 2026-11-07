// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { createTiltClassifier } from "./public/tilt.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;
let proc;

before(async () => {
  proc = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 5000);
    proc.stdout.on("data", (d) => { if (d.toString().includes("running")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => proc?.kill());

// ---------- helpers ----------
function connect(role, room) {
  const ws = new WebSocket(`${WS}?role=${role}&room=${room}`);
  ws.inbox = [];
  ws.waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const i = ws.waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(msg);
    else ws.inbox.push(msg);
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
function next(ws, pred = () => true, ms = 1000) {
  const i = ws.inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(ws.inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    ws.waiters.push(w);
    setTimeout(() => { ws.waiters.splice(ws.waiters.indexOf(w), 1); reject(new Error("timeout")); }, ms);
  });
}
async function nothing(ws, pred = () => true, ms = 250) {
  await assert.rejects(next(ws, pred, ms), /timeout/);
}
const closeCode = (ws) => new Promise((r) => ws.once("close", (code, reason) => r({ code, reason: reason.toString() })));
const room = () => "T" + Math.random().toString(36).slice(2, 10);

// ---------- static files ----------
test("serves app, phone page, scripts and QR library", async () => {
  for (const [p, type, text] of [
    ["/", "text/html", "Mobile Remote Demo"],
    ["/phone", "text/html", "Phone Remote"],
    ["/remote-client.js", "text/javascript", "connectRemote"],
    ["/tilt.js", "text/javascript", "createTiltClassifier"],
    ["/play", "text/html", "Pointer Playground"],
    ["/pointer.js", "text/javascript", "createCalibration"],
    ["/pairing.js", "text/javascript", "setupPairing"],
    ["/vendor/qrcode.mjs", "text/javascript", "export default qrcode"],
  ]) {
    const res = await fetch(HTTP + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type"), new RegExp(type), p);
    assert.match(await res.text(), new RegExp(text), p);
  }
});

test("404 for missing files and blocks path traversal", async () => {
  assert.equal((await fetch(HTTP + "/nope.html")).status, 404);
  for (const p of ["/..%2fserver.js", "/%2e%2e/server.js", "/..%5cserver.js"]) {
    const res = await fetch(HTTP + p);
    assert.notEqual(res.status, 200, p);
  }
});

// ---------- relay ----------
test("relays phone messages to the app", async () => {
  const r = room();
  const app = await connect("app", r);
  const phone = await connect("phone", r);
  assert.deepEqual(await next(app, (m) => m.type === "peer-joined"), { type: "peer-joined", role: "phone" });
  assert.deepEqual(await next(phone, (m) => m.type === "peer-joined"), { type: "peer-joined", role: "app" });

  phone.send(JSON.stringify({ type: "highlight", value: "yes" }));
  assert.deepEqual(await next(app), { type: "highlight", value: "yes" });
  phone.send(JSON.stringify({ type: "tilt", value: -25 }));
  assert.deepEqual(await next(app), { type: "tilt", value: -25 });
  phone.send(JSON.stringify({ type: "click", v: [0, 1, 0], sid: "abc" }));
  assert.deepEqual(await next(app), { type: "click", v: [0, 1, 0], sid: "abc" });
  phone.send(JSON.stringify({ type: "point", v: [0.1, 0.99, 0.05], sid: "abc" }));
  assert.deepEqual(await next(app), { type: "point", v: [0.1, 0.99, 0.05], sid: "abc" });
  phone.send(JSON.stringify({ type: "recenter", v: [0, 1, 0], sid: "abc" }));
  assert.deepEqual(await next(app), { type: "recenter", v: [0, 1, 0], sid: "abc" });

  phone.close();
  assert.deepEqual(await next(app, (m) => m.type === "peer-left"), { type: "peer-left", role: "phone" });
  app.close();
});

test("phone joining first: app is told the phone is already there", async () => {
  const r = room();
  const phone = await connect("phone", r);
  const app = await connect("app", r);
  assert.deepEqual(await next(app, (m) => m.type === "peer-joined"), { type: "peer-joined", role: "phone" });
  phone.close(); app.close();
});

test("app cannot send control messages; unknown types and bad JSON are dropped", async () => {
  const r = room();
  const app = await connect("app", r);
  const phone = await connect("phone", r);
  await next(app, (m) => m.type === "peer-joined");
  await next(phone, (m) => m.type === "peer-joined");

  app.send(JSON.stringify({ type: "click" }));
  await nothing(phone);
  phone.send(JSON.stringify({ type: "peer-left", role: "phone" }));
  phone.send(JSON.stringify({ type: "evil" }));
  phone.send("not json");
  await nothing(app);
  phone.close(); app.close();
});

test("rooms are isolated", async () => {
  const appA = await connect("app", room());
  const phoneB = await connect("phone", room());
  phoneB.send(JSON.stringify({ type: "click" }));
  await nothing(appA);
  appA.close(); phoneB.close();
});

test("rejects bad room codes", async () => {
  for (const bad of ["", "abc", "has space", "x".repeat(65), "a/b/c/d"]) {
    const ws = new WebSocket(`${WS}?role=app&room=${encodeURIComponent(bad)}`);
    const { code } = await closeCode(ws);
    assert.equal(code, 1008, JSON.stringify(bad));
  }
});

test("caps clients per room at 6", async () => {
  const r = room();
  const socks = [];
  for (let i = 0; i < 6; i++) socks.push(await connect("app", r));
  const extra = new WebSocket(`${WS}?role=app&room=${r}`);
  const { code, reason } = await closeCode(extra);
  assert.equal(code, 1013);
  assert.equal(reason, "room full");
  socks.forEach((s) => s.close());
});

test("second phone leaving doesn't mark the remaining phone as gone", async () => {
  const r = room();
  const app = await connect("app", r);
  const p1 = await connect("phone", r);
  const p2 = await connect("phone", r);
  await next(app, (m) => m.type === "peer-joined");
  await next(app, (m) => m.type === "peer-joined");
  p2.close();
  await nothing(app, (m) => m.type === "peer-left");
  p1.close();
  await next(app, (m) => m.type === "peer-left");
  app.close();
});

// ---------- tilt classifier ----------
test("tilt classifier: thresholds and hysteresis", () => {
  const c = createTiltClassifier({ enter: 20, exit: 10 });
  assert.equal(c.state, "center");
  assert.equal(c.update(-19), "center");
  assert.equal(c.update(-20), "yes");
  assert.equal(c.update(-11), "yes"); // inside dead band, stays
  assert.equal(c.update(-9), "center");
  assert.equal(c.update(19), "center");
  assert.equal(c.update(20), "no");
  assert.equal(c.update(11), "no");
  assert.equal(c.update(-25), "yes"); // direct swing
  assert.equal(c.update(25), "no");
  assert.equal(c.update(9), "center");
  c.update(30);
  c.reset();
  assert.equal(c.state, "center");
});

// ---------- 2D pointer math ----------
import {
  topEdgeVector, yawOf, rotateYaw, angleDiff, averageDirection,
  solveHomography, applyHomography, createCalibration, CORNER_TARGETS, createOneEuro,
} from "./public/pointer.js";

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: got ${a}, want ${b}`);
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

test("top edge vector: flat phone, turning and rolling", () => {
  const v = topEdgeVector(0, 0, 0);
  close(v[0], 0, 1e-9, "x"); close(v[1], 1, 1e-9, "y"); close(v[2], 0, 1e-9, "z");
  close(yawOf(topEdgeVector(30, 0, 0)), -30, 1e-9, "turned left = negative yaw");
  close(yawOf(topEdgeVector(-30, 0, 0)), 30, 1e-9, "turned right = positive yaw");
  // rolling the phone in your hand (gamma) doesn't move where the top edge points
  const rolled = topEdgeVector(20, 15, 50), plain = topEdgeVector(20, 15, 0);
  for (let i = 0; i < 3; i++) close(rolled[i], plain[i], 1e-9, "roll invariant");
  // tipping the top edge up (beta) raises z
  assert.ok(topEdgeVector(0, 20, 0)[2] > 0.3);
});

test("rotateYaw / angleDiff", () => {
  close(yawOf(rotateYaw([0, 1, 0], 25)), 25, 1e-9, "rotate right");
  close(yawOf(rotateYaw([0, 1, 0], -40)), -40, 1e-9, "rotate left");
  assert.equal(angleDiff(170, -170), -20);
  assert.equal(angleDiff(-170, 170), 20);
  assert.equal(angleDiff(10, 350), 20);
});

test("homography maps 4 points exactly and is projective in between", () => {
  const H0 = [1.2, 0.1, 3, -0.2, 0.9, -1, 0.01, 0.02, 1];
  const src = [[0, 0], [10, 1], [9, 8], [-1, 7]];
  const dst = src.map((p) => applyHomography(H0, p));
  const H = solveHomography(src, dst);
  for (const p of [[3, 4], [0, 0], [7.5, 2.2]]) {
    const a = applyHomography(H, p), b = applyHomography(H0, p);
    close(a[0], b[0], 1e-6, "u"); close(a[1], b[1], 1e-6, "v");
  }
  assert.equal(solveHomography([[0, 0], [1, 1], [2, 2], [3, 3]], src), null, "collinear points are rejected");
});

// Simulate a real setup: the user's phone at the origin, a flat screen somewhere
// in front of them. Pointing at a spot on the screen = the unit vector to it.
function makeScreen({ yaw = 0, distance = 1, width = 0.6, height = 0.36, lift = 0.1, tilt = 0 }) {
  // screen centre straight ahead (after yaw), raised by `lift`; screen tipped back by `tilt` deg
  const t = (tilt * Math.PI) / 180;
  const fwd = rotateYaw([0, 1, 0], yaw), right = rotateYaw([1, 0, 0], yaw);
  const up = [fwd[0] * Math.sin(t), fwd[1] * Math.sin(t), Math.cos(t)];
  const centre = [fwd[0] * distance, fwd[1] * distance, lift];
  return (fx, fy) => unit([0, 1, 2].map((i) => centre[i] + right[i] * (fx - 0.5) * width - up[i] * (fy - 0.5) * height));
}

test("calibration: after 4 corners, every spot on the screen maps to the right place", () => {
  for (const setup of [{}, { yaw: 70 }, { yaw: -150, tilt: 20 }, { distance: 2.5, lift: -0.4 }, { yaw: 10, width: 1.2, height: 0.7, tilt: -10 }]) {
    const at = makeScreen(setup);
    const c = createCalibration(CORNER_TARGETS.map(([x, y]) => at(x, y)));
    assert.ok(!c.error, c.error);
    for (const [x, y] of [[0.5, 0.5], [0.1, 0.9], [0.8, 0.3], [0, 0], [1, 1]]) {
      const [mx, my] = c.map(at(x, y));
      close(mx, x, 1e-6, `x ${JSON.stringify(setup)}`);
      close(my, y, 1e-6, `y ${JSON.stringify(setup)}`);
    }
  }
});

test("calibration: recenter cancels slow gyro drift", () => {
  const at = makeScreen({});
  const c = createCalibration(CORNER_TARGETS.map(([x, y]) => at(x, y)));
  const drift = 12; // degrees the phone's yaw reference wandered off
  const drifted = (x, y) => rotateYaw(at(x, y), drift);
  assert.ok(Math.abs(c.map(drifted(0.5, 0.5))[0] - 0.5) > 0.2, "drift moves the cursor a lot");
  c.recenter(drifted(0.5, 0.5)); // user aims at the middle and long-presses
  for (const [x, y] of [[0.5, 0.5], [0.2, 0.7], [0.9, 0.1]]) {
    const [mx, my] = c.map(drifted(x, y));
    close(mx, x, 0.03, "x after recenter"); close(my, y, 0.03, "y after recenter");
  }
});

test("calibration: rejects bad corner sets", () => {
  const at = makeScreen({});
  const good = CORNER_TARGETS.map(([x, y]) => at(x, y));
  assert.match(createCalibration([good[1], good[0], good[2], good[3]]).error, /order/, "TL/TR swapped");
  assert.match(createCalibration([good[0], good[2], good[1], good[3]]).error, /order|crossed/, "crossed");
  const tiny = makeScreen({ width: 0.02, height: 0.01 });
  assert.match(createCalibration(CORNER_TARGETS.map(([x, y]) => tiny(x, y))).error, /too close/);
  assert.ok(createCalibration(good.slice(0, 3)).error, "needs 4");
  // pointing behind the user is off the map rather than mirrored onto the screen
  const c = createCalibration(good);
  assert.equal(c.map([0, -1, 0]), null);
});

test("averageDirection and One Euro filter", () => {
  const a = averageDirection([[1, 0, 0], [0, 1, 0]]);
  close(a[0], Math.SQRT1_2, 1e-9, "avg x"); close(a[1], Math.SQRT1_2, 1e-9, "avg y");
  const f = createOneEuro();
  let out;
  for (let t = 0; t <= 2000; t += 16) out = f.filter(t < 100 ? 0 : 500, t);
  close(out, 500, 1, "settles on a held value");
  // jitter around a held point is damped
  const g = createOneEuro();
  let maxDev = 0;
  for (let t = 0, i = 0; t < 3000; t += 16, i++) {
    const v = g.filter(300 + (i % 2 ? 6 : -6), t);
    if (t > 1000) maxDev = Math.max(maxDev, Math.abs(v - 300));
  }
  assert.ok(maxDev < 3, `jitter of ±6 px reduced to ±${maxDev.toFixed(2)}`);
});

test("smoothing presets: stronger = steadier at rest, and all still follow a real move", async () => {
  const { SMOOTHING } = await import("./public/pointer.js");
  const wobble = (level) => {
    const f = createOneEuro(SMOOTHING[level]);
    let maxDev = 0;
    // ±8 px hand tremor at ~9 Hz around a held point, 60 samples/s
    for (let t = 0; t < 4000; t += 16) {
      const v = f.filter(300 + 8 * Math.sin((2 * Math.PI * 9 * t) / 1000), t);
      if (t > 1500) maxDev = Math.max(maxDev, Math.abs(v - 300));
    }
    return maxDev;
  };
  const [l, m, s] = ["light", "medium", "strong"].map(wobble);
  assert.ok(l > m && m > s, `light ${l.toFixed(2)} > medium ${m.toFixed(2)} > strong ${s.toFixed(2)}`);
  for (const level of ["light", "medium", "strong"]) {
    const f = createOneEuro(SMOOTHING[level]);
    let v;
    for (let t = 0; t <= 1500; t += 16) v = f.filter(t < 200 ? 0 : 600, t); // jump across the screen
    assert.ok(Math.abs(v - 600) < 15, `${level} reaches the new spot within ~1.3 s (at ${v.toFixed(1)})`);
  }
  console.log(`  tremor left after smoothing: light ±${l.toFixed(1)}px, medium ±${m.toFixed(1)}px, strong ±${s.toFixed(1)}px`);
});

test("relays touchpad drag and calibrate from the phone", async () => {
  const r = room();
  const app = await connect("app", r);
  const phone = await connect("phone", r);
  await next(app, (m) => m.type === "peer-joined");
  phone.send(JSON.stringify({ type: "drag", dx: 12.5, dy: -3, w: 360 }));
  assert.deepEqual(await next(app, (m) => m.type === "drag"), { type: "drag", dx: 12.5, dy: -3, w: 360 });
  phone.send(JSON.stringify({ type: "calibrate", sid: "abc" }));
  assert.deepEqual(await next(app, (m) => m.type === "calibrate"), { type: "calibrate", sid: "abc" });
  // the app can't make the phone do anything
  app.send(JSON.stringify({ type: "calibrate" }));
  await nothing(phone, (m) => m.type === "calibrate");
  phone.close(); app.close();
});
