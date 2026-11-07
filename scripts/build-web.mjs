// Builds the static site for hosts without WebSockets (Vercel): landing page,
// demo pages, QR library and the desktop downloads, into site/.
//   npm run build:web && vercel deploy --prod
// The relay isn't included; the landing page notices (no /healthz) and says so.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
console.log(`site/ ready with ${files.length} download(s): ${files.map((f) => f.name).join(", ") || "none"}`);
