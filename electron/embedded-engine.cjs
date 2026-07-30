/**
 * In-process Redis-compatible data store for the embedded server.
 * Returns native JS values for RESP encoding (not CLI-formatted strings).
 */

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
  constructor() {
    this.dbs = new Map();
    this.dbIndex = 0;
    for (let i = 0; i < 16; i++) this.dbs.set(i, new Map());
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
    if (db < 0 || db > 15) throw new Error("DB index is out of range");
    this.dbIndex = db;
  }

  dbsize() {
    let n = 0;
    for (const key of [...this.store().keys()]) if (this.purge(key)) n++;
    return n;
  }

  setString(key, value, ttl) {
    this.store().set(key, {
      data: { type: "string", value: String(value) },
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
        return e.data.value;
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
          flat.push(k, v);
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
          if (!(a[i] in e.data.value)) added++;
          e.data.value[a[i]] = String(a[i + 1]);
        }
        return added;
      }
      case "HGET": {
        const e = this.purge(a[0] ?? "");
        if (!e) return null;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        const v = e.data.value[a[1] ?? ""];
        return v === undefined ? null : v;
      }
      case "HLEN": {
        const e = this.purge(a[0] ?? "");
        if (!e) return 0;
        if (e.data.type !== "hash") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
        return Object.keys(e.data.value).length;
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
        return [...e.data.value];
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
        const set = new Set(e.data.value);
        let added = 0;
        for (const m of a.slice(1)) {
          if (!set.has(String(m))) {
            set.add(String(m));
            added++;
          }
        }
        e.data.value = [...set];
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
