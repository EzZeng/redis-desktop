/**
 * Spawn real redis-server.exe (redis-windows / msys2 build) when available.
 * Falls back to the JS embedded server on non-Windows or if binary is missing.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { ensureUserRedisConf, parseRedisConf, loadRedisConfFile } = require("./redis-conf.cjs");

function resolveRedisBinDir() {
  // Packaged: resources/redis-windows
  // Dev: vendor/redis-windows or electron/../vendor
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "redis-windows"));
  }
  candidates.push(path.join(__dirname, "..", "redis-server-win"));
  candidates.push(path.join(__dirname, "..", "vendor", "redis-windows"));
  candidates.push(path.join(__dirname, "redis-windows"));
  for (const dir of candidates) {
    const exe = path.join(dir, "redis-server.exe");
    if (fs.existsSync(exe)) return dir;
  }
  return null;
}

function waitForPort(host, port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(800);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timeout waiting for redis on ${host}:${port}`));
        else setTimeout(tryOnce, 150);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Timeout waiting for redis on ${host}:${port}`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

/**
 * Prepare a redis.conf suitable for native redis-server.exe
 * - forces daemonize no (we manage the process)
 * - sets dir/dbfilename under user data
 * - strips seed-demo (not a real redis directive — comment it)
 */
function prepareNativeConf(userConfPath, dataDir) {
  let text = fs.readFileSync(userConfPath, "utf8");
  // Comment out Redis Desktop–only directives that real redis-server rejects
  text = text.replace(/^\s*seed-demo\s+.*/gim, "# seed-demo (Redis Desktop only — ignored by redis-server.exe)");
  // Ensure daemonize no
  if (/^\s*daemonize\s+/im.test(text)) {
    text = text.replace(/^\s*daemonize\s+.*/gim, "daemonize no");
  } else {
    text += "\ndaemonize no\n";
  }
  // supervised no
  if (/^\s*supervised\s+/im.test(text)) {
    text = text.replace(/^\s*supervised\s+.*/gim, "supervised no");
  }
  // dir absolute
  const absDir = path.resolve(dataDir);
  fs.mkdirSync(absDir, { recursive: true });
  if (/^\s*dir\s+/im.test(text)) {
    text = text.replace(/^\s*dir\s+.*/gim, `dir ${JSON.stringify(absDir)}`);
  } else {
    text += `\ndir ${JSON.stringify(absDir)}\n`;
  }
  // logfile into data dir for debugging
  const logFile = path.join(absDir, "redis-server.log");
  if (/^\s*logfile\s+/im.test(text)) {
    text = text.replace(/^\s*logfile\s+.*/gim, `logfile ${JSON.stringify(logFile)}`);
  } else {
    text += `\nlogfile ${JSON.stringify(logFile)}\n`;
  }
  // pidfile
  const pidFile = path.join(absDir, "redis.pid");
  if (/^\s*pidfile\s+/im.test(text)) {
    text = text.replace(/^\s*pidfile\s+.*/gim, `pidfile ${JSON.stringify(pidFile)}`);
  } else {
    text += `\npidfile ${JSON.stringify(pidFile)}\n`;
  }

  const outPath = path.join(path.dirname(userConfPath), "redis-server.runtime.conf");
  fs.writeFileSync(outPath, text, "utf8");
  const conf = parseRedisConf(text);
  return { confPath: outPath, conf, dataDir: absDir, logFile, pidFile };
}

class NativeRedisServer {
  constructor() {
    this.proc = null;
    this.binDir = null;
    this.confPath = null;
    this.userConfPath = null;
    this.host = "127.0.0.1";
    this.port = 6379;
    this.running = false;
    this.mode = "native";
    this.version = "unknown";
    this.logTail = "";
  }

  available() {
    return process.platform === "win32" && !!resolveRedisBinDir();
  }

  resolveBin() {
    this.binDir = resolveRedisBinDir();
    if (!this.binDir) return null;
    const exe = path.join(this.binDir, "redis-server.exe");
    const verFile = path.join(this.binDir, "VERSION");
    if (fs.existsSync(verFile)) {
      this.version = fs.readFileSync(verFile, "utf8").split("\n")[0].trim();
    } else {
      this.version = "redis-server.exe";
    }
    return exe;
  }

  async start({ userDataDir, bundledAppConf }) {
    if (this.running) return this.status();
    const exe = this.resolveBin();
    if (!exe) throw new Error("redis-server.exe not found (redis-windows bundle missing)");

    // User conf: prefer real redis.conf template from vendor on first run
    const bundledDefault =
      (this.binDir && path.join(this.binDir, "redis.conf")) ||
      bundledAppConf;
    this.userConfPath = ensureUserRedisConf(userDataDir, bundledDefault);
    // Patch first-run conf: bind localhost, no protected issues
    this._ensureSafeUserConf(this.userConfPath);

    const dataDir = path.join(userDataDir, "data");
    const prepared = prepareNativeConf(this.userConfPath, dataDir);
    this.confPath = prepared.confPath;
    const conf = prepared.conf;
    this.host = String(conf.bind || "127.0.0.1").split(/\s+/)[0] || "127.0.0.1";
    if (this.host === "0.0.0.0" || this.host === "*" || this.host === "-::*") {
      this.host = "127.0.0.1";
    }
    this.port = Number(conf.port) || 6379;

    // If port busy, try alternate ports by rewriting runtime conf
    const ports = [this.port, this.port + 1, this.port + 2, 16379, 26379];
    let lastErr;
    for (const port of ports) {
      try {
        await this._spawn(exe, prepared.confPath, prepared, port);
        this.port = port;
        this.running = true;
        return this.status();
      } catch (e) {
        lastErr = e;
        this._killSilent();
      }
    }
    throw lastErr || new Error("Failed to start redis-server.exe");
  }

  _ensureSafeUserConf(userConfPath) {
    let text = fs.readFileSync(userConfPath, "utf8");
    let changed = false;
    // Prefer loopback bind if missing
    if (!/^\s*bind\s+/im.test(text)) {
      text = `bind 127.0.0.1\n` + text;
      changed = true;
    }
    if (!/^\s*port\s+/im.test(text)) {
      text = `port 6379\n` + text;
      changed = true;
    }
    if (changed) fs.writeFileSync(userConfPath, text, "utf8");
  }

  _spawn(exe, baseRuntimeConf, prepared, port) {
    return new Promise(async (resolve, reject) => {
      // Rewrite port in a per-attempt conf copy
      let text = fs.readFileSync(baseRuntimeConf, "utf8");
      if (/^\s*port\s+/im.test(text)) {
        text = text.replace(/^\s*port\s+.*/gim, `port ${port}`);
      } else {
        text += `\nport ${port}\n`;
      }
      const confPath = path.join(path.dirname(baseRuntimeConf), `redis-server.${port}.conf`);
      fs.writeFileSync(confPath, text, "utf8");
      this.confPath = confPath;

      const args = [confPath];
      const proc = spawn(exe, args, {
        cwd: this.binDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: this.binDir + path.delimiter + (process.env.PATH || ""),
        },
      });
      this.proc = proc;
      let stderr = "";
      proc.stdout.on("data", (d) => {
        this.logTail = (this.logTail + d.toString()).slice(-4000);
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
        this.logTail = (this.logTail + d.toString()).slice(-4000);
      });

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      proc.on("error", fail);
      proc.on("exit", (code) => {
        this.running = false;
        this.proc = null;
        if (!settled) {
          fail(new Error(`redis-server exited early (code ${code}): ${stderr || this.logTail}`));
        }
      });

      try {
        await waitForPort(this.host === "0.0.0.0" ? "127.0.0.1" : this.host, port, 12000);
        if (!settled) {
          settled = true;
          resolve();
        }
      } catch (e) {
        fail(e);
      }
    });
  }

  _killSilent() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.proc = null;
    this.running = false;
  }

  async stop() {
    if (!this.proc) {
      this.running = false;
      return;
    }
    const proc = this.proc;
    try {
      // Prefer graceful SHUTDOWN via redis-cli if available
      const cli = this.binDir && path.join(this.binDir, "redis-cli.exe");
      if (cli && fs.existsSync(cli)) {
        await new Promise((resolve) => {
          const c = spawn(cli, ["-h", this.host, "-p", String(this.port), "SHUTDOWN", "NOSAVE"], {
            windowsHide: true,
            stdio: "ignore",
            cwd: this.binDir,
          });
          const t = setTimeout(() => {
            try {
              c.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }, 2000);
          c.on("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    } catch {
      /* ignore */
    }
    try {
      if (!proc.killed) proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.running = false;
  }

  async restart(opts) {
    await this.stop();
    // small delay for port release on Windows
    await new Promise((r) => setTimeout(r, 400));
    return this.start(opts);
  }

  getConfText() {
    if (this.userConfPath && fs.existsSync(this.userConfPath)) {
      return fs.readFileSync(this.userConfPath, "utf8");
    }
    return "";
  }

  setConfText(text) {
    if (!this.userConfPath) throw new Error("No user conf path");
    fs.writeFileSync(this.userConfPath, text, "utf8");
  }

  status() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      clients: 0,
      mode: "native-redis-server",
      version: this.version,
      confPath: this.userConfPath,
      runtimeConfPath: this.confPath,
      binDir: this.binDir,
      requirepass: false,
      engine: "redis-server.exe",
    };
  }
}

module.exports = {
  NativeRedisServer,
  resolveRedisBinDir,
  waitForPort,
};
