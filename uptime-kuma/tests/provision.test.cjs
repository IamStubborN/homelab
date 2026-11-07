const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("provision waits for server info before requesting setup state", async () => {
  const callbacks = new Map();
  let ready = false;
  let output = "";
  let disconnected = false;
  const socket = {
    on(name, fn) { callbacks.set(name, fn); return this; },
    once(name, fn) { callbacks.set(name, fn); return this; },
    timeout() { return this; },
    emit(name, ...args) {
      assert.ok(ready, "request before server installed handlers");
      const callback = args.at(-1);
      if (name === "needSetup") callback(null, false);
      else if (name === "login") {
        callbacks.get("monitorList")({});
        callbacks.get("notificationList")([]);
        callback(null, { ok: true });
      } else if (name === "getTags") callback(null, { ok: true, tags: [] });
      else assert.fail("Unexpected mutation: " + name);
    },
    disconnect() { disconnected = true; },
  };
  const config = { username: "test", password: "private", phase: "activate", monitors: [] };
  const completion = vm.runInNewContext(fs.readFileSync(require.resolve("../tools/provision.cjs"), "utf8"), {
    require(name) {
      if (name === "node:fs") return { readFileSync: () => JSON.stringify(config) };
      if (name === "node:crypto") return {};
      return { io: () => socket };
    },
    setTimeout, clearTimeout, Date, Map, Promise,
    process: { stdout: { write: (value) => { output += value; } } },
    console,
  });
  callbacks.get("connect")?.();
  assert.equal(output, "");
  ready = true;
  callbacks.get("info")({});
  await completion;
  assert.deepEqual(JSON.parse(output).ids, {});
  assert.equal(disconnected, true);
});
