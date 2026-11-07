// Static file server + WebSocket relay.
// Phone and app join the same room; messages are forwarded to the other side.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = process.env.PORT || 8080;
const MAX_CLIENTS_PER_ROOM = 6;
const VENDOR = {
  "/vendor/qrcode.mjs": path.join(__dirname, "node_modules", "qrcode-generator", "dist", "qrcode.mjs"),
};
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms expire after 6h of inactivity

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = url.pathname;
  if (p === "/") p = "/app.html";
  if (p === "/phone") p = "/phone.html";
  if (p === "/play") p = "/play.html";
  const vendorFile = VENDOR[p];
  const file = vendorFile || path.normalize(path.join(PUBLIC, p));
  if (!vendorFile && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

// rooms: Map<roomId, { clients: Set<ws>, lastActive: number }>
const rooms = new Map();
const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws, req) => {
  const q = new URL(req.url, "http://localhost").searchParams;
  const room = q.get("room");
  const role = q.get("role") === "phone" ? "phone" : "app";

  if (!room || !ROOM_RE.test(room)) {
    ws.close(1008, "bad room");
    return;
  }

  if (!rooms.has(room)) rooms.set(room, { clients: new Set(), lastActive: Date.now() });
  const r = rooms.get(room);
  if (r.clients.size >= MAX_CLIENTS_PER_ROOM) {
    ws.close(1013, "room full");
    return;
  }
  ws.role = role;
  r.clients.add(ws);
  r.lastActive = Date.now();

  const notifyPeers = (type) => {
    for (const peer of r.clients) {
      if (peer !== ws && peer.readyState === 1) peer.send(JSON.stringify({ type, role }));
    }
  };
  notifyPeers("peer-joined");

  // let a newly joined client know whether the other side is already here
  const otherRole = role === "phone" ? "app" : "phone";
  if ([...r.clients].some((c) => c.role === otherRole)) {
    ws.send(JSON.stringify({ type: "peer-joined", role: otherRole }));
  }

  ws.on("message", (data) => {
    r.lastActive = Date.now();
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Only the phone sends control messages; relay to the app side only.
    if (ws.role !== "phone") return;
    if (!["highlight", "click", "tilt", "point", "recenter", "drag", "calibrate", "scroll", "text", "key"].includes(msg.type)) return;
    const out = JSON.stringify(msg);
    for (const peer of r.clients) {
      if (peer !== ws && peer.role === "app" && peer.readyState === 1) peer.send(out);
    }
  });

  ws.on("close", () => {
    r.clients.delete(ws);
    // only report "left" when no other client of this role remains (e.g. a phone that reconnected)
    if (![...r.clients].some((c) => c.role === role)) notifyPeers("peer-left");
    if (r.clients.size === 0) r.lastActive = Date.now();
  });
});

// Clean up idle empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.clients.size === 0 && now - r.lastActive > ROOM_TTL_MS) rooms.delete(id);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Mobile remote running on http://localhost:${PORT}`);
  console.log(`Open that URL on your laptop, then scan the QR code with your phone.`);
  console.log(`Phones need HTTPS for motion sensors - see README (ngrok / cloudflared).`);
});

export { server, wss };
