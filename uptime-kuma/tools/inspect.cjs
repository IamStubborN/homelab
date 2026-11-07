const fs = require("node:fs");
const { io } = require("/app/node_modules/socket.io-client");
const config = JSON.parse(fs.readFileSync(0, "utf8"));
const socket = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 10000 });
let monitors = null;
const beats = {};
socket.on("monitorList", (value) => { monitors = value; });
socket.on("heartbeatList", (id, data) => { beats[id] = data.at(-1) || null; });
socket.on("heartbeat", (data) => { beats[data.monitorID] = data; });
const timer = setTimeout(() => finish(), 45000);
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error || !monitors) {
    console.error("Authenticated monitoring readback unavailable");
    process.exitCode = 1;
  } else {
    const result = Object.values(monitors).map((m) => ({ id: m.id, name: m.name, type: m.type,
      active: m.active, key: m.description, parent: m.parent, status: beats[m.id]?.status ?? null,
      message: beats[m.id]?.msg ?? null, ping: beats[m.id]?.ping ?? null }));
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  socket.disconnect();
}
socket.once("info", () => socket.emit("login", { username: config.username, password: config.password }, (response) => {
  if (!response.ok) finish(true);
}));
socket.on("connect_error", () => finish(true));
