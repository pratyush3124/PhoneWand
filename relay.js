// Static file server + WebSocket relay, shared by `npm start` (server.js) and the
// packaged desktop app. Phone and app join the same room; the phone's messages
// are forwarded to the app side.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const MAX_CLIENTS_PER_ROOM = 6;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms expire after 6h of inactivity
const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const DOWNLOAD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|tar\.gz)$/;
const RELAYED = ["highlight", "click", "tilt", "point", "recenter", "drag", "calibrate", "scroll", "text", "key", "power"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const ROUTES = { "/": "/index.html", "/phone": "/phone.html", "/play": "/play.html", "/yesno": "/app.html" };

// root: folder holding public/, node_modules/qrcode-generator and (optionally) downloads/
export function createRelay({ root, downloads = path.join(root, "downloads") }) {
  const PUBLIC = path.join(root, "public");
  const VENDOR = {
    "/vendor/qrcode.mjs": path.join(root, "node_modules", "qrcode-generator", "dist", "qrcode.mjs"),
  };

  function sendFile(res, file, headers = {}) {
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(data);
    });
  }

  // GET /downloads/ -> JSON list of packaged desktop builds; /downloads/<file> -> the file
  function serveDownloads(res, name) {
    if (!name) {
      let files = [];
      try {
        files = fs.readdirSync(downloads)
          .filter((f) => DOWNLOAD_RE.test(f))
          .map((f) => ({ name: f, size: fs.statSync(path.join(downloads, f)).size }));
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ files }));
    }
    if (!DOWNLOAD_RE.test(name)) return res.writeHead(404).end("Not found");
    sendFile(res, path.join(downloads, name), { "Content-Disposition": `attachment; filename="${name}"` });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let p = url.pathname;
    if (p === "/downloads" || p.startsWith("/downloads/")) return serveDownloads(res, p.slice("/downloads/".length));
    if (p === "/healthz") return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    p = ROUTES[p] || p;
    const vendorFile = VENDOR[p];
    const file = vendorFile || path.normalize(path.join(PUBLIC, p));
    if (!vendorFile && !file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end("Forbidden");
    sendFile(res, file);
  });

  // rooms: Map<roomId, { clients: Set<ws>, lastActive: number }>
  const rooms = new Map();
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE); whoever calls listen() handles those.
  wss.on("error", () => {});

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
      if (!RELAYED.includes(msg.type)) return;
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

  return { server, wss };
}
