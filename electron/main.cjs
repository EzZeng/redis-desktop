const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { RedisClient } = require("./redis-client.cjs");
const { EmbeddedRedisServer } = require("./embedded-server.cjs");
const { NativeRedisServer, resolveRedisBinDir } = require("./native-redis.cjs");
const { ensureUserRedisConf } = require("./redis-conf.cjs");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {RedisClient | null} */
let redis = null;

/** @type {NativeRedisServer} */
const native = new NativeRedisServer();
/** @type {EmbeddedRedisServer} */
const embedded = new EmbeddedRedisServer();

/** Which backend is active: 'native' | 'embedded' | null */
let backend = null;

function confPaths() {
  const userData = app.getPath("userData");
  const bundledJs = path.join(__dirname, "redis.conf");
  const binDir = resolveRedisBinDir();
  const bundledNative = binDir ? path.join(binDir, "redis.conf") : null;
  return {
    userData,
    bundled: bundledNative && fs.existsSync(bundledNative) ? bundledNative : bundledJs,
    confPath: path.join(userData, "redis.conf"),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0f14",
    title: "Redis Desktop",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const indexHtml = path.join(__dirname, "..", "electron-dist", "index.html");
  mainWindow.loadFile(indexHtml).catch((err) => {
    console.error("Failed to load app:", err);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function ensureRedis() {
  if (!redis || !redis.connected) throw new Error("Not connected to Redis");
  return redis;
}

function activeStatus() {
  if (backend === "native") return { ...native.status(), backend: "native" };
  if (backend === "embedded") return { ...embedded.status(), backend: "embedded" };
  return {
    running: false,
    host: "127.0.0.1",
    port: 6379,
    mode: "stopped",
    backend: null,
    version: "",
    confPath: confPaths().confPath,
  };
}

async function startServer() {
  const { userData, bundled } = confPaths();
  // Prefer real redis-server.exe (redis-windows) on Windows
  if (native.available()) {
    try {
      const st = await native.start({ userDataDir: userData, bundledAppConf: bundled });
      backend = "native";
      console.log(`[redis-server] native ${st.version} on ${st.host}:${st.port}`);
      return { ok: true, ...st, backend: "native" };
    } catch (err) {
      console.error("[redis-server] native failed, falling back to embedded:", err.message);
    }
  }
  // JS fallback (Linux dev / if native missing)
  try {
    if (embedded.running) return { ok: true, ...embedded.status(), backend: "embedded" };
    const confPath = ensureUserRedisConf(userData, bundled);
    const st = await embedded.start({ confPath });
    backend = "embedded";
    console.log(`[redis-server] embedded on ${st.host}:${st.port}`);
    return { ok: true, ...st, backend: "embedded" };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function stopServer() {
  if (backend === "native") await native.stop();
  if (backend === "embedded") embedded.stop();
  backend = null;
}

async function restartServer() {
  await stopServer();
  await new Promise((r) => setTimeout(r, 500));
  return startServer();
}

function getConfText() {
  if (backend === "native") return native.getConfText();
  if (backend === "embedded") return embedded.getConfText();
  const p = confPaths().confPath;
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return "";
}

function setConfText(text) {
  if (backend === "native") {
    native.setConfText(text);
    return;
  }
  if (backend === "embedded") {
    if (!embedded.confPath) {
      const confPath = ensureUserRedisConf(confPaths().userData, confPaths().bundled);
      embedded.confPath = confPath;
    }
    embedded.setConfText(text);
    return;
  }
  const p = confPaths().confPath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

function registerIpc() {
  ipcMain.handle("redis:server:status", async () => activeStatus());

  ipcMain.handle("redis:server:start", async () => {
    try {
      return await startServer();
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("redis:server:stop", async () => {
    await stopServer();
    return { ok: true, ...activeStatus() };
  });

  ipcMain.handle("redis:server:reseed", async () => {
    if (backend === "embedded") {
      embedded.reseed();
      return { ok: true };
    }
    // Native: flush + optional sample via client commands later
    return { ok: false, error: "Reseed only supported for embedded engine; use FLUSHDB + seed scripts on redis-server.exe" };
  });

  ipcMain.handle("redis:server:conf:get", async () => {
    return {
      ok: true,
      path: activeStatus().confPath || confPaths().confPath,
      text: getConfText(),
      status: activeStatus(),
    };
  });

  ipcMain.handle("redis:server:conf:set", async (_e, payload = {}) => {
    try {
      const text = String(payload.text || "");
      setConfText(text);
      const clientWas = redis && redis.connected;
      if (redis) {
        try {
          redis.disconnect();
        } catch {
          /* ignore */
        }
        redis = null;
      }
      const st = await restartServer();
      return {
        ok: !!st.ok,
        error: st.error,
        path: confPaths().confPath,
        status: activeStatus(),
        restarted: true,
        reconnect: clientWas,
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("redis:server:conf:path", async () => ({
    path: confPaths().confPath,
  }));

  ipcMain.handle("redis:server:conf:open-dir", async () => {
    const dir = confPaths().userData;
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  ipcMain.handle("redis:connect", async (_e, opts) => {
    try {
      if (redis) {
        redis.disconnect();
        redis = null;
      }
      if (!backend) {
        const st = await startServer();
        if (!st.ok) return { ok: false, error: st.error || "Server failed to start" };
      }
      redis = new RedisClient();
      const host = opts.host || "127.0.0.1";
      let port = Number(opts.port) || 6379;
      // If connecting to embedded/native profile, use actual bound port
      const st = activeStatus();
      if (st.running && (host === "127.0.0.1" || host === "localhost") && opts.useServerPort !== false) {
        // Prefer live server port when profile points at default local
        if (Number(opts.port) === 6379 || !opts.port) port = st.port || port;
      }
      const info = await redis.connect({
        host,
        port,
        username: opts.username || "",
        password: opts.password || "",
        db: Number(opts.db) || 0,
      });
      return {
        ok: true,
        ...info,
        backend,
        server: activeStatus(),
      };
    } catch (err) {
      if (redis) {
        redis.disconnect();
        redis = null;
      }
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("redis:disconnect", async () => {
    if (redis) {
      redis.disconnect();
      redis = null;
    }
    return { ok: true };
  });

  ipcMain.handle("redis:status", async () => ({
    connected: !!(redis && redis.connected),
    db: redis ? redis.db : 0,
    host: redis ? redis.host : "",
    port: redis ? redis.port : 0,
    server: activeStatus(),
  }));

  ipcMain.handle("redis:keys", async (_e, pattern) => ensureRedis().listKeys(pattern || "*"));
  ipcMain.handle("redis:getEntry", async (_e, key) => ensureRedis().getEntry(key));
  ipcMain.handle("redis:setString", async (_e, key, value, ttl) => {
    await ensureRedis().setString(key, value, ttl);
    return { ok: true };
  });
  ipcMain.handle("redis:setHash", async (_e, key, fields, ttl) => {
    await ensureRedis().setHash(key, fields, ttl);
    return { ok: true };
  });
  ipcMain.handle("redis:setList", async (_e, key, values, ttl) => {
    await ensureRedis().setList(key, values, ttl);
    return { ok: true };
  });
  ipcMain.handle("redis:setSet", async (_e, key, members, ttl) => {
    await ensureRedis().setSet(key, members, ttl);
    return { ok: true };
  });
  ipcMain.handle("redis:setZSet", async (_e, key, members, ttl) => {
    await ensureRedis().setZSet(key, members, ttl);
    return { ok: true };
  });
  ipcMain.handle("redis:del", async (_e, keys) => ensureRedis().del(...(keys || [])));
  ipcMain.handle("redis:expire", async (_e, key, seconds) => ensureRedis().expire(key, seconds));
  ipcMain.handle("redis:persist", async (_e, key) => ensureRedis().persist(key));
  ipcMain.handle("redis:rename", async (_e, oldKey, newKey) => ensureRedis().rename(oldKey, newKey));
  ipcMain.handle("redis:select", async (_e, db) => {
    await ensureRedis().select(db);
    return { ok: true, db };
  });
  ipcMain.handle("redis:exec", async (_e, line) => ensureRedis().execLine(line));
  ipcMain.handle("redis:currentDb", async () => (redis ? redis.db : 0));
}

app.whenReady().then(async () => {
  registerIpc();
  try {
    await startServer();
  } catch (err) {
    console.error("[redis-server] start failed:", err);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (redis) {
    redis.disconnect();
    redis = null;
  }
  await stopServer();
  if (process.platform !== "darwin") app.quit();
});
