/* Pinned Kuma internal Socket.IO API. Private configuration arrives on stdin. */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { io } = require("/app/node_modules/socket.io-client");
const config = JSON.parse(fs.readFileSync(0, "utf8"));
const socket = io("http://127.0.0.1:3001", { transports: ["websocket"], reconnection: false, timeout: 15000 });
let monitors = null;
let tags = [];
let notifications = null;
socket.on("monitorList", (value) => { monitors = value; });
socket.on("tagList", (value) => { tags = value; });
socket.on("notificationList", (value) => { notifications = value; });
function event(name, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(60000).emit(name, ...args, (error, result) => {
      if (error) return reject(new Error(`${name}: acknowledgement timeout`));
      if (result && typeof result === "object" && result.ok !== true) {
        // Server error messages may contain endpoints or credentials; keep them private.
        return reject(new Error(`${name}: server rejected request`));
      }
      resolve(result);
    });
  });
}
async function waitForList() {
  const deadline = Date.now() + 15000;
  while ((monitors === null || notifications === null) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (monitors === null || notifications === null) throw new Error("Monitor list not received");
}
const defaults = {
  parent: null, interval: 60, retryInterval: 60, maxretries: 2, resendInterval: 0,
  active: false, ignoreTls: false, upsideDown: false, expiryNotification: false,
  domainExpiryNotification: false, notificationIDList: {}, accepted_statuscodes: ["200-299"],
  method: "GET", maxredirects: 5, timeout: 20, kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" }, rabbitmqNodes: [], conditions: [],
};
async function main() {
  // The server awaits sendInfo before installing its event handlers. A transport
  // connect event alone is too early and can lose the first request.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server handshake unavailable")), 15000);
    socket.once("info", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", () => { clearTimeout(timer); reject(new Error("Loopback socket unavailable")); });
  });
  if (await event("needSetup")) await event("setup", config.username, config.password);
  await event("login", { username: config.username, password: config.password });
  await waitForList();
  tags = (await event("getTags")).tags;
  const existing = Object.values(monitors);
  const byKey = new Map(existing.filter((m) => m.description?.startsWith("homelab-managed:")).map((m) => [m.description.slice(16), m]));
  let notificationId = null;
  if (config.notification) {
    const found = notifications.find((n) => n.name === config.notification.name);
    const response = await event("addNotification", { ...config.notification, isDefault: false, applyExisting: false }, found?.id || null);
    notificationId = response.id;
  }
  const ids = {};
  const output = [];
  if (config.phase === "activate") {
    for (const spec of config.monitors) {
      const current = byKey.get(spec.key);
      if (!current) throw new Error(`Missing owned monitor: ${spec.key}`);
      await event(spec.paused ? "pauseMonitor" : "resumeMonitor", current.id);
      ids[spec.key] = current.id;
    }
  } else {
    for (const tag of config.tags || []) {
      if (!tags.some((x) => x.name === tag.name)) {
        const result = await event("addTag", tag);
        tags.push(result.tag);
      }
    }
    for (const spec of config.monitors) {
      const current = byKey.get(spec.key);
      if (!current && existing.some((x) => x.name === spec.name)) throw new Error(`Unowned name collision: ${spec.key}`);
      const { key, parentKey, tags: tagNames, alert, paused, ...fields } = spec;
      const monitor = {
        ...defaults, ...fields, description: `homelab-managed:${key}`,
        parent: parentKey ? (ids[parentKey] || byKey.get(parentKey)?.id) : null,
        notificationIDList: alert && notificationId ? { [notificationId]: true } : {},
      };
      if (parentKey && !monitor.parent) throw new Error(`Parent must precede child: ${key}`);
      if (monitor.type === "push") monitor.pushToken = current?.pushToken || crypto.randomBytes(15).toString("base64url");
      let id;
      if (current) {
        monitor.id = current.id;
        await event("editMonitor", monitor);
        id = current.id;
      } else {
        id = (await event("add", monitor)).monitorID;
      }
      ids[key] = id;
      for (const name of tagNames || []) {
        const tag = tags.find((t) => t.name === name);
        if (!tag) throw new Error(`Undefined tag: ${name}`);
        if (!current?.tags?.some((t) => t.tag_id === tag.id)) await event("addMonitorTag", tag.id, id, "");
      }
      output.push({ key, id, type: monitor.type, pushToken: monitor.pushToken });
    }
    if (config.statusPage) {
      const page = config.statusPage;
      let fetched;
      let created = false;
      try { fetched = await event("getStatusPage", page.slug); }
      catch {
        await event("addStatusPage", page.title, page.slug);
        created = true;
        fetched = await event("getStatusPage", page.slug);
      }
      if (!created && !fetched.config.description?.includes("homelab-managed:status")) throw new Error("Unowned status page");
      const settings = { ...fetched.config, ...page.config, slug: page.slug, title: page.title, analyticsType: null };
      const groups = page.groups.map((g) => ({ name: g.name, monitorList: g.keys.map((key) => {
        if (!ids[key]) throw new Error(`Unknown status-page key: ${key}`);
        return { id: ids[key], sendUrl: false };
      }) }));
      await event("saveStatusPage", page.slug, settings, settings.icon || "", groups);
    }
    if (config.statusPage) {
      const settings = (await event("getSettings")).data;
      await event("setSettings", { ...settings, disableAuth: false, trustProxy: false,
        serverTimezone: config.timezone || "UTC", primaryBaseURL: config.baseUrl,
        keepDataPeriodDays: 90, entryPage: "statusPage-" + config.statusPage.slug }, config.password);
    }
  }
  let tested = false;
  if (config.sendTest === true && config.notification) {
    await event("testNotification", config.notification);
    tested = true;
  }
  // Contains Push secrets: caller must capture this stream into an ignored 0600 file.
  process.stdout.write(JSON.stringify({ ids, monitors: output, notificationId, tested }) + "\n");
}
main().then(() => { socket.disconnect(); }).catch((error) => {
  console.error(error.message);
  socket.disconnect();
  process.exitCode = 1;
});
