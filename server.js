// Web app: landing page, demo pages and the WebSocket relay.  npm start
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "./relay.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const { server, wss } = createRelay({ root, downloads: process.env.DOWNLOADS_DIR || undefined });

server.listen(PORT, () => {
  console.log(`Mobile remote running on http://localhost:${PORT}`);
  console.log(`Open that URL on your laptop, then scan the QR code with your phone.`);
  console.log(`Phones need HTTPS for motion sensors - see README (ngrok / cloudflared).`);
});

export { server, wss };
