/**
 * Minimal Redis RESP client over Node net (Electron main process).
 * No external dependencies — safe to ship in the portable asar.
 */
const net = require("net");

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    let buf;
    if (Buffer.isBuffer(a)) buf = a;
    else if (a && a.__redisBinaryBase64) buf = Buffer.from(a.__redisBinaryBase64, "base64");
    else buf = Buffer.from(String(a ?? ""), "utf8");
    parts.push(`$${buf.length}\r\n`);
    parts.push(buf);
    parts.push("\r\n");
  }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))));
}

/**
 * Parse one RESP value from buffer. Returns [value, bytesConsumed] or null if incomplete.
 */
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
    const slice = buf.subarray(start, end);
    // Preserve binary (e.g. Java serialization). Mark with a private brand when not UTF-8 text.
    const asUtf8 = slice.toString("utf8");
    const isUtf8 =
      Buffer.from(asUtf8, "utf8").equals(slice) &&
      !slice.includes(0); // no NULs in text
    if (isUtf8) return [asUtf8, end + 2];
    // Binary payload — return Buffer so callers can handle
    return [slice, end + 2];
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
  // Fallback: treat as error
  return [new Error(`Unknown RESP type ${type}`), nl + 2];
}

function formatReply(value) {
  if (value instanceof Error) return `(error) ${value.message}`;
  if (value === null || value === undefined) return "(nil)";
  if (typeof value === "number") return `(integer) ${value}`;
  if (Buffer.isBuffer(value)) {
    return `"${value.toString("utf8")}"`;
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return value
        .split("\n")
        .map((l, i) => (i === 0 ? l : l))
        .join("\n");
    }
    return value.includes(" ") || value === "" ? `"${value}"` : value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return "(empty array)";
    return value
      .map((v, i) => {
        if (v === null) return `${i + 1}) (nil)`;
        if (typeof v === "string") return `${i + 1}) "${v}"`;
        if (typeof v === "number") return `${i + 1}) (integer) ${v}`;
        if (Array.isArray(v)) return `${i + 1}) ${formatReply(v)}`;
        return `${i + 1}) ${String(v)}`;
      })
      .join("\n");
  }
  return String(value);
}

class RedisClient {
  constructor() {
    /** @type {net.Socket | null} */
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    /** @type {Array<{resolve: Function, reject: Function}>} */
    this.pending = [];
    this.connected = false;
    this.db = 0;
    this.host = "";
    this.port = 6379;
  }

  connect({ host, port, username, password, db = 0, connectTimeout = 8000 }) {
    return new Promise((resolve, reject) => {
      this.disconnect();
      this.host = host;
      this.port = port;
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.disconnect();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(() => fail(new Error(`Connection timeout to ${host}:${port}`)), connectTimeout);

      socket.setNoDelay(true);
      socket.on("error", fail);
      socket.on("close", () => {
        this.connected = false;
        const err = new Error("Connection closed");
        while (this.pending.length) {
          this.pending.shift().reject(err);
        }
      });
      socket.on("data", (chunk) => this._onData(chunk));

      socket.on("connect", async () => {
        try {
          // AUTH
          if (password) {
            if (username) {
              await this.call("AUTH", username, password);
            } else {
              await this.call("AUTH", password);
            }
          }
          if (db && db !== 0) {
            await this.call("SELECT", String(db));
            this.db = db;
          }
          // Verify
          const pong = await this.call("PING");
          if (String(pong).toUpperCase() !== "PONG" && pong !== "PONG") {
            // some servers return PONG as simple string already handled
          }
          this.connected = true;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({ host, port, db: this.db });
          }
        } catch (e) {
          clearTimeout(timer);
          fail(e);
        }
      });
    });
  }

  disconnect() {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    const err = new Error("Disconnected");
    while (this.pending.length) this.pending.shift().reject(err);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.pending.length) {
      const parsed = parseResp(this.buffer, 0);
      if (!parsed) break;
      const [value, consumed] = parsed;
      this.buffer = this.buffer.subarray(consumed);
      const job = this.pending.shift();
      if (value instanceof Error) job.reject(value);
      else job.resolve(value);
    }
  }

  call(...args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("Not connected"));
        return;
      }
      const job = { resolve, reject };
      this.pending.push(job);
      try {
        this.socket.write(encodeCommand(args), (err) => {
          if (err) {
            const idx = this.pending.indexOf(job);
            if (idx >= 0) this.pending.splice(idx, 1);
            reject(err);
          }
        });
      } catch (e) {
        const idx = this.pending.indexOf(job);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(e);
      }
    });
  }

  async execLine(line) {
    const args = parseArgs(line);
    if (!args.length) return "";
    try {
      const cmd = args[0].toUpperCase();
      const result = await this.call(...args);
      if (cmd === "SELECT" && args[1] !== undefined) {
        const n = Number(args[1]);
        if (Number.isInteger(n)) this.db = n;
      }
      // INFO returns bulk string — keep raw
      if (cmd === "INFO" && typeof result === "string") return result;
      return formatReply(result);
    } catch (e) {
      return `(error) ${e.message || e}`;
    }
  }

  async listKeys(pattern = "*") {
    // Prefer SCAN for production safety; fall back to KEYS
    const keys = [];
    try {
      let cursor = "0";
      do {
        const reply = await this.call("SCAN", cursor, "MATCH", pattern, "COUNT", "200");
        if (!Array.isArray(reply) || reply.length < 2) break;
        cursor = String(reply[0]);
        const batch = reply[1];
        if (Array.isArray(batch)) keys.push(...batch.map(String));
      } while (cursor !== "0" && keys.length < 5000);
    } catch {
      const all = await this.call("KEYS", pattern);
      if (Array.isArray(all)) keys.push(...all.map(String));
    }
    keys.sort();
    const metas = [];
    // Pipeline-ish sequential TYPE+TTL (keep simple)
    for (const key of keys.slice(0, 2000)) {
      try {
        const [type, ttl] = await Promise.all([
          this.call("TYPE", key),
          this.call("TTL", key),
        ]);
        let size = 0;
        const t = String(type);
        try {
          if (t === "string") {
            const n = await this.call("STRLEN", key);
            size = Number(n) || 0;
          } else if (t === "hash") {
            size = Number(await this.call("HLEN", key)) || 0;
          } else if (t === "list") {
            size = Number(await this.call("LLEN", key)) || 0;
          } else if (t === "set") {
            size = Number(await this.call("SCARD", key)) || 0;
          } else if (t === "zset") {
            size = Number(await this.call("ZCARD", key)) || 0;
          }
        } catch {
          size = 0;
        }
        const redisType =
          t === "string" || t === "hash" || t === "list" || t === "set" || t === "zset"
            ? t
            : "string";
        metas.push({
          key,
          type: redisType,
          ttl: typeof ttl === "number" ? ttl : Number(ttl) || -1,
          size,
          encoding: t,
        });
      } catch {
        /* skip bad key */
      }
    }
    return metas;
  }

  async getEntry(key) {
    const type = String(await this.call("TYPE", key));
    if (type === "none") return null;
    const ttlRaw = await this.call("TTL", key);
    const ttl = typeof ttlRaw === "number" ? ttlRaw : Number(ttlRaw) || -1;

    if (type === "string") {
      const value = await this.call("GET", key);
      if (value == null) return { type: "string", value: "", ttl, encoding: "raw" };
      if (Buffer.isBuffer(value)) {
        const b64 = value.toString("base64");
        const isJava =
          value.length >= 2 && value[0] === 0xac && value[1] === 0xed; // Java stream magic
        return {
          type: "string",
          value: isJava
            ? `[Java serialized binary — ${value.length} bytes]\n(base64)\n${b64}`
            : `[Binary — ${value.length} bytes]\n(base64)\n${b64}`,
          ttl,
          encoding: isJava ? "java-serialized" : "binary",
          binaryBase64: b64,
          readOnly: true,
        };
      }
      const s = String(value);
      let encoding = "raw";
      if (s.length >= 2 && s.charCodeAt(0) === 0xac && s.charCodeAt(1) === 0xed) {
        // mis-decoded java ser as latin1-ish
        encoding = "java-serialized";
      } else if (s.trimStart().startsWith("{") || s.trimStart().startsWith("[")) {
        encoding = "json";
      }
      return { type: "string", value: s, ttl, encoding, readOnly: encoding === "java-serialized" };
    }
    if (type === "hash") {
      const flat = await this.call("HGETALL", key);
      const obj = {};
      if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
          obj[String(flat[i])] = String(flat[i + 1] ?? "");
        }
      }
      return { type: "hash", value: obj, ttl };
    }
    if (type === "list") {
      const arr = await this.call("LRANGE", key, "0", "-1");
      return {
        type: "list",
        value: Array.isArray(arr) ? arr.map(String) : [],
        ttl,
      };
    }
    if (type === "set") {
      const arr = await this.call("SMEMBERS", key);
      return {
        type: "set",
        value: Array.isArray(arr) ? arr.map(String) : [],
        ttl,
      };
    }
    if (type === "zset") {
      const arr = await this.call("ZRANGE", key, "0", "-1", "WITHSCORES");
      const value = [];
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i += 2) {
          value.push({ member: String(arr[i]), score: Number(arr[i + 1]) || 0 });
        }
      }
      return { type: "zset", value, ttl };
    }
    return null;
  }

  async setString(key, value, ttl) {
    let payload = value;
    // Restore binary from base64 marker objects or prefixes
    if (value && typeof value === "object" && value.binaryBase64) {
      payload = Buffer.from(value.binaryBase64, "base64");
    } else if (typeof value === "string" && value.includes("(base64)\n")) {
      const idx = value.indexOf("(base64)\n");
      payload = Buffer.from(value.slice(idx + "(base64)\n".length).trim(), "base64");
    }
    if (ttl && ttl > 0) await this.call("SET", key, payload, "EX", String(ttl));
    else await this.call("SET", key, payload);
  }

  async setHash(key, fields, ttl) {
    await this.call("DEL", key);
    const args = ["HSET", key];
    for (const [k, v] of Object.entries(fields)) {
      args.push(k, v);
    }
    if (args.length > 2) await this.call(...args);
    else await this.call("HSET", key, "_", "");
    if (ttl && ttl > 0) await this.call("EXPIRE", key, String(ttl));
  }

  async setList(key, values, ttl) {
    await this.call("DEL", key);
    if (values.length) await this.call("RPUSH", key, ...values);
    else await this.call("LPUSH", key, "");
    if (ttl && ttl > 0) await this.call("EXPIRE", key, String(ttl));
  }

  async setSet(key, members, ttl) {
    await this.call("DEL", key);
    if (members.length) await this.call("SADD", key, ...members);
    else await this.call("SADD", key, "");
    if (ttl && ttl > 0) await this.call("EXPIRE", key, String(ttl));
  }

  async setZSet(key, members, ttl) {
    await this.call("DEL", key);
    if (members.length) {
      const args = ["ZADD", key];
      for (const m of members) {
        args.push(String(m.score), m.member);
      }
      await this.call(...args);
    } else {
      await this.call("ZADD", key, "0", "");
    }
    if (ttl && ttl > 0) await this.call("EXPIRE", key, String(ttl));
  }

  async del(...keys) {
    if (!keys.length) return 0;
    const n = await this.call("DEL", ...keys);
    return Number(n) || 0;
  }

  async expire(key, seconds) {
    const n = await this.call("EXPIRE", key, String(seconds));
    return Number(n) === 1;
  }

  async persist(key) {
    const n = await this.call("PERSIST", key);
    return Number(n) === 1;
  }

  async rename(oldKey, newKey) {
    try {
      await this.call("RENAME", oldKey, newKey);
      return true;
    } catch {
      return false;
    }
  }

  async select(db) {
    await this.call("SELECT", String(db));
    this.db = db;
  }

  get currentDb() {
    return this.db;
  }
}

function parseArgs(input) {
  const args = [];
  let cur = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length) {
        args.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length) args.push(cur);
  return args;
}

module.exports = { RedisClient, formatReply, parseArgs };
