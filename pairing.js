// Room code + QR pairing panel, shared by the demo pages.
//
//   setupPairing({ qr, code, link, originBox, originInput, originErr, newRoomBtn, onRoom })
// Every argument except onRoom is a DOM element (originBox/originInput/originErr
// are only needed when the page may be opened on localhost). onRoom(room) is called
// with the starting room code and again whenever "New code" is pressed.
import { makeRoomCode } from "/PhoneWand/remote-client.js";
import qrcode from "/PhoneWand/vendor/qrcode.mjs";

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const get = (kind, key) => { try { return window[kind].getItem(key); } catch { return null; } };
const set = (kind, key, val) => { try { window[kind].setItem(key, val); } catch {} };

export function setupPairing({ qr, code, link, originBox, originInput, originErr, newRoomBtn, onRoom }) {
  let room = get("sessionStorage", "remoteRoom");
  if (!room || !ROOM_RE.test(room)) {
    room = makeRoomCode();
    set("sessionStorage", "remoteRoom", room);
  }

  const isLocal = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
  if (isLocal && originBox) {
    originBox.hidden = false;
    originInput.value = get("localStorage", "remotePublicOrigin") || "";
    originInput.addEventListener("input", () => {
      set("localStorage", "remotePublicOrigin", originInput.value.trim());
      render();
    });
  }

  function publicOrigin() {
    if (!isLocal) return { origin: location.origin };
    const raw = originInput?.value.trim();
    if (!raw) return { error: "Phones can’t reach localhost. Start a tunnel and paste its https URL here." };
    let u;
    try { u = new URL(raw); } catch { return { error: "That doesn’t look like a URL." }; }
    if (u.protocol !== "https:") return { error: "Use the https URL. Phones only give motion data on HTTPS." };
    if (["localhost", "127.0.0.1"].includes(u.hostname)) return { error: "This must be a public URL, not localhost." };
    return { origin: u.origin };
  }

  function render() {
    code.textContent = room;
    const { origin, error } = publicOrigin();
    if (originErr) originErr.textContent = error || "";
    if (!origin) {
      qr.innerHTML = '<div class="placeholder">Enter your public https URL below to get a QR code.</div>';
      link.textContent = "";
      link.removeAttribute("href");
      return;
    }
    const url = `${origin}/phone?room=${encodeURIComponent(room)}`;
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: "QR code for the phone remote link" });
    link.textContent = url;
    link.href = url;
  }

  newRoomBtn?.addEventListener("click", () => {
    room = makeRoomCode();
    set("sessionStorage", "remoteRoom", room);
    render();
    onRoom(room);
  });

  render();
  onRoom(room);
  return { get room() { return room; } };
}
