/** In-browser Redis-compatible engine for the desktop client demo. */

export type RedisType = "string" | "hash" | "list" | "set" | "zset";

export type RedisValue =
  | { type: "string"; value: string }
  | { type: "hash"; value: Record<string, string> }
  | { type: "list"; value: string[] }
  | { type: "set"; value: string[] }
  | { type: "zset"; value: Array<{ member: string; score: number }> };

export interface KeyMeta {
  key: string;
  type: RedisType;
  ttl: number; // seconds remaining, -1 = no expiry
  size: number;
  encoding: string;
}

interface Entry {
  data: RedisValue;
  expireAt: number | null; // epoch ms
}

function sizeOf(data: RedisValue): number {
  switch (data.type) {
    case "string":
      return data.value.length;
    case "hash":
      return Object.keys(data.value).length;
    case "list":
    case "set":
      return data.value.length;
    case "zset":
      return data.value.length;
  }
}

function encodingOf(type: RedisType): string {
  switch (type) {
    case "string":
      return "raw";
    case "hash":
      return "hashtable";
    case "list":
      return "quicklist";
    case "set":
      return "hashtable";
    case "zset":
      return "skiplist";
  }
}

function parseArgs(input: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
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

export class RedisEngine {
  private dbs = new Map<number, Map<string, Entry>>();
  private dbIndex = 0;

  constructor() {
    for (let i = 0; i < 16; i++) this.dbs.set(i, new Map());
  }

  get currentDb() {
    return this.dbIndex;
  }

  private store(): Map<string, Entry> {
    return this.dbs.get(this.dbIndex)!;
  }

  private purge(key: string): Entry | null {
    const store = this.store();
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && Date.now() >= entry.expireAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  private ttlSeconds(entry: Entry): number {
    if (entry.expireAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expireAt - Date.now()) / 1000));
  }

  select(db: number) {
    if (db < 0 || db > 15) throw new Error("DB index out of range");
    this.dbIndex = db;
  }

  dbsize(): number {
    const store = this.store();
    let n = 0;
    for (const key of [...store.keys()]) {
      if (this.purge(key)) n++;
    }
    return n;
  }

  keys(pattern = "*"): KeyMeta[] {
    const store = this.store();
    const re = globToRegExp(pattern);
    const out: KeyMeta[] = [];
    for (const key of [...store.keys()].sort()) {
      const entry = this.purge(key);
      if (!entry) continue;
      if (!re.test(key)) continue;
      out.push({
        key,
        type: entry.data.type,
        ttl: this.ttlSeconds(entry),
        size: sizeOf(entry.data),
        encoding: encodingOf(entry.data.type),
      });
    }
    return out;
  }

  getEntry(key: string): (RedisValue & { ttl: number }) | null {
    const entry = this.purge(key);
    if (!entry) return null;
    return { ...structuredClone(entry.data), ttl: this.ttlSeconds(entry) };
  }

  setString(key: string, value: string, ttl?: number) {
    this.store().set(key, {
      data: { type: "string", value },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setHash(key: string, fields: Record<string, string>, ttl?: number) {
    this.store().set(key, {
      data: { type: "hash", value: { ...fields } },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setList(key: string, values: string[], ttl?: number) {
    this.store().set(key, {
      data: { type: "list", value: [...values] },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setSet(key: string, members: string[], ttl?: number) {
    this.store().set(key, {
      data: { type: "set", value: [...new Set(members)] },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  setZSet(key: string, members: Array<{ member: string; score: number }>, ttl?: number) {
    const map = new Map<string, number>();
    for (const m of members) map.set(m.member, m.score);
    const value = [...map.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    this.store().set(key, {
      data: { type: "zset", value },
      expireAt: ttl && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
  }

  del(...keys: string[]): number {
    let n = 0;
    const store = this.store();
    for (const k of keys) {
      if (store.delete(k)) n++;
    }
    return n;
  }

  expire(key: string, seconds: number): boolean {
    const entry = this.purge(key);
    if (!entry) return false;
    entry.expireAt = seconds < 0 ? null : Date.now() + seconds * 1000;
    return true;
  }

  persist(key: string): boolean {
    const entry = this.purge(key);
    if (!entry || entry.expireAt === null) return false;
    entry.expireAt = null;
    return true;
  }

  rename(oldKey: string, newKey: string): boolean {
    const entry = this.purge(oldKey);
    if (!entry) return false;
    this.store().delete(oldKey);
    this.store().set(newKey, entry);
    return true;
  }

  flushdb() {
    this.store().clear();
  }

  /** Execute a Redis-style CLI command. Returns reply string. */
  exec(line: string): string {
    const args = parseArgs(line.trim());
    if (!args.length) return "";
    const cmd = args[0]!.toUpperCase();
    try {
      switch (cmd) {
        case "PING":
          return args[1] ? `"${args[1]}"` : "PONG";
        case "ECHO":
          return args[1] !== undefined ? `"${args[1]}"` : "(error) ERR wrong number of arguments";
        case "SELECT": {
          const db = Number(args[1]);
          if (!Number.isInteger(db)) return "(error) ERR invalid DB index";
          this.select(db);
          return "OK";
        }
        case "DBSIZE":
          return `(integer) ${this.dbsize()}`;
        case "KEYS": {
          const pattern = args[1] ?? "*";
          const keys = this.keys(pattern).map((k) => k.key);
          if (!keys.length) return "(empty array)";
          return keys.map((k, i) => `${i + 1}) "${k}"`).join("\n");
        }
        case "TYPE": {
          const e = this.getEntry(args[1] ?? "");
          return e ? e.type : "none";
        }
        case "TTL": {
          const e = this.purge(args[1] ?? "");
          if (!e) return "(integer) -2";
          return `(integer) ${this.ttlSeconds(e)}`;
        }
        case "EXISTS": {
          let n = 0;
          for (const k of args.slice(1)) if (this.purge(k)) n++;
          return `(integer) ${n}`;
        }
        case "GET": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(nil)";
          if (e.type !== "string") return "(error) WRONGTYPE Operation against a key holding the wrong kind of value";
          return `"${e.value}"`;
        }
        case "SET": {
          if (args.length < 3) return "(error) ERR wrong number of arguments for 'set' command";
          let ttl: number | undefined;
          const rest = args.slice(3);
          for (let i = 0; i < rest.length; i++) {
            const flag = rest[i]!.toUpperCase();
            if (flag === "EX" && rest[i + 1]) {
              ttl = Number(rest[i + 1]);
              i++;
            }
          }
          this.setString(args[1]!, args[2]!, ttl);
          return "OK";
        }
        case "DEL": {
          if (args.length < 2) return "(error) ERR wrong number of arguments";
          return `(integer) ${this.del(...args.slice(1))}`;
        }
        case "EXPIRE": {
          const sec = Number(args[2]);
          if (!Number.isFinite(sec)) return "(error) ERR value is not an integer";
          return `(integer) ${this.expire(args[1]!, sec) ? 1 : 0}`;
        }
        case "PERSIST":
          return `(integer) ${this.persist(args[1]!) ? 1 : 0}`;
        case "RENAME":
          if (!this.rename(args[1]!, args[2]!)) return "(error) ERR no such key";
          return "OK";
        case "FLUSHDB":
          this.flushdb();
          return "OK";
        case "HGETALL": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(empty array)";
          if (e.type !== "hash") return "(error) WRONGTYPE";
          const entries = Object.entries(e.value);
          if (!entries.length) return "(empty array)";
          let i = 1;
          return entries
            .flatMap(([k, v]) => [`${i++}) "${k}"`, `${i++}) "${v}"`])
            .join("\n");
        }
        case "HSET": {
          if (args.length < 4 || (args.length - 2) % 2 !== 0)
            return "(error) ERR wrong number of arguments";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "hash", value: {} }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "hash") return "(error) WRONGTYPE";
          let added = 0;
          for (let i = 2; i < args.length; i += 2) {
            if (!(args[i]! in entry.data.value)) added++;
            entry.data.value[args[i]!] = args[i + 1]!;
          }
          return `(integer) ${added}`;
        }
        case "HMSET": {
          if (args.length < 4 || (args.length - 2) % 2 !== 0)
            return "(error) ERR wrong number of arguments for 'hmset' command";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "hash", value: {} }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "hash") return "(error) WRONGTYPE";
          for (let i = 2; i < args.length; i += 2) {
            entry.data.value[args[i]!] = args[i + 1]!;
          }
          return "OK";
        }
        case "HMGET": {
          if (args.length < 3) return "(error) ERR wrong number of arguments";
          const e = this.getEntry(args[1] ?? "");
          if (e && e.type !== "hash") return "(error) WRONGTYPE";
          const fields = args.slice(2);
          if (!fields.length) return "(empty array)";
          return fields
            .map((f, i) => {
              const v = e && e.type === "hash" ? e.value[f!] : undefined;
              return v === undefined ? `${i + 1}) (nil)` : `${i + 1}) "${v}"`;
            })
            .join("\n");
        }
        case "HGET": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(nil)";
          if (e.type !== "hash") return "(error) WRONGTYPE";
          const v = e.value[args[2] ?? ""];
          return v === undefined ? "(nil)" : `"${v}"`;
        }
        case "LRANGE": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(empty array)";
          if (e.type !== "list") return "(error) WRONGTYPE";
          let start = Number(args[2] ?? 0);
          let stop = Number(args[3] ?? -1);
          const len = e.value.length;
          if (start < 0) start = Math.max(0, len + start);
          if (stop < 0) stop = len + stop;
          const slice = e.value.slice(start, stop + 1);
          if (!slice.length) return "(empty array)";
          return slice.map((v, i) => `${i + 1}) "${v}"`).join("\n");
        }
        case "LPUSH": {
          if (args.length < 3) return "(error) ERR wrong number of arguments";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "list", value: [] }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "list") return "(error) WRONGTYPE";
          entry.data.value.unshift(...args.slice(2).reverse());
          return `(integer) ${entry.data.value.length}`;
        }
        case "RPUSH": {
          if (args.length < 3) return "(error) ERR wrong number of arguments";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "list", value: [] }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "list") return "(error) WRONGTYPE";
          entry.data.value.push(...args.slice(2));
          return `(integer) ${entry.data.value.length}`;
        }
        case "SMEMBERS": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(empty array)";
          if (e.type !== "set") return "(error) WRONGTYPE";
          if (!e.value.length) return "(empty array)";
          return e.value.map((v, i) => `${i + 1}) "${v}"`).join("\n");
        }
        case "SADD": {
          if (args.length < 3) return "(error) ERR wrong number of arguments";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "set", value: [] }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "set") return "(error) WRONGTYPE";
          let added = 0;
          const set = new Set(entry.data.value);
          for (const m of args.slice(2)) {
            if (!set.has(m)) {
              set.add(m);
              added++;
            }
          }
          entry.data.value = [...set];
          return `(integer) ${added}`;
        }
        case "ZRANGE": {
          const e = this.getEntry(args[1] ?? "");
          if (!e) return "(empty array)";
          if (e.type !== "zset") return "(error) WRONGTYPE";
          let start = Number(args[2] ?? 0);
          let stop = Number(args[3] ?? -1);
          const withScores = args.some((a) => a.toUpperCase() === "WITHSCORES");
          const len = e.value.length;
          if (start < 0) start = Math.max(0, len + start);
          if (stop < 0) stop = len + stop;
          const slice = e.value.slice(start, stop + 1);
          if (!slice.length) return "(empty array)";
          const lines: string[] = [];
          let i = 1;
          for (const item of slice) {
            lines.push(`${i++}) "${item.member}"`);
            if (withScores) lines.push(`${i++}) "${item.score}"`);
          }
          return lines.join("\n");
        }
        case "ZADD": {
          if (args.length < 4 || (args.length - 2) % 2 !== 0)
            return "(error) ERR wrong number of arguments";
          const key = args[1]!;
          let entry = this.purge(key);
          if (!entry) {
            entry = { data: { type: "zset", value: [] }, expireAt: null };
            this.store().set(key, entry);
          }
          if (entry.data.type !== "zset") return "(error) WRONGTYPE";
          const map = new Map(entry.data.value.map((z) => [z.member, z.score]));
          let added = 0;
          for (let i = 2; i < args.length; i += 2) {
            const score = Number(args[i]);
            const member = args[i + 1]!;
            if (!map.has(member)) added++;
            map.set(member, score);
          }
          entry.data.value = [...map.entries()]
            .map(([member, score]) => ({ member, score }))
            .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
          return `(integer) ${added}`;
        }
        case "INFO": {
          const sections = [
            "# Server",
            "redis_version:7.2.0-demo",
            "redis_mode:standalone",
            "os:Browser/Electron",
            "arch_bits:64",
            "process_id:1",
            "tcp_port:6379",
            "",
            "# Clients",
            "connected_clients:1",
            "",
            "# Keyspace",
            ...Array.from({ length: 16 }, (_, i) => {
              const prev = this.dbIndex;
              this.dbIndex = i;
              const n = this.dbsize();
              this.dbIndex = prev;
              return n > 0 ? `db${i}:keys=${n},expires=0,avg_ttl=0` : null;
            }).filter(Boolean),
          ];
          return sections.join("\n");
        }
        case "HELP":
          return [
            "Supported commands:",
            "  PING [message]  ECHO message  SELECT index  DBSIZE  INFO",
            "  KEYS pattern  TYPE key  TTL key  EXISTS key [key ...]",
            "  GET key  SET key value [EX seconds]  DEL key [key ...]",
            "  EXPIRE key seconds  PERSIST key  RENAME key newkey  FLUSHDB",
            "  HGETALL key  HSET key field value [field value ...]  HGET key field",
            "  LRANGE key start stop  LPUSH/RPUSH key element [element ...]",
            "  SMEMBERS key  SADD key member [member ...]",
            "  ZRANGE key start stop [WITHSCORES]  ZADD key score member [...]",
          ].join("\n");
        default:
          return `(error) ERR unknown command '${cmd.toLowerCase()}'`;
      }
    } catch (err) {
      return `(error) ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  seedDemo() {
    this.select(0);
    this.flushdb();
    this.setString("app:version", "1.4.2");
    this.setString("app:env", "production");
    this.setString("session:u_8f2a1c", JSON.stringify({ userId: "u_8f2a1c", role: "admin", exp: 1720000000 }), 3600);
    this.setString("cache:home:html", "<html><!-- compressed page cache --></html>", 120);
    this.setHash("user:1001", {
      id: "1001",
      email: "ada@lovelace.dev",
      name: "Ada Lovelace",
      plan: "pro",
      created_at: "2024-03-12T10:00:00Z",
    });
    this.setHash("user:1002", {
      id: "1002",
      email: "grace@hopper.io",
      name: "Grace Hopper",
      plan: "team",
      created_at: "2024-06-01T14:22:00Z",
    });
    this.setHash("config:feature_flags", {
      dark_mode: "true",
      new_billing: "false",
      beta_search: "true",
      max_upload_mb: "50",
    });
    this.setList("queue:emails", [
      JSON.stringify({ to: "user@ex.com", template: "welcome" }),
      JSON.stringify({ to: "ops@ex.com", template: "alert" }),
      JSON.stringify({ to: "billing@ex.com", template: "invoice" }),
    ]);
    this.setList("recent:logins", [
      "2026-07-29T08:12:00Z ada@lovelace.dev",
      "2026-07-29T07:55:00Z grace@hopper.io",
      "2026-07-28T22:01:00Z alan@turing.ai",
    ]);
    this.setSet("tags:post:42", ["redis", "performance", "caching", "infra"]);
    this.setSet("online:users", ["u_8f2a1c", "u_3b91de", "u_aa0012", "u_77c4ef"]);
    this.setZSet("leaderboard:weekly", [
      { member: "ada", score: 9820 },
      { member: "grace", score: 9104 },
      { member: "alan", score: 8740 },
      { member: "margaret", score: 8601 },
      { member: "katherine", score: 7990 },
    ]);
    this.setZSet("trending:topics", [
      { member: "redis-streams", score: 412 },
      { member: "vector-search", score: 388 },
      { member: "edge-cache", score: 301 },
      { member: "pubsub", score: 256 },
    ]);
    this.setString(
      "job:payload:991",
      JSON.stringify({ type: "resize", imageId: "img_991", sizes: [64, 256, 1024] }, null, 2),
    );
  }
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if ("+^${}()|[]\\.".includes(c)) out += "\\" + c;
    else out += c;
  }
  out += "$";
  return new RegExp(out);
}
