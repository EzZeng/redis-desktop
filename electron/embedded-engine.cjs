/**
 * In-process Redis-compatible data store for the embedded server.
 * Returns native JS values for RESP encoding (not CLI-formatted strings).
 */

function encodeStored(v) {
  if (Buffer.isBuffer(v)) return { __bin: true, b64: v.toString("base64") };
  if (v && typeof v === "object" && v.__bin && v.b64) return v;
  return String(v ?? "");
}

function decodeStored(v) {
  if (v && typeof v === "object" && v.__bin && v.b64) return Buffer.from(v.b64, "base64");
  return v == null ? "" : v;
}

function storedEqual(a, b) {
  const da = decodeStored(a);
  const db = decodeStored(b);
  if (Buffer.isBuffer(da) && Buffer.isBuffer(db)) return da.equals(db);
  if (Buffer.isBuffer(da) || Buffer.isBuffer(db)) return false;
  return String(da) === String(db);
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
  return new RegExp(out + "$");
}

class EmbeddedEngine {
  constructor(databases = 16) {
    this.dbs = new Map();
    this.dbIndex = 0;
    this.databaseCount = Math.min(64, Math.max(1, Number(databases) || 16));
    for (let i = 0; i < this.databaseCount; i++) this.dbs.set(i, new Map());
  }

  exportAll() {
    const out = {};
    for (const [db, store] of this.dbs.entries()) {
      const keys = {};
      for (const [key, entry] of store.entries()) {
        // skip expired
        if (entry.expireAt !== null && Date.now() >= entry.expireAt) continue;
        keys[key] = {
          data: entry.data,
          expireAt: entry.expireAt,
        };
      }
      if (Object.keys(keys).length) out[String(db)] = keys;
    }
    return out;
  }

  importAll(databases) {
    for (const db of this.dbs.values()) db.clear();
    if (!databases || typeof databases !== "object") return;
    for (const [dbStr, keys] of Object.entries(databases)) {
      const db = Number(dbStr);
      if (!this.dbs.has(db)) this.dbs.set(db, new Map());
      const store = this.dbs.get(db);
      for (const [key, entry] of Object.entries(keys || {})) {
        store.set(key, {
          data: entry.data,
          expireAt: entry.expireAt ?? null,
        });
      }
    }
  }

  store() {
    return this.dbs.get(this.dbIndex);
  }

  purge(key) {
    const store = this.store();
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && Date.now() >= entry.expireAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  ttlSeconds(entry) {
    if (entry.expireAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expireAt - Date.now()) / 1000));
  }

  select(db) {
    if (db < 0 || db >= this.databaseCount) throw new Error("DB index is out of range");
    this.dbIndex = db;
  }

  dbsize() {
    let n = 0;
    for (const key of [...this.store().keys()]) if (this.purge(key)) n++;
    return n;
  }

  setString(key, value, ttl) {
    this.store().set(key, {
      data: { type: "string", value: encodeStored(value) },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setHash(key, fields, ttl) {
    this.store().set(key, {
      data: { type: "hash", value: { ...fields } },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setList(key, values, ttl) {
    this.store().set(key, {
      data: { type: "list", value: [...values] },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setSet(key, members, ttl) {
    this.store().set(key, {
      data: { type: "set", value: [...new Set(members)] },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setZSet(key, members, ttl) {
    const map = new Map();
    for (const m of members) map.set(m.member, m.score);
    const value = [...map.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    this.store().set(key, {
      data: { type: "zset", value },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  del(...keys) {
    let n = 0;
    for (const k of keys) if (this.store().delete(k)) n++;
    return n;
  }

  /** @returns {any} native value for RESP encode; throw Error for -ERR */
  dispatch(args) {
    if (!args.length) return null;
    const cmd = String(args[0]).toUpperCase();
    const a = args.slice(1);

    switch (cmd) {
      case "PING":
        return a[0] !== undefined ? String(a[0]) : "PONG";
      case "ECHO":
        if (a[0] === undefined) throw new Error("ERR wrong number of arguments for 'echo' command");
        return String(a[0]);
      case "SELECT": {
        const db = Number(a[0]);
        if (!Number.isInteger(db)) throw new Error("ERR invalid DB index");
        this.select(db);
        return "OK";
      }
      case "DBSIZE":
        return this.dbsize();
      case "KEYS": {
        const re = globToRegExp(a[0] ?? "*");
        const out = [];
        for (const key of [...this.store().keys()].sort()) {
          if (this.purge(key) && re.test(key)) out.push(key);
        }
        return out;
      }
      case "SCAN": {
        // SCAN cursor [MATCH pattern] [COUNT count]
        let cursor = a[0] ?? "0";
        let pattern = "*";
        let count = 10;
        for (let i = 1; i < a.length; i++) {
          const f = String(a[i]).toUpperCase();
          if (f === "MATCH" && a[i + 1] !== undefined) {
            pattern = String(a[++i]);
          } else if (f === "COUNT" && a[i + 1] !== undefined) {
            count = Number(a[++i]) || 10;
          }
        }
        const re = globToRegExp(pattern);
        const all = [];
        for (const key of [...this.store().keys()].sort()) {
          if (this.purge(key) && re.test(key)) all.push(key);
        }
        let start = Number(cursor) || 0;
        if (start < 0) start = 0;
        const slice = all.slice(start, start + count);
        const next = start + count >= all.length ? "0" : String(start + count);
        return [next, slice];
      }
      case "TYPE": {
        const e = this.purge(a[0] ?? "");
        return e ? e.data.type : "none";
      }
      case "TTL": {
        const e = this.purge(a[0] ?? "");
        if (!e) return -2;
        return this.ttlSeconds(e);
      }
      case "PTTL": {
        const e = this.purge(a[0] ?? "");
        if (!e) return -2;
        if (e.expireAt === null) return -1;
        return Math.max(0, e.expireAt - Date.now());
      }
      case "EXISTS": {
        let n = 0;
        for (const k of a) if (this.purge(k)) n++;
        return n;
      }
      case "GET": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return decodeStored(e.data.value);
      }
      case "SET": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'set' command");
        let ttl;
        for (let i = 2; i < a.length; i++) {
          const f = String(a[i]).toUpperCase();
          if (f === "EX" && a[i + 1] !== undefined) {
            ttl = Number(a[++i]);
          } else if (f === "PX" && a[i + 1] !== undefined) {
            ttl = Number(a[++i]) / 1000;
          }
        }
        this.setString(a[0], a[1], ttl);
        return "OK";
      }
      case "STRLEN": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Buffer.byteLength(e.data.value, "utf8");
      }
      case "DEL":
        if (!a.length) throw new Error("ERR wrong number of arguments for 'del' command");
        return this.del(...a);
      case "EXPIRE": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        const sec = Number(a[1]);
        if (!Number.isFinite(sec)) throw new Error("ERR value is not an integer or out of range");
        e.expireAt = sec < 0 ? null : Date.now() + sec * 1000;
        return 1;
      }
      case "PERSIST": {
        const e = this.purge(a[0] ?? "");
        if (!e || e.expireAt === null) return 0;
        e.expireAt = null;
        return 1;
      }
      case "RENAME": {
        const e = this.purge(a[0] ?? "");
        if (!e) throw new Error("ERR no such key");
        this.store().delete(a[0]);
        this.store().set(a[1], e);
        return "OK";
      }
      case "FLUSHDB":
        this.store().clear();
        return "OK";
      case "FLUSHALL":
        for (const db of this.dbs.values()) db.clear();
        return "OK";
      case "HGETALL": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const flat = [];
        for (const [k, v] of Object.entries(e.data.value)) {
          flat.push(k, decodeStored(v));
        }
        return flat;
      }
      case "HSET": {
        if (a.length < 3 || (a.length - 1) % 2 !== 0)
          throw new Error("ERR wrong number of arguments for 'hset' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "hash", value: {} }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          const field = String(a[i]);
          if (!(field in e.data.value)) added++;
          e.data.value[field] = encodeStored(a[i + 1]);
        }
        return added;
      }
      case "HGET": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const v = e.data.value[a[1] ?? ""];
        return v === undefined ? null : decodeStored(v);
      }
      case "HLEN": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Object.keys(e.data.value).length;
      }
      case "HMSET": {
        // Deprecated alias of HSET with multiple fields — still used by Jedis and others
        if (a.length < 3 || (a.length - 1) % 2 !== 0)
          throw new Error("ERR wrong number of arguments for 'hmset' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "hash", value: {} }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        for (let i = 1; i < a.length; i += 2) {
          e.data.value[String(a[i])] = encodeStored(a[i + 1]);
        }
        return "OK";
      }
      case "HMGET": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'hmget' command");
        const e = this.purge(a[0] ?? "");
        if (e && e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const fields = a.slice(1);
        return fields.map((f) => {
          if (!e) return null;
          const v = e.data.value[String(f)];
          return v === undefined ? null : v;
        });
      }
      case "HDEL": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'hdel' command");
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let n = 0;
        for (const f of a.slice(1)) {
          if (Object.prototype.hasOwnProperty.call(e.data.value, String(f))) {
            delete e.data.value[String(f)];
            n++;
          }
        }
        if (Object.keys(e.data.value).length === 0) this.store().delete(a[0]);
        return n;
      }
      case "HEXISTS": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Object.prototype.hasOwnProperty.call(e.data.value, String(a[1] ?? "")) ? 1 : 0;
      }
      case "HKEYS": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Object.keys(e.data.value);
      }
      case "HVALS": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Object.values(e.data.value).map(decodeStored);
      }
      case "HINCRBY": {
        if (a.length < 3) throw new Error("ERR wrong number of arguments for 'hincrby' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "hash", value: {} }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const field = String(a[1]);
        const inc = Number(a[2]);
        if (!Number.isFinite(inc)) throw new Error("ERR value is not an integer or out of range");
        const cur = e.data.value[field];
        const base = cur === undefined || cur === "" ? 0 : Number(cur);
        if (!Number.isFinite(base)) throw new Error("ERR hash value is not an integer");
        const next = Math.trunc(base + inc);
        e.data.value[field] = String(next);
        return next;
      }
      case "MGET": {
        if (!a.length) throw new Error("ERR wrong number of arguments for 'mget' command");
        return a.map((k) => {
          const e = this.purge(k);
          if (!e || e.data.type !== "string") return null;
          return e.data.value;
        });
      }
      case "MSET": {
        if (a.length < 2 || a.length % 2 !== 0)
          throw new Error("ERR wrong number of arguments for 'mset' command");
        for (let i = 0; i < a.length; i += 2) {
          this.setString(a[i], a[i + 1]);
        }
        return "OK";
      }
      case "GETSET": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'getset' command");
        const e = this.purge(a[0]);
        let prev = null;
        if (e) {
          if (e.data.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
          prev = e.data.value;
        }
        this.setString(a[0], a[1]);
        return prev;
      }
      case "SETEX": {
        if (a.length < 3) throw new Error("ERR wrong number of arguments for 'setex' command");
        const sec = Number(a[1]);
        if (!Number.isFinite(sec)) throw new Error("ERR value is not an integer or out of range");
        this.setString(a[0], a[2], sec);
        return "OK";
      }
      case "SETNX": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'setnx' command");
        if (this.purge(a[0])) return 0;
        this.setString(a[0], a[1]);
        return 1;
      }
      case "INCR":
      case "INCRBY":
      case "DECR":
      case "DECRBY": {
        const key = a[0] ?? "";
        let delta = 1;
        if (cmd === "INCRBY") {
          delta = Number(a[1]);
          if (!Number.isFinite(delta)) throw new Error("ERR value is not an integer or out of range");
        } else if (cmd === "DECR") {
          delta = -1;
        } else if (cmd === "DECRBY") {
          delta = -Number(a[1]);
          if (!Number.isFinite(delta)) throw new Error("ERR value is not an integer or out of range");
        }
        let e = this.purge(key);
        let base = 0;
        if (e) {
          if (e.data.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
          base = e.data.value === "" ? 0 : Number(e.data.value);
          if (!Number.isFinite(base)) throw new Error("ERR value is not an integer or out of range");
        }
        const next = Math.trunc(base + delta);
        this.setString(key, String(next), e && e.expireAt ? Math.max(0, Math.ceil((e.expireAt - Date.now()) / 1000)) : undefined);
        // preserve TTL if any
        if (e && e.expireAt) {
          const ent = this.purge(key);
          if (ent) ent.expireAt = e.expireAt;
        }
        return next;
      }
      case "APPEND": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'append' command");
        const e = this.purge(a[0]);
        if (e && e.data.type !== "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const next = (e ? e.data.value : "") + String(a[1]);
        const ttl = e && e.expireAt ? Math.max(0, Math.ceil((e.expireAt - Date.now()) / 1000)) : undefined;
        this.setString(a[0], next, ttl);
        if (e && e.expireAt) {
          const ent = this.purge(a[0]);
          if (ent) ent.expireAt = e.expireAt;
        }
        return Buffer.byteLength(next, "utf8");
      }
      case "LPOP":
      case "RPOP": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const v = cmd === "LPOP" ? e.data.value.shift() : e.data.value.pop();
        if (!e.data.value.length) this.store().delete(a[0]);
        return v === undefined ? null : v;
      }
      case "LINDEX": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let idx = Number(a[1]);
        if (!Number.isFinite(idx)) throw new Error("ERR value is not an integer or out of range");
        if (idx < 0) idx = e.data.value.length + idx;
        return e.data.value[idx] === undefined ? null : e.data.value[idx];
      }
      case "SREM": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'srem' command");
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let n = 0;
        const next = [];
        for (const x of e.data.value) {
          const remove = a.slice(1).some((m) => storedEqual(x, m));
          if (remove) n++;
          else next.push(x);
        }
        e.data.value = next;
        if (!e.data.value.length) this.store().delete(a[0]);
        return n;
      }
      case "SISMEMBER": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return e.data.value.some((x) => storedEqual(x, a[1] ?? "")) ? 1 : 0;
      }
      case "ZREM": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'zrem' command");
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const remove = new Set(a.slice(1).map(String));
        const before = e.data.value.length;
        e.data.value = e.data.value.filter((z) => !remove.has(z.member));
        if (!e.data.value.length) this.store().delete(a[0]);
        return before - e.data.value.length;
      }
      case "ZSCORE": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const z = e.data.value.find((x) => x.member === String(a[1] ?? ""));
        return z ? String(z.score) : null;
      }
      case "LRANGE": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let start = Number(a[1] ?? 0);
        let stop = Number(a[2] ?? -1);
        const len = e.data.value.length;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        return e.data.value.slice(start, stop + 1);
      }
      case "LLEN": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return e.data.value.length;
      }
      case "LPUSH": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'lpush' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "list", value: [] }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        e.data.value.unshift(...a.slice(1).reverse().map(String));
        return e.data.value.length;
      }
      case "RPUSH": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'rpush' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "list", value: [] }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "list") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        e.data.value.push(...a.slice(1).map(String));
        return e.data.value.length;
      }
      case "SMEMBERS": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return e.data.value.map(decodeStored);
      }
      case "SCARD": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return e.data.value.length;
      }
      case "SADD": {
        if (a.length < 2) throw new Error("ERR wrong number of arguments for 'sadd' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "set", value: [] }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "set") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let added = 0;
        for (const m of a.slice(1)) {
          const exists = e.data.value.some((x) => storedEqual(x, m));
          if (!exists) {
            e.data.value.push(encodeStored(m));
            added++;
          }
        }
        return added;
      }
      case "ZRANGE": {
        const e = this.purge(a[0] ?? "");
        if (!e) return [];
        if (e.data.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        let start = Number(a[1] ?? 0);
        let stop = Number(a[2] ?? -1);
        const withScores = a.some((x) => String(x).toUpperCase() === "WITHSCORES");
        const len = e.data.value.length;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        const slice = e.data.value.slice(start, stop + 1);
        if (!withScores) return slice.map((z) => z.member);
        const flat = [];
        for (const z of slice) {
          flat.push(z.member, String(z.score));
        }
        return flat;
      }
      case "ZCARD": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return e.data.value.length;
      }
      case "ZADD": {
        if (a.length < 3 || (a.length - 1) % 2 !== 0)
          throw new Error("ERR wrong number of arguments for 'zadd' command");
        let e = this.purge(a[0]);
        if (!e) {
          e = { data: { type: "zset", value: [] }, expireAt: null };
          this.store().set(a[0], e);
        }
        if (e.data.type !== "zset") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const map = new Map(e.data.value.map((z) => [z.member, z.score]));
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          const score = Number(a[i]);
          const member = String(a[i + 1]);
          if (!map.has(member)) added++;
          map.set(member, score);
        }
        e.data.value = [...map.entries()]
          .map(([member, score]) => ({ member, score }))
          .sort((x, y) => x.score - y.score || x.member.localeCompare(y.member));
        return added;
      }
      case "INFO": {
        const lines = [
          "# Server",
          "redis_version:7.2.0-embedded",
          "redis_mode:standalone",
          "os:Redis-Desktop-Embedded",
          "arch_bits:64",
          "tcp_port:6379",
          "executable:redis-desktop-embedded",
          "",
          "# Clients",
          "connected_clients:1",
          "",
          "# Memory",
          "used_memory_human:embedded",
          "",
          "# Keyspace",
        ];
        for (let i = 0; i < 16; i++) {
          const prev = this.dbIndex;
          this.dbIndex = i;
          const n = this.dbsize();
          this.dbIndex = prev;
          if (n > 0) lines.push(`db${i}:keys=${n},expires=0,avg_ttl=0`);
        }
        return lines.join("\r\n") + "\r\n";
      }
      case "COMMAND":
        return [];
      case "CLIENT":
        if (String(a[0] || "").toUpperCase() === "SETNAME") return "OK";
        return "OK";
      case "HELLO":
        return ["server", "redis", "version", "7.2.0-embedded", "proto", 2, "mode", "standalone", "role", "master"];
      case "AUTH":
        // Accept any password for embedded (optional lock later)
        return "OK";
      case "QUIT":
        return "OK";
      case "CONFIG":
        if (String(a[0] || "").toUpperCase() === "GET") return [];
        return "OK";
      case "PUBLISH":
        // Pub/Sub is handled by the TCP server layer; engine no-op returns 0
        return 0;
      case "SUBSCRIBE":
      case "PSUBSCRIBE":
      case "UNSUBSCRIBE":
      case "PUNSUBSCRIBE":
      case "PUBSUB":
        return "OK";
      default:
        throw new Error(`ERR unknown command '${cmd.toLowerCase()}'`);
    }
  }

  seedDemo() {
    this.select(0);
    this.store().clear();
    this.setString("app:version", "1.4.2");
    this.setString("app:env", "production");
    this.setString(
      "session:u_8f2a1c",
      JSON.stringify({ userId: "u_8f2a1c", role: "admin" }),
      3600,
    );
    this.setHash("user:1001", {
      id: "1001",
      email: "ada@lovelace.dev",
      name: "Ada Lovelace",
      plan: "pro",
    });
    this.setHash("user:1002", {
      id: "1002",
      email: "grace@hopper.io",
      name: "Grace Hopper",
      plan: "team",
    });
    this.setHash("config:feature_flags", {
      dark_mode: "true",
      new_billing: "false",
      beta_search: "true",
    });
    this.setList("queue:emails", [
      '{"to":"user@ex.com","template":"welcome"}',
      '{"to":"ops@ex.com","template":"alert"}',
    ]);
    this.setList("recent:logins", [
      "2026-07-30T08:12:00Z ada@lovelace.dev",
      "2026-07-30T07:55:00Z grace@hopper.io",
    ]);
    this.setSet("tags:post:42", ["redis", "performance", "caching", "infra"]);
    this.setSet("online:users", ["u_8f2a1c", "u_3b91de", "u_aa0012"]);
    this.setZSet("leaderboard:weekly", [
      { member: "ada", score: 9820 },
      { member: "grace", score: 9104 },
      { member: "alan", score: 8740 },
    ]);
    this.setZSet("trending:topics", [
      { member: "redis-streams", score: 412 },
      { member: "vector-search", score: 388 },
    ]);
  }
}

module.exports = { EmbeddedEngine };
