// Drop-in client for the web app (laptop) side.
//
//   import { connectRemote, makeRoomCode } from "/remote-client.js";
//   const room = makeRoomCode();
//   const remote = connectRemote({
//     room,
//     onHighlight: (value) => { /* "yes" | "no" | "center" */ },
//     onClick: ({ v }) => { /* phone button pressed; v = where it pointed at touch-down */ },
//     onTilt: (deg) => { /* optional: left/right angle from center, negative = left */ },
//     onPoint: ({ v, sid }) => { /* 2D: top-edge direction [x,y,z], ~60/s; see pointer.js */ },
//     onRecenter: ({ v, sid }) => { /* phone long-pressed: treat v as "pointing at the middle" */ },
//     onDrag: ({ dx, dy, w }) => { /* finger moved on the touchpad by dx,dy px (pad is w px wide) */ },
//     onScroll: ({ dx, dy, w }) => { /* scroll gesture: fingers moved dx,dy px (dy > 0 = fingers moved down) */ },
//     onText: (text) => { /* text typed on the phone keyboard */ },
//     onKey: ({ key, mods }) => { /* special key, e.g. "enter", "backspace", "left"; or a character with mods ["ctrl"] */ },
//     onCalibrate: () => { /* Calibrate button pressed on the phone */ },
//     onPower: (on) => { /* phone's main switch: false = ignore the phone until it's back on */ },
//     onStatus: ({ server, phone }) => { /* connection state */ },
//   });
//   remote.close(); // when done

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

export function makeRoomCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function connectRemote({
  room,
  server = location.origin,
  onHighlight,
  onClick,
  onTilt,
  onPoint,
  onRecenter,
  onDrag,
  onScroll,
  onText,
  onKey,
  onPower,
  onCalibrate,
  onStatus,
}) {
  const wsUrl =
    server.replace(/^http/, "ws").replace(/\/$/, "") +
    `/ws?role=app&room=${encodeURIComponent(room)}`;
  let ws;
  let closed = false;
  let retry = 0;
  let timer;
  const status = { server: "connecting", phone: false };
  const emit = () => onStatus?.({ ...status });

  function open() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      retry = 0;
      status.server = "connected";
      emit();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "highlight":
          onHighlight?.(msg.value);
          break;
        case "click":
          onClick?.(msg);
          break;
        case "point":
          if (Array.isArray(msg.v) && msg.v.length === 3) onPoint?.(msg);
          break;
        case "recenter":
          onRecenter?.(msg);
          break;
        case "drag":
          if (Number.isFinite(msg.dx) && Number.isFinite(msg.dy)) onDrag?.(msg);
          break;
        case "scroll":
          if (Number.isFinite(msg.dx) && Number.isFinite(msg.dy)) onScroll?.(msg);
          break;
        case "text":
          if (typeof msg.text === "string" && msg.text) onText?.(msg.text);
          break;
        case "key":
          if (typeof msg.key === "string" && msg.key) onKey?.({ key: msg.key, mods: Array.isArray(msg.mods) ? msg.mods : [], repeat: msg.repeat });
          break;
        case "power":
          if (typeof msg.on === "boolean") onPower?.(msg.on);
          break;
        case "calibrate":
          onCalibrate?.(msg);
          break;
        case "tilt":
          onTilt?.(msg.value);
          break;
        case "peer-joined":
          if (msg.role === "phone") {
            status.phone = true;
            emit();
          }
          break;
        case "peer-left":
          if (msg.role === "phone") {
            status.phone = false;
            emit();
          }
          break;
      }
    };
    ws.onclose = () => {
      status.server = "disconnected";
      status.phone = false;
      emit();
      if (!closed) {
        timer = setTimeout(open, Math.min(500 * 2 ** retry++, 8000));
      }
    };
    ws.onerror = () => ws.close();
  }

  open();
  emit();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
