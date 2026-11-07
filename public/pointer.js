// 2D pointing: turn the phone's pointing direction into a spot on the screen.
//
// The phone sends the world-space direction of its top edge as a unit vector
// [x, y, z] (x = east, y = north, z = up; see topEdgeVector). The user
// calibrates by pointing at 4 targets near the screen corners. We then:
//   1. project every direction onto a flat plane in front of the user
//      (central projection: a straight line on the screen stays straight), and
//   2. fit a homography from those 4 projected points to the 4 target spots.
// Because a flat screen viewed from one place is exactly a projective
// transform of that plane, 4 corners pin it down; no tuning constants needed.
//
// Phone gyros drift slowly around the vertical axis (yaw), never in pitch,
// so `recenter` only corrects yaw.

const RAD = Math.PI / 180;

// ---------- vectors ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

// Direction of the phone's top edge in world coordinates, from DeviceOrientation
// angles (W3C: R = Rz(alpha) Rx(beta) Ry(gamma)). Rolling the phone in your hand
// doesn't change it.
export function topEdgeVector(alpha, beta, gamma) {
  const sA = Math.sin(alpha * RAD), cA = Math.cos(alpha * RAD);
  const sB = Math.sin(beta * RAD), cB = Math.cos(beta * RAD);
  return [-cB * sA, cA * cB, sB];
}

export function yawOf(v) {
  return Math.atan2(v[0], v[1]) / RAD;
}

// Signed smallest difference a - b in degrees, in (-180, 180].
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Rotate a direction around the vertical axis. Positive = turn to the right.
export function rotateYaw(v, deg) {
  const r = deg * RAD, c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

// Average of several directions (e.g. samples taken just before a tap).
export function averageDirection(list) {
  const sum = [0, 0, 0];
  for (const v of list) { sum[0] += v[0]; sum[1] += v[1]; sum[2] += v[2]; }
  return norm(sum);
}

// ---------- homography ----------
// Find H (3x3, h22 = 1) with H * [x, y, 1] ~ [u, v, 1] for 4 point pairs.
export function solveHomography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null; // degenerate (3 points in a line, duplicates...)
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function applyHomography(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// ---------- calibration ----------
// Default target spots (fractions of the viewport), in order TL, TR, BR, BL.
export const CORNER_TARGETS = [
  [0.06, 0.08],
  [0.94, 0.08],
  [0.94, 0.92],
  [0.06, 0.92],
];

// dirs: 4 unit vectors recorded while pointing at targets (same order).
// Returns { map(dir) -> [fx, fy] | null, center, yawOffset } or { error }.
export function createCalibration(dirs, targets = CORNER_TARGETS) {
  if (dirs.length !== 4 || dirs.some((d) => !d)) return { error: "Need 4 corner readings." };
  const forward = averageDirection(dirs);
  if (!forward) return { error: "Corner readings cancel out. Try again." };
  const e1 = norm(cross(forward, [0, 0, 1])); // screen-right in the world
  if (!e1) return { error: "Point at the screen, not at the ceiling or floor." };
  const e2 = cross(e1, forward); // screen-up in the world

  const project = (d) => {
    const f = dot(d, forward);
    if (f < 0.1) return null; // more than ~84 deg away from the screen
    return [dot(d, e1) / f, dot(d, e2) / f];
  };

  const pts = dirs.map(project);
  if (pts.some((p) => !p)) return { error: "One corner was far off. Try again." };

  // Corners must form a convex quad going TL -> TR -> BR -> BL. In projected
  // coordinates "up" is +y, so that order runs clockwise (negative cross products).
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z >= 0) return { error: "The corners came out in the wrong order or crossed over. Point at each dot in turn and try again." };
  }
  // Each side should span at least ~3 degrees, or the cursor would be wildly sensitive.
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < Math.tan(3 * RAD)) {
      return { error: "The corners were too close together. Move the phone more between dots." };
    }
  }

  const H = solveHomography(pts, targets);
  if (!H || H.some((x) => !Number.isFinite(x))) return { error: "Couldn't fit those corners. Try again." };

  let yawOffset = 0; // added to incoming directions; changed by recenter()
  return {
    get yawOffset() { return yawOffset; },
    map(dir) {
      const p = project(yawOffset ? rotateYaw(dir, yawOffset) : dir);
      return p ? applyHomography(H, p) : null;
    },
    // Treat `dir` as pointing at the middle of the calibrated area (fixes gyro drift).
    recenter(dir) {
      yawOffset = yawOf(forward) - yawOf(dir);
    },
  };
}

// ---------- smoothing ----------
// One Euro filter (Casiez et al. 2012): heavy smoothing when the cursor is
// nearly still (kills hand jitter), light smoothing when it moves fast (no lag).
//   minCutoff (Hz): lower = steadier when still, but more lag on slow moves
//   beta: how fast smoothing backs off as speed (px/s) rises; lower = steadier, laggier
export const SMOOTHING = {
  light: { minCutoff: 1.0, beta: 0.01 },
  medium: { minCutoff: 0.5, beta: 0.004 },
  strong: { minCutoff: 0.25, beta: 0.002 },
};

export function createOneEuro({ minCutoff = SMOOTHING.medium.minCutoff, beta = SMOOTHING.medium.beta, dCutoff = 1 } = {}) {
  let x = null, dx = 0, last = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    filter(value, tMs) {
      if (x === null) { x = value; last = tMs; return x; }
      const dt = Math.max((tMs - last) / 1000, 1e-3);
      last = tMs;
      const rawDx = (value - x) / dt;
      dx += alpha(dCutoff, dt) * (rawDx - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += alpha(cutoff, dt) * (value - x);
      return x;
    },
    reset() { x = null; dx = 0; },
    setParams(p) { if (p.minCutoff) minCutoff = p.minCutoff; if (p.beta) beta = p.beta; },
  };
}
