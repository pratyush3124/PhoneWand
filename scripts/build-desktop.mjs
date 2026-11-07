// Packages the desktop app for the OS this runs on, as a single executable
// (Node's single-executable-application support) plus a resources/ folder:
//
//   npm run build:desktop
//
// Output: dist/phonewand-<os>-<arch>/ and an archive of it in downloads/,
// which the web app serves on its landing page. Build each OS on that OS
// (the GitHub Actions workflow in .github/workflows/release.yml does all three).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const OS = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
if (!OS) throw new Error(`Can't package for ${process.platform}`);
const name = `phonewand-${OS}-${process.arch}`;
const dist = path.join(root, "dist");
const work = path.join(dist, "build");
const out = path.join(dist, name);
const exeName = process.platform === "win32" ? "PhoneWand.exe" : "phonewand";
const exe = path.join(out, exeName);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n> ${s}`);

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

step("Bundling desktop/remote-mouse.js");
const bundle = path.join(work, "app.cjs");
await build({
  entryPoints: [path.join(root, "desktop", "remote-mouse.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["bufferutil", "utf-8-validate"], // optional ws speedups; ws falls back without them
  banner: { js: 'var __import_meta_url = typeof __filename === "string" ? require("url").pathToFileURL(__filename).href : "file:///";' },
  define: { "import.meta.url": "__import_meta_url" },
  logLevel: "warning",
});
// a #! line isn't valid at the top of an embedded script
fs.writeFileSync(bundle, fs.readFileSync(bundle, "utf8").replace(/^#!.*\n/, ""));

step("Building the executable");
const blob = path.join(work, "app.blob");
const seaConfig = path.join(work, "sea-config.json");
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
run(process.execPath, ["--experimental-sea-config", seaConfig]);
fs.copyFileSync(process.execPath, exe);
if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
run(process.execPath, [
  path.join(root, "node_modules", "postject", "dist", "cli.js"),
  exe, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);
if (process.platform !== "win32") fs.chmodSync(exe, 0o755);

step("Copying resources");
const res = path.join(out, "resources");
const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(res, rel), { recursive: true });
copy("public");
copy("node_modules/qrcode-generator/dist/qrcode.mjs");
copy("node_modules/qrcode-generator/package.json");
copy(`node_modules/@nut-tree-fork/libnut-${process.platform}`);
copy("node_modules/bindings");
copy("node_modules/file-uri-to-path");
if (process.platform === "win32") copy("desktop/win-unicode.ps1");

const start = process.platform === "win32" ? `Double-click "${exeName}".` : `Run ./${exeName} in a terminal (or double-click it).`;
const permissions = {
  win32: "Windows may warn that the app is from an unknown publisher (it isn't code-signed): choose More info > Run anyway.\nIt can't click inside apps running as administrator unless it runs as administrator too.",
  darwin: "First run: right-click the app > Open (it isn't notarized). Then allow your terminal under\nSystem Settings > Privacy & Security > Accessibility, so it can move the mouse.",
  linux: "Needs an X11 session (Wayland blocks synthetic mouse input).",
}[process.platform];
fs.writeFileSync(path.join(out, "README.txt"), `PhoneWand ${pkg.version}: your phone is the mouse
=====================================================

1. ${start}
2. Scan the QR code it shows with your phone and tap Start motion.
3. Aim the phone's top edge at the mouse cursor in each corner and tap (4 times).

Then point to move, tap to click, two fingers to scroll, Keyboard to type.

Phones only share motion sensors over HTTPS, so the app opens a free Cloudflare
tunnel. Install cloudflared once for that:
  Windows: winget install --id Cloudflare.cloudflared
  macOS:   brew install cloudflared
  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
(or put the cloudflared binary next to this file).

Keys: c = calibrate, p = pause/resume, Esc = cancel calibration, q = quit
Options: --server URL (use a hosted relay), --public URL, --port N, --no-tunnel,
         --room CODE, --smooth light|medium|strong

${permissions}
`.replace(/\n/g, process.platform === "win32" ? "\r\n" : "\n"));

step("Archiving");
const downloads = path.join(root, "downloads");
fs.mkdirSync(downloads, { recursive: true });
let archive;
if (process.platform === "linux") {
  archive = path.join(downloads, `${name}.tar.gz`);
  fs.rmSync(archive, { force: true });
  run("tar", ["-czf", archive, name], { cwd: dist });
} else {
  archive = path.join(downloads, `${name}.zip`);
  fs.rmSync(archive, { force: true });
  // Windows' own bsdtar (not Git Bash's GNU tar) and macOS tar both write zips with -a
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-a", "-c", "-f", archive, name], { cwd: dist });
}
fs.rmSync(work, { recursive: true, force: true });
const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1) + " MB";
console.log(`\nDone: ${path.relative(root, out)}  (${mb(exe)})\n      ${path.relative(root, archive)}  (${mb(archive)})`);
