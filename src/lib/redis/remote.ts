/** Electron-bridged Redis backend — talks to real redis-server via main process. */

import type { KeyMeta, RedisType, RedisValue } from "./engine";

export interface RedisDesktopBridge {
  isElectron: boolean;
  platform: string;
  redis: {
    connect: (opts: {
      host: string;
      port: number;
      username?: string;
      password?: string;
      db?: number;
    }) => Promise<{ ok: boolean; error?: string; host?: string; port?: number; db?: number }>;
    disconnect: () => Promise<{ ok: boolean }>;
    status: () => Promise<{ connected: boolean; db: number; host: string; port: number }>;
    keys: (pattern: string) => Promise<KeyMeta[]>;
    getEntry: (key: string) => Promise<(RedisValue & { ttl: number }) | null>;
    setString: (key: string, value: string, ttl?: number) => Promise<{ ok: boolean }>;
    setHash: (key: string, fields: Record<string, string>, ttl?: number) => Promise<{ ok: boolean }>;
    setList: (key: string, values: string[], ttl?: number) => Promise<{ ok: boolean }>;
    setSet: (key: string, members: string[], ttl?: number) => Promise<{ ok: boolean }>;
    setZSet: (
      key: string,
      members: Array<{ member: string; score: number }>,
      ttl?: number,
    ) => Promise<{ ok: boolean }>;
    del: (keys: string[]) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<boolean>;
    persist: (key: string) => Promise<boolean>;
    rename: (oldKey: string, newKey: string) => Promise<boolean>;
    select: (db: number) => Promise<{ ok: boolean; db: number }>;
    exec: (line: string) => Promise<string>;
    currentDb: () => Promise<number>;
    serverStatus: () => Promise<{
      running: boolean;
      host: string;
      port: number;
      clients: number;
      mode: string;
      version: string;
    }>;
    serverStart: (opts?: { host?: string; port?: number; seed?: boolean }) => Promise<{
      ok: boolean;
      error?: string;
      running?: boolean;
      host?: string;
      port?: number;
    }>;
    serverStop: () => Promise<{ ok: boolean }>;
    serverReseed: () => Promise<{ ok: boolean }>;
    confGet: () => Promise<{ ok: boolean; path: string; text: string; status?: unknown }>;
    confSet: (payload: { text: string }) => Promise<{
      ok: boolean;
      error?: string;
      path?: string;
      restarted?: boolean;
      status?: { port?: number; host?: string };
    }>;
    confPath: () => Promise<{ path: string }>;
    confOpenDir: () => Promise<{ ok: boolean; path?: string }>;
  };
}

declare global {
  interface Window {
    redisDesktop?: RedisDesktopBridge;
  }
}

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && !!window.redisDesktop?.isElectron;
}

export function getRedisBridge(): RedisDesktopBridge["redis"] | null {
  return window.redisDesktop?.redis ?? null;
}

/**
 * Drop-in async-capable backend used by the store when connected to a real server.
 * Methods mirror RedisEngine but are async under the hood; the store awaits them.
 */
export class RemoteRedisEngine {
  private _db = 0;
  private bridge: RedisDesktopBridge["redis"];

  constructor(bridge: RedisDesktopBridge["redis"]) {
    this.bridge = bridge;
  }

  get currentDb() {
    return this._db;
  }

  seedDemo() {
    /* no-op for remote */
  }

  async connect(opts: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db?: number;
  }) {
    const res = await this.bridge.connect(opts);
    if (!res.ok) throw new Error(res.error || "Connection failed");
    this._db = res.db ?? 0;
    return res;
  }

  async disconnect() {
    await this.bridge.disconnect();
  }

  keys(pattern = "*"): KeyMeta[] {
    // sync facade not available — store must use keysAsync
    throw new Error("Use keysAsync for remote engine");
  }

  async keysAsync(pattern = "*"): Promise<KeyMeta[]> {
    return this.bridge.keys(pattern);
  }

  async getEntryAsync(key: string): Promise<(RedisValue & { ttl: number }) | null> {
    return this.bridge.getEntry(key);
  }

  getEntry(key: string): (RedisValue & { ttl: number }) | null {
    throw new Error("Use getEntryAsync for remote engine");
  }

  async setString(key: string, value: string, ttl?: number) {
    await this.bridge.setString(key, value, ttl);
  }

  async setHash(key: string, fields: Record<string, string>, ttl?: number) {
    await this.bridge.setHash(key, fields, ttl);
  }

  async setList(key: string, values: string[], ttl?: number) {
    await this.bridge.setList(key, values, ttl);
  }

  async setSet(key: string, members: string[], ttl?: number) {
    await this.bridge.setSet(key, members, ttl);
  }

  async setZSet(key: string, members: Array<{ member: string; score: number }>, ttl?: number) {
    await this.bridge.setZSet(key, members, ttl);
  }

  async del(...keys: string[]) {
    return this.bridge.del(keys);
  }

  async expire(key: string, seconds: number) {
    return this.bridge.expire(key, seconds);
  }

  async persist(key: string) {
    return this.bridge.persist(key);
  }

  async rename(oldKey: string, newKey: string) {
    return this.bridge.rename(oldKey, newKey);
  }

  async select(db: number) {
    await this.bridge.select(db);
    this._db = db;
  }

  async execAsync(line: string) {
    const out = await this.bridge.exec(line);
    try {
      this._db = await this.bridge.currentDb();
    } catch {
      /* ignore */
    }
    return out;
  }

  exec(line: string): string {
    throw new Error("Use execAsync for remote engine");
  }

  get isRemote() {
    return true as const;
  }
}

export type AnyRedisEngine = import("./engine").RedisEngine | RemoteRedisEngine;

export function isRemoteEngine(e: unknown): e is RemoteRedisEngine {
  return !!e && typeof e === "object" && (e as RemoteRedisEngine).isRemote === true;
}
