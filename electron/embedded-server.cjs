/**
 * Embedded redis-server: RESP protocol TCP server.
 * Loads redis.conf (Redis-compatible) from user data.
 */
const net = require("net");
const fs = require("fs");
const path = require("path");
const { EmbeddedEngine } = require("./embedded-engine.cjs");
const {
  parseRedisConf,
  serializeRedisConf,
  loadRedisConfFile,
  confToConfigGetPairs,
  parseMemory,
} = require("./redis-conf.cjs");

function encodeResp(value) {
  if (value instanceof Error) {
    const msg =
      value.message.startsWith("ERR") ||
      value.message.startsWith("WRONGTYPE") ||
      value.message.startsWith("NOAUTH") ||
      value.message.startsWith("NOPERM")
        ? value.message
        : `ERR ${value.message}`;
    return `-${msg}\r\n`;
  }
  if (value === null || value === undefined) return "$-1\r\n";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `:${Math.trunc(value)}\r\n`;
  }
  if (typeof value === "boolean") return `:${value ? 1 : 0}\r\n`;
  if (typeof value === "string") {
    if (value === "OK" || value === "PONG" || value === "QUEUED") {
      return `+${value}\r\n`;
    }
    const buf = Buffer.from(value, "utf8");
    return `$${buf.length}\r\n${value}\r\n`;
  }
  if (Array.isArray(value)) {
    let out = `*${value.length}\r\n`;
    for (const item of value) out += encodeResp(item);
    return out;
  }
  const s = String(value);
  const buf = Buffer.from(s, "utf8");
  return `$${buf.length}\r\n${s}\r\n`;
}

function parseResp(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const nl = buf.indexOf("\r\n", offset);
  if (nl === -1) return null;
  const line = buf.toString("utf8", offset + 1, nl);

  if (type === "+") return [line, nl + 2];
  if (type === "-") return [new Error(line), nl + 2];
  if (type === ":") return [Number(line), nl + 2];
  if (type === "$") {
    const len = Number(line);
    if (len === -1) return [null, nl + 2];
    const start = nl + 2;
    const end = start + len;
    if (buf.length < end + 2) return null;
    return [buf.toString("utf8", start, end), end + 2];
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) return [null, nl + 2];
    let pos = nl + 2;
    const arr = [];
    for (let i = 0; i < count; i++) {
      const next = parseResp(buf, pos);
      if (!next) return null;
      arr.push(next[0]);
      pos = next[1];
    }
    return [arr, pos];
  }
  // Inline / telnet protocol
  if (true) {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const raw = buf.toString("utf8", offset, lineEnd).trim();
    if (!raw) return [[], lineEnd + 2];
    const args = [];
    let cur = "";
    let q = null;
    for (const ch of raw) {
      if (q) {
        if (ch === q) q = null;
        else cur += ch;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (/\s/.test(ch)) {
        if (cur) {
          args.push(cur);
          cur = "";
        }
      } else cur += ch;
    }
    if (cur) args.push(cur);
    return [args, lineEnd + 2];
  }
}

class EmbeddedRedisServer {
  constructor() {
    this.engine = new EmbeddedEngine();
    this.server = null;
    this.host = "127.0.0.1";
    this.port = 6379;
    this.running = false;
    this.clients = new Set();
    this.seeded = false;
    this._chain = Promise.resolve();
    this.conf = parseRedisConf("");
    this.confPath = null;
    this.changesSinceSave = 0;
    this._saveTimer = null;
    this._lastSave = 0;
  }

  _withEngine(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  /**
   * Load redis.conf and start listening.
   * @param {{ confPath?: string, confText?: string, host?: string, preferredPort?: number, seed?: boolean }} opts
   */
  async start(opts = {}) {
    if (this.running) return this.status();

    if (opts.confPath) {
      const loaded = loadRedisConfFile(opts.confPath);
      this.conf = loaded.conf;
      this.confPath = loaded.path;
      this._rawConfText = loaded.text;
    } else if (opts.confText) {
      this.conf = parseRedisConf(opts.confText);
      this._rawConfText = opts.confText;
    }

    // databases from conf
    const nDb = Number(this.conf.databases) || 16;
    this.engine = new EmbeddedEngine(nDb);

    const dataDir = path.resolve(String(this.conf.dir || "./"));
    fs.mkdirSync(dataDir, { recursive: true });
    this.conf.dir = dataDir;

    // Load RDB snapshot if present
    const dumpPath = path.join(dataDir, String(this.conf.dbfilename || "dump.rdb"));
    const loadedDump = this._loadDump(dumpPath);

    const seed =
      opts.seed !== undefined
        ? opts.seed
        : this.conf.seed_demo !== false && !loadedDump;
    if (seed && !this.seeded) {
      this.engine.seedDemo();
      this.seeded = true;
    }

    const host = opts.host || String(this.conf.bind || "127.0.0.1").split(/\s+/)[0];
    const preferred = Number(opts.preferredPort || this.conf.port) || 6379;
    const ports = [preferred, preferred + 1, preferred + 2, 16379, 26379];

    let lastErr;
    for (const port of ports) {
      try {
        await this._listen(host, port);
        this.host = host;
        this.port = port;
        this.conf.port = port;
        this.running = true;
        this._scheduleSaves();
        return this.status();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Could not bind embedded Redis server");
  }

  _listen(host, port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ backlog: Number(this.conf.tcp_backlog) || 511 }, (socket) =>
        this._onConnection(socket),
      );
      const onErr = (err) => {
        server.removeAllListeners();
        reject(err);
      };
      server.once("error", onErr);
      server.listen(port, host, () => {
        server.removeListener("error", onErr);
        server.on("error", (err) => console.error("[embedded-redis]", err));
        this.server = server;
        resolve();
      });
    });
  }

  _onConnection(socket) {
    const maxClients = Number(this.conf.maxclients) || 10000;
    if (this.clients.size >= maxClients) {
      socket.write(encodeResp(new Error("ERR max number of clients reached")));
      socket.destroy();
      return;
    }

    this.clients.add(socket);
    let sessionDb = 0;
    let authenticated = !this.conf.requirepass;
    let buffer = Buffer.alloc(0);
    const timeoutSec = Number(this.conf.timeout) || 0;
    if (timeoutSec > 0) socket.setTimeout(timeoutSec * 1000);

    socket.on("timeout", () => {
      socket.write(encodeResp(new Error("ERR idle timeout")));
      socket.destroy();
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const processBuffer = () => {
        const parsed = parseResp(buffer, 0);
        if (!parsed) return;
        const [value, consumed] = parsed;
        buffer = buffer.subarray(consumed);

        let args = value;
        if (!Array.isArray(args)) {
          socket.write(encodeResp(new Error("ERR Protocol error: expected array")));
          processBuffer();
          return;
        }

        void this._withEngine(() => {
          try {
            const rawCmd = String(args[0] || "").toUpperCase();
            // rename-command
            const renames = this.conf.rename_command || {};
            let cmd = rawCmd;
            if (renames[rawCmd] !== undefined) {
              const mapped = renames[rawCmd];
              if (mapped === "" || mapped == null) {
                socket.write(encodeResp(new Error(`ERR unknown command '${rawCmd.toLowerCase()}'`)));
                processBuffer();
                return;
              }
              cmd = String(mapped).toUpperCase();
              args = [cmd, ...args.slice(1)];
            }

            // AUTH
            if (cmd === "AUTH") {
              const pass = this.conf.requirepass || "";
              const provided =
                args.length >= 3 ? String(args[2]) : String(args[1] || "");
              if (!pass || provided === pass) {
                authenticated = true;
                socket.write(encodeResp("OK"));
              } else {
                authenticated = false;
                socket.write(encodeResp(new Error("WRONGPASS invalid username-password pair")));
              }
              processBuffer();
              return;
            }

            if (!authenticated && cmd !== "HELLO" && cmd !== "PING" && cmd !== "QUIT") {
              // Redis allows PING before auth in some versions; we require AUTH when requirepass set
              if (cmd !== "PING" || this.conf.requirepass) {
                if (cmd !== "PING") {
                  socket.write(encodeResp(new Error("NOAUTH Authentication required.")));
                  processBuffer();
                  return;
                }
              }
            }
            if (!authenticated && this.conf.requirepass && cmd !== "AUTH" && cmd !== "QUIT") {
              socket.write(encodeResp(new Error("NOAUTH Authentication required.")));
              processBuffer();
              return;
            }

            // CONFIG commands
            if (cmd === "CONFIG") {
              const sub = String(args[1] || "").toUpperCase();
              if (sub === "GET") {
                const pattern = String(args[2] || "*");
                const pairs = confToConfigGetPairs(this.conf);
                if (pattern === "*") {
                  socket.write(encodeResp(pairs));
                } else {
                  const re = globToRegExp(pattern);
                  const filtered = [];
                  for (let i = 0; i < pairs.length; i += 2) {
                    if (re.test(pairs[i])) {
                      filtered.push(pairs[i], pairs[i + 1]);
                    }
                  }
                  socket.write(encodeResp(filtered));
                }
                processBuffer();
                return;
              }
              if (sub === "SET") {
                const key = String(args[2] || "").toLowerCase().replace(/-/g, "_");
                const val = args[3];
                this._configSet(key, val);
                socket.write(encodeResp("OK"));
                processBuffer();
                return;
              }
              if (sub === "REWRITE") {
                this.saveConf();
                socket.write(encodeResp("OK"));
                processBuffer();
                return;
              }
              socket.write(encodeResp(new Error("ERR CONFIG subcommand not supported")));
              processBuffer();
              return;
            }

            if (cmd === "SAVE" || cmd === "BGSAVE") {
              this._saveDump();
              socket.write(encodeResp("OK"));
              processBuffer();
              return;
            }

            if (cmd === "LASTSAVE") {
              socket.write(encodeResp(Math.floor((this._lastSave || Date.now()) / 1000)));
              processBuffer();
              return;
            }

            if (cmd === "SHUTDOWN") {
              this._saveDump();
              socket.write(encodeResp("OK"));
              socket.end();
              // don't stop whole server from one client unless SAVE
              processBuffer();
              return;
            }

            if (cmd === "INFO") {
              socket.write(encodeResp(this._infoText()));
              processBuffer();
              return;
            }

            const prev = this.engine.dbIndex;
            this.engine.dbIndex = sessionDb;
            try {
              const result = this.engine.dispatch(args.map(String));
              if (cmd === "SELECT" && args[1] !== undefined) {
                sessionDb = this.engine.dbIndex;
              }
              // Track dirty for save
              if (
                [
                  "SET",
                  "SETEX",
                  "SETNX",
                  "MSET",
                  "GETSET",
                  "APPEND",
                  "INCR",
                  "INCRBY",
                  "DECR",
                  "DECRBY",
                  "DEL",
                  "EXPIRE",
                  "PERSIST",
                  "RENAME",
                  "FLUSHDB",
                  "FLUSHALL",
                  "HSET",
                  "HMSET",
                  "HDEL",
                  "HINCRBY",
                  "LPUSH",
                  "RPUSH",
                  "LPOP",
                  "RPOP",
                  "SADD",
                  "SREM",
                  "ZADD",
                  "ZREM",
                ].includes(cmd)
              ) {
                this.changesSinceSave++;
              }
              if (cmd === "QUIT") {
                socket.write(encodeResp("OK"));
                socket.end();
                return;
              }
              socket.write(encodeResp(result));
            } catch (err) {
              socket.write(encodeResp(err instanceof Error ? err : new Error(String(err))));
            } finally {
              this.engine.dbIndex = prev;
            }
            processBuffer();
          } catch (err) {
            socket.write(encodeResp(err instanceof Error ? err : new Error(String(err))));
            processBuffer();
          }
        });
      };
      processBuffer();
    });

    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }

  _configSet(key, val) {
    // Redis uses hyphenated names; clients may send either form
    const k = String(key || "").toLowerCase().replace(/-/g, "_");
    switch (k) {
      case "requirepass":
        this.conf.requirepass = String(val ?? "");
        break;
      case "maxmemory":
        this.conf.maxmemory = parseMemory(String(val ?? "0"));
        break;
      case "maxmemory_policy":
        this.conf.maxmemory_policy = String(val ?? "noeviction");
        break;
      case "maxclients":
        this.conf.maxclients = Number(val) || 10000;
        break;
      case "timeout":
        this.conf.timeout = Number(val) || 0;
        break;
      case "loglevel":
        this.conf.loglevel = String(val ?? "notice");
        break;
      case "appendonly":
        this.conf.appendonly = String(val).toLowerCase() === "yes";
        break;
      case "appendfsync":
        this.conf.appendfsync = String(val ?? "everysec");
        break;
      case "dir":
        this.conf.dir = String(val ?? this.conf.dir);
        fs.mkdirSync(this.conf.dir, { recursive: true });
        break;
      case "dbfilename":
        this.conf.dbfilename = String(val ?? "dump.rdb");
        break;
      case "protected_mode":
        this.conf.protected_mode = String(val).toLowerCase() === "yes";
        break;
      case "seed_demo":
        this.conf.seed_demo = String(val).toLowerCase() === "yes";
        break;
      case "notify_keyspace_events":
        // Accept "" / empty to disable; any AEK$lshzxe... flags like real Redis
        this.conf.notify_keyspace_events = String(val ?? "");
        break;
      case "save":
        // CONFIG SET save "900 1 300 10"
        {
          const parts = String(val || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const saves = [];
          for (let i = 0; i + 1 < parts.length; i += 2) {
            saves.push([Number(parts[i]), Number(parts[i + 1])]);
          }
          this.conf.save = saves;
          this._scheduleSaves();
        }
        break;
      default: {
        // Pass-through: store unknown params (CONFIG GET * will return them)
        if (!this.conf._extras) this.conf._extras = {};
        const redisKey = k.replace(/_/g, "-");
        this.conf._extras[redisKey] = String(val ?? "");
        this.conf[k] = String(val ?? "");
        break;
      }
    }
  }

  _scheduleSaves() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    const rules = Array.isArray(this.conf.save) ? this.conf.save : [];
    if (!rules.length) return;
    // Check every 5s whether a save rule triggers
    this._saveTimer = setInterval(() => {
      const now = Date.now();
      for (const [sec, changes] of rules) {
        if (
          this.changesSinceSave >= changes &&
          now - this._lastSave >= sec * 1000
        ) {
          try {
            this._saveDump();
          } catch (e) {
            console.error("[embedded-redis] save failed", e);
          }
          break;
        }
      }
    }, 5000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _dumpPath() {
    return path.join(
      path.resolve(String(this.conf.dir || "./")),
      String(this.conf.dbfilename || "dump.rdb"),
    );
  }

  _saveDump() {
    const dumpPath = this._dumpPath();
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    const payload = {
      magic: "REDIS-DESKTOP-DUMP",
      version: 1,
      redis_version: "7.2.0-embedded",
      saved_at: Date.now(),
      databases: this.engine.exportAll(),
    };
    const json = JSON.stringify(payload);
    // Optional "compression" flag: still JSON but we honor the conf bit for INFO
    fs.writeFileSync(dumpPath, json, "utf8");
    this.changesSinceSave = 0;
    this._lastSave = Date.now();
    return dumpPath;
  }

  _loadDump(dumpPath) {
    try {
      if (!fs.existsSync(dumpPath)) return false;
      const raw = fs.readFileSync(dumpPath, "utf8");
      const data = JSON.parse(raw);
      if (!data || data.magic !== "REDIS-DESKTOP-DUMP") return false;
      this.engine.importAll(data.databases || {});
      this._lastSave = data.saved_at || Date.now();
      this.seeded = true;
      return true;
    } catch (e) {
      console.error("[embedded-redis] load dump failed", e.message);
      return false;
    }
  }

  _infoText() {
    const c = this.conf;
    const lines = [
      "# Server",
      "redis_version:7.2.0-embedded",
      "redis_mode:standalone",
      "os:Redis-Desktop-Embedded",
      "arch_bits:64",
      `tcp_port:${this.port}`,
      `config_file:${this.confPath || ""}`,
      "executable:redis-desktop-embedded",
      "",
      "# Clients",
      `connected_clients:${this.clients.size}`,
      `maxclients:${c.maxclients}`,
      "",
      "# Memory",
      `maxmemory:${c.maxmemory || 0}`,
      `maxmemory_policy:${c.maxmemory_policy}`,
      "",
      "# Persistence",
      `loading:0`,
      `rdb_last_save_time:${Math.floor((this._lastSave || 0) / 1000)}`,
      `rdb_changes_since_last_save:${this.changesSinceSave}`,
      `aof_enabled:${c.appendonly ? 1 : 0}`,
      "",
      "# Stats",
      `total_connections_received:${this.clients.size}`,
      "",
      "# Keyspace",
    ];
    for (let i = 0; i < (c.databases || 16); i++) {
      const prev = this.engine.dbIndex;
      this.engine.dbIndex = i;
      const n = this.engine.dbsize();
      this.engine.dbIndex = prev;
      if (n > 0) lines.push(`db${i}:keys=${n},expires=0,avg_ttl=0`);
    }
    return lines.join("\r\n") + "\r\n";
  }

  saveConf() {
    if (!this.confPath) return null;
    const text = this._rawConfText || serializeRedisConf(this.conf);
    fs.writeFileSync(this.confPath, text, "utf8");
    return this.confPath;
  }

  reloadConf(confPath) {
    const p = confPath || this.confPath;
    if (!p) throw new Error("No conf path");
    const loaded = loadRedisConfFile(p);
    this.conf = loaded.conf;
    this.confPath = loaded.path;
    this._scheduleSaves();
    return this.conf;
  }

  getConfText() {
    if (this._rawConfText) return this._rawConfText;
    if (this.confPath && fs.existsSync(this.confPath)) {
      return fs.readFileSync(this.confPath, "utf8");
    }
    return serializeRedisConf(this.conf);
  }

  setConfText(text, { restart = false } = {}) {
    // Keep raw redis.conf text — do not re-serialize (would drop notify-keyspace-events, etc.)
    const conf = parseRedisConf(text);
    if (this.confPath) {
      let out = String(text);
      if ((!conf.dir || conf.dir === "./") && this.conf.dir) {
        conf.dir = this.conf.dir;
        if (/^\s*dir\s+/im.test(out)) {
          out = out.replace(/^\s*dir\s+.*/gim, `dir ${JSON.stringify(this.conf.dir)}`);
        }
      }
      fs.writeFileSync(this.confPath, out, "utf8");
      this._rawConfText = out;
    } else {
      this._rawConfText = String(text);
    }
    this.conf = conf;
    this._scheduleSaves();
    return { conf: this.conf, path: this.confPath };
  }

  stop() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      if (this.running && this.changesSinceSave > 0) this._saveDump();
    } catch {
      /* ignore */
    }
    for (const c of this.clients) {
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
    }
    this.server = null;
    this.running = false;
  }

  reseed() {
    this.engine.seedDemo();
    this.seeded = true;
    this.changesSinceSave++;
  }

  status() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      clients: this.clients.size,
      mode: "embedded",
      version: "7.2.0-embedded",
      confPath: this.confPath,
      requirepass: !!this.conf.requirepass,
      databases: this.conf.databases,
      maxmemory: this.conf.maxmemory,
      dir: this.conf.dir,
      dbfilename: this.conf.dbfilename,
      appendonly: !!this.conf.appendonly,
      save: this.conf.save,
    };
  }
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if ("+^${}()|[]\\.".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp(out + "$", "i");
}

module.exports = { EmbeddedRedisServer, encodeResp };
