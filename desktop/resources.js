// Where the app's files live: the repo root when run with node, or the
// resources/ folder next to the executable in the packaged desktop app.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const builtin = createRequire(process.execPath);
let sea = false;
try { sea = builtin("node:sea").isSea(); } catch {}

export const IS_PACKAGED = sea;
export const ROOT = sea
  ? path.join(path.dirname(process.execPath), "resources")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
