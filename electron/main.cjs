const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const { RedisClient } = require("./redis-client.cjs");
const { EmbeddedRedisServer } = require("./embedded-server.cjs");
const { ensureUserRedisConf, serializeRedisConf } = require("./redis-conf.cjs");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {RedisClient | null} */
let redis = null;
/** @type {EmbeddedRedisServer} */
const embedded = new EmbeddedRedisServer();

function confPaths() {
  const userData = app.getPath("userData");
  const bundled = path.join(__dirname, "redis.conf");
  return { userData, bundled, confPath: path.join(userData, "redis.conf") };
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
  if (!redis || !redis.connected) {
    throw new Error("Not connected to Redis");
  }
  return redis;
}

async function startEmbeddedFromConf() {
  const { userData, bundled } = confPaths();
  const confPath = ensureUserRedisConf(userData, bundled);
  const st = await embedded.start({ confPath, seed: undefined });
  console.log(`[embedded-redis] ${st.host}:${st.port} conf=${confPath}`);
  return st;
}

function registerIpc() {
  ipcMain.handle("redis:server:status", async () => embedded.status());

  ipcMain.handle("redis:server:start", async (_e, opts = {}) => {
    try {
      if (embedded.running) return { ok: true, ...embedded.status() };
      const st = await startEmbeddedFromConf();
      return { ok: true, ...st };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("redis:server:stop", async () => {
    embedded.stop();
    return { ok: true, ...embedded.status() };
  });

  ipcMain.handle("redis:server:reseed", async () => {
    embedded.reseed();
    return { ok: true };
  });

  ipcMain.handle("redis:server:conf:get", async () => {
    return {
      ok: true,
      path: embedded.confPath || confPaths().confPath,
      text: embedded.getConfText(),
      status: embedded.status(),
    };
  });

  ipcMain.handle("redis:server:conf:set", async (_e, payload = {}) => {
    try {
      const text = String(payload.text || "");
      if (!embedded.confPath) {
        const confPath = ensureUserRedisConf(confPaths().userData, confPaths().bundled);
        embedded.confPath = confPath;
      }
      embedded.setConfText(text);
      // Restart server to apply bind/port/databases
      const wasRunning = embedded.running;
      const clientWas = redis && redis.connected;
      if (wasRunning) {
        embedded.stop();
        await startEmbeddedFromConf();
      }
      return {
        ok: true,
        path: embedded.confPath,
        status: embedded.status(),
        restarted: wasRunning,
        reconnect: clientWas,
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("redis:server:conf:path", async () => {
    return { path: embedded.confPath || confPaths().confPath };
  });

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
      // Auto-start embedded if connecting to its bind address
      if (!embedded.running) {
        try {
          await startEmbeddedFromConf();
        } catch {
          /* external only */
        }
      }
      redis = new RedisClient();
      const info = await redis.connect({
        host: opts.host || "127.0.0.1",
        port: Number(opts.port) || 6379,
        username: opts.username || "",
        password: opts.password || "",
        db: Number(opts.db) || 0,
      });
      return {
        ok: true,
        ...info,
        embedded: embedded.running && Number(opts.port) === embedded.port,
        confPath: embedded.confPath,
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

  ipcMain.handle("redis:status", async () => {
    return {
      connected: !!(redis && redis.connected),
      db: redis ? redis.db : 0,
      host: redis ? redis.host : "",
      port: redis ? redis.port : 0,
      server: embedded.status(),
    };
  });

  ipcMain.handle("redis:keys", async (_e, pattern) => {
    return ensureRedis().listKeys(pattern || "*");
  });
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
  ipcMain.handle("redis:rename", async (_e, oldKey, newKey) =>
    ensureRedis().rename(oldKey, newKey),
  );
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
    await startEmbeddedFromConf();
  } catch (err) {
    console.error("[embedded-redis] failed to start:", err);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (redis) {
    redis.disconnect();
    redis = null;
  }
  embedded.stop();
  if (process.platform !== "darwin") app.quit();
});
