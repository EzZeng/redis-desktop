/**
 * redis.conf parser / serializer — Redis-compatible subset.
 * Supports common directives used by redis-server.
 */
const fs = require("fs");
const path = require("path");

/** @typedef {Record<string, string | string[] | number | boolean | Array<number[]>>} RedisConfig */

const DEFAULTS = {
  // Network
  bind: "127.0.0.1",
  port: 6379,
  timeout: 0,
  tcp_backlog: 511,
  protected_mode: true,
  tcp_keepalive: 300,
  // General
  databases: 16,
  // Security
  requirepass: "",
  // Memory
  maxmemory: 0, // 0 = unlimited
  maxmemory_policy: "noeviction",
  maxclients: 10000,
  // Persistence
  dir: "./",
  dbfilename: "dump.rdb",
  save: [[900, 1], [300, 10], [60, 10000]], // seconds changes
  stop_writes_on_bgsave_error: true,
  rdbcompression: true,
  rdbchecksum: true,
  appendonly: false,
  appendfilename: "appendonly.aof",
  appendfsync: "everysec",
  // Logging
  loglevel: "notice",
  logfile: "",
  // Misc
  daemonize: false,
  pidfile: "",
  // App-specific
  seed_demo: true,
};

const YES = new Set(["yes", "true", "on", "1"]);
const NO = new Set(["no", "false", "off", "0"]);

function parseBool(v) {
  const s = String(v).toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return Boolean(v);
}

function parseMemory(v) {
  const s = String(v).trim().toLowerCase();
  if (!s || s === "0") return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?)?$/i);
  if (!m) return Number(s) || 0;
  const n = parseFloat(m[1]);
  const u = (m[2] || "").toLowerCase();
  if (u.startsWith("k")) return Math.floor(n * 1024);
  if (u.startsWith("m")) return Math.floor(n * 1024 * 1024);
  if (u.startsWith("g")) return Math.floor(n * 1024 * 1024 * 1024);
  if (u.startsWith("t")) return Math.floor(n * 1024 * 1024 * 1024 * 1024);
  return Math.floor(n);
}

function formatMemory(bytes) {
  if (!bytes) return "0";
  if (bytes % (1024 * 1024 * 1024) === 0) return `${bytes / (1024 * 1024 * 1024)}gb`;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}mb`;
  if (bytes % 1024 === 0) return `${bytes / 1024}kb`;
  return String(bytes);
}

/**
 * Parse redis.conf text into a config object.
 */
function parseRedisConf(text) {
  /** @type {RedisConfig} */
  const conf = { ...DEFAULTS, save: [...DEFAULTS.save.map((x) => [...x])] };
  conf.save = [];
  const renameCommand = {};
  const lines = String(text || "").split(/\r?\n/);

  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // strip inline comments (not inside quotes)
    let inQ = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"' && line[i - 1] !== "\\") inQ = !inQ;
      if (!inQ && line[i] === "#") {
        cut = i;
        break;
      }
    }
    line = line.slice(0, cut).trim();
    if (!line) continue;

    const parts = tokenize(line);
    if (!parts.length) continue;
    const key = parts[0].toLowerCase().replace(/-/g, "_");
    const args = parts.slice(1);

    switch (key) {
      case "bind":
        conf.bind = args.join(" ") || "127.0.0.1";
        break;
      case "port":
        conf.port = Number(args[0]) || 6379;
        break;
      case "timeout":
        conf.timeout = Number(args[0]) || 0;
        break;
      case "tcp_backlog":
        conf.tcp_backlog = Number(args[0]) || 511;
        break;
      case "tcp_keepalive":
        conf.tcp_keepalive = Number(args[0]) || 0;
        break;
      case "protected_mode":
        conf.protected_mode = parseBool(args[0]);
        break;
      case "databases":
        conf.databases = Math.min(64, Math.max(1, Number(args[0]) || 16));
        break;
      case "requirepass":
        conf.requirepass = unquote(args[0] || "");
        break;
      case "masterauth":
        conf.masterauth = unquote(args[0] || "");
        break;
      case "maxmemory":
        conf.maxmemory = parseMemory(args[0] || "0");
        break;
      case "maxmemory_policy":
        conf.maxmemory_policy = String(args[0] || "noeviction");
        break;
      case "maxclients":
        conf.maxclients = Number(args[0]) || 10000;
        break;
      case "dir":
        conf.dir = unquote(args[0] || "./");
        break;
      case "dbfilename":
        conf.dbfilename = unquote(args[0] || "dump.rdb");
        break;
      case "save":
        if (args.length === 0 || (args.length === 1 && args[0] === '""')) {
          conf.save = [];
        } else if (args.length >= 2) {
          conf.save.push([Number(args[0]), Number(args[1])]);
        }
        break;
      case "stop_writes_on_bgsave_error":
        conf.stop_writes_on_bgsave_error = parseBool(args[0]);
        break;
      case "rdbcompression":
        conf.rdbcompression = parseBool(args[0]);
        break;
      case "rdbchecksum":
        conf.rdbchecksum = parseBool(args[0]);
        break;
      case "appendonly":
        conf.appendonly = parseBool(args[0]);
        break;
      case "appendfilename":
        conf.appendfilename = unquote(args[0] || "appendonly.aof");
        break;
      case "appendfsync":
        conf.appendfsync = String(args[0] || "everysec");
        break;
      case "loglevel":
        conf.loglevel = String(args[0] || "notice");
        break;
      case "logfile":
        conf.logfile = unquote(args[0] || "");
        break;
      case "daemonize":
        conf.daemonize = parseBool(args[0]);
        break;
      case "pidfile":
        conf.pidfile = unquote(args[0] || "");
        break;
      case "rename_command":
        if (args.length >= 2) {
          renameCommand[String(args[0]).toUpperCase()] = unquote(args[1]);
        }
        break;
      case "seed_demo":
        conf.seed_demo = parseBool(args[0]);
        break;
      case "include":
        // handled by loadRedisConfFile recursively
        conf._includes = conf._includes || [];
        conf._includes.push(unquote(args[0] || ""));
        break;
      default:
        // keep unknown as string for CONFIG GET *
        conf[`_${key}`] = args.join(" ");
        break;
    }
  }

  if (!conf.save || conf.save.length === 0) {
    // If user cleared all save lines, keep empty (no RDB autosave)
  }
  conf.rename_command = renameCommand;
  return conf;
}

function tokenize(line) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === "\\" && i + 1 < line.length) {
        cur += line[++i];
      } else if (ch === q) {
        q = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur !== "" || parts.length) {
        if (cur !== "" || true) {
          if (cur !== "" || (parts.length && false)) {
            /* fallthrough */
          }
        }
        if (cur !== "") {
          parts.push(cur);
          cur = "";
        }
      }
    } else {
      cur += ch;
    }
  }
  if (cur !== "") parts.push(cur);
  return parts;
}

function unquote(s) {
  s = String(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize config back to redis.conf text.
 */
function serializeRedisConf(conf) {
  const c = { ...DEFAULTS, ...conf };
  const lines = [
    "# Redis configuration file for Redis Desktop (embedded server)",
    "# Compatible with redis.conf directive names.",
    "# Docs: https://redis.io/docs/latest/operate/oss_and_stack/management/config-file/",
    "",
    "################################## NETWORK #####################################",
    "",
    `bind ${c.bind}`,
    `protected-mode ${c.protected_mode ? "yes" : "no"}`,
    `port ${c.port}`,
    `tcp-backlog ${c.tcp_backlog}`,
    `timeout ${c.timeout}`,
    `tcp-keepalive ${c.tcp_keepalive}`,
    "",
    "################################# GENERAL #####################################",
    "",
    `daemonize ${c.daemonize ? "yes" : "no"}`,
    `pidfile ${c.pidfile || '""'}`,
    `loglevel ${c.loglevel}`,
    `logfile ${c.logfile ? JSON.stringify(c.logfile) : '""'}`,
    `databases ${c.databases}`,
    "",
    "################################ SNAPSHOTTING ################################",
    "",
  ];

  const saves = Array.isArray(c.save) ? c.save : [];
  if (!saves.length) {
    lines.push('# save ""  # disabled');
    lines.push('save ""');
  } else {
    for (const [sec, ch] of saves) {
      lines.push(`save ${sec} ${ch}`);
    }
  }

  lines.push(
    `stop-writes-on-bgsave-error ${c.stop_writes_on_bgsave_error ? "yes" : "no"}`,
    `rdbcompression ${c.rdbcompression ? "yes" : "no"}`,
    `rdbchecksum ${c.rdbchecksum ? "yes" : "no"}`,
    `dbfilename ${c.dbfilename}`,
    `dir ${JSON.stringify(c.dir)}`,
    "",
    "################################# SECURITY ###################################",
    "",
  );

  if (c.requirepass) {
    lines.push(`requirepass ${JSON.stringify(c.requirepass)}`);
  } else {
    lines.push("# requirepass foobared");
  }

  const renames = c.rename_command || {};
  for (const [from, to] of Object.entries(renames)) {
    lines.push(`rename-command ${from} ${JSON.stringify(to)}`);
  }

  lines.push(
    "",
    "################################### CLIENTS ####################################",
    "",
    `maxclients ${c.maxclients}`,
    "",
    "############################## MEMORY MANAGEMENT ##############################",
    "",
    `maxmemory ${formatMemory(c.maxmemory || 0)}`,
    `maxmemory-policy ${c.maxmemory_policy}`,
    "",
    "############################## APPEND ONLY MODE ###############################",
    "",
    `appendonly ${c.appendonly ? "yes" : "no"}`,
    `appendfilename ${JSON.stringify(c.appendfilename || "appendonly.aof")}`,
    `appendfsync ${c.appendfsync}`,
    "",
    "############################## REDIS DESKTOP ##################################",
    "",
    `# Seed sample keys on first start (Redis Desktop extension)`,
    `seed-demo ${c.seed_demo !== false ? "yes" : "no"}`,
    "",
  );

  return lines.join("\n") + "\n";
}

const DEFAULT_CONF_TEXT = serializeRedisConf(DEFAULTS);

/**
 * Load conf from disk, resolving includes. Returns { conf, text, path }.
 */
function loadRedisConfFile(filePath) {
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, "utf8");
  const conf = parseRedisConf(text);
  const includes = conf._includes || [];
  delete conf._includes;
  for (const inc of includes) {
    if (!inc) continue;
    const incPath = path.isAbsolute(inc) ? inc : path.join(path.dirname(abs), inc);
    if (fs.existsSync(incPath)) {
      const nested = loadRedisConfFile(incPath);
      Object.assign(conf, nested.conf, {
        // preserve multi-value merge for save
        save: [...(conf.save || []), ...(nested.conf.save || [])],
        rename_command: { ...(conf.rename_command || {}), ...(nested.conf.rename_command || {}) },
      });
    }
  }
  return { conf, text, path: abs };
}

/**
 * Ensure user conf exists under userDataDir; copy defaults if missing.
 */
function ensureUserRedisConf(userDataDir, bundledDefaultPath) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const confPath = path.join(userDataDir, "redis.conf");
  const dataDir = path.join(userDataDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(confPath)) {
    let text = DEFAULT_CONF_TEXT;
    if (bundledDefaultPath && fs.existsSync(bundledDefaultPath)) {
      text = fs.readFileSync(bundledDefaultPath, "utf8");
    }
    // Force dir to user data
    const conf = parseRedisConf(text);
    conf.dir = dataDir;
    conf.bind = conf.bind || "127.0.0.1";
    fs.writeFileSync(confPath, serializeRedisConf(conf), "utf8");
  }

  return confPath;
}

function confToConfigGetPairs(conf) {
  const pairs = [];
  const put = (k, v) => {
    pairs.push(k, v == null ? "" : String(v));
  };
  put("bind", conf.bind);
  put("port", conf.port);
  put("timeout", conf.timeout);
  put("tcp-backlog", conf.tcp_backlog);
  put("tcp-keepalive", conf.tcp_keepalive);
  put("protected-mode", conf.protected_mode ? "yes" : "no");
  put("databases", conf.databases);
  put("requirepass", conf.requirepass || "");
  put("maxmemory", formatMemory(conf.maxmemory || 0));
  put("maxmemory-policy", conf.maxmemory_policy);
  put("maxclients", conf.maxclients);
  put("dir", conf.dir);
  put("dbfilename", conf.dbfilename);
  put("appendonly", conf.appendonly ? "yes" : "no");
  put("appendfilename", conf.appendfilename);
  put("appendfsync", conf.appendfsync);
  put("loglevel", conf.loglevel);
  put("logfile", conf.logfile || "");
  put("daemonize", conf.daemonize ? "yes" : "no");
  put("rdbcompression", conf.rdbcompression ? "yes" : "no");
  put("rdbchecksum", conf.rdbchecksum ? "yes" : "no");
  put("stop-writes-on-bgsave-error", conf.stop_writes_on_bgsave_error ? "yes" : "no");
  put("seed-demo", conf.seed_demo !== false ? "yes" : "no");
  if (Array.isArray(conf.save)) {
    put("save", conf.save.map(([s, c]) => `${s} ${c}`).join(" "));
  }
  return pairs;
}

module.exports = {
  DEFAULTS,
  DEFAULT_CONF_TEXT,
  parseRedisConf,
  serializeRedisConf,
  loadRedisConfFile,
  ensureUserRedisConf,
  confToConfigGetPairs,
  parseMemory,
  formatMemory,
};
