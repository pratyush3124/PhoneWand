// Builds the static site for hosts without WebSockets (Vercel): landing page,
// demo pages, QR library and the desktop downloads, into site/.
//   npm run build:web && vercel deploy --prod
//   npm run build:web -- --base /PhoneWand/     (GitHub Pages project site, served under a subpath)
// The relay isn't included; the landing page notices (no /healthz) and says so.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({ options: { base: { type: "string", default: "/" } } });
const base = ("/" + opts.base + "/").replace(/\/+/g, "/");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
fs.rmSync(site, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), site, { recursive: true });
fs.mkdirSync(path.join(site, "vendor"));
fs.copyFileSync(path.join(root, "node_modules/qrcode-generator/dist/qrcode.mjs"), path.join(site, "vendor/qrcode.mjs"));

const dl = path.join(site, "downloads");
fs.mkdirSync(dl);
const files = fs.readdirSync(path.join(root, "downloads"))
  .filter((f) => /^phonewand-.*\.(zip|tar\.gz)$/.test(f))
  .map((f) => {
    fs.copyFileSync(path.join(root, "downloads", f), path.join(dl, f));
    return { name: f, size: fs.statSync(path.join(dl, f)).size };
  });
fs.writeFileSync(path.join(dl, "index.json"), JSON.stringify({ files }));
// Hosts without rewrites (GitHub Pages) serve /yesno from yesno.html.
fs.copyFileSync(path.join(site, "app.html"), path.join(site, "yesno.html"));

// Root-relative links and imports ("/play", "/pairing.js") point under the base path.
if (base !== "/") {
  for (const f of fs.readdirSync(site).filter((f) => /\.(html|js)$/.test(f))) {
    const file = path.join(site, f);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/((?:href|src)\s*=\s*|from\s+|import\(|fetch\()(["'`])\/(?!\/)/g, `$1$2${base}`));
  }
}
console.log(`site/ (base ${base})  ready with ${files.length} download(s): ${files.map((f) => f.name).join(", ") || "none"}`);
