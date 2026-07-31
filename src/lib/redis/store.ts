import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  RedisEngine,
  type KeyMeta,
  type RedisType,
  type RedisValue,
} from "./engine";
import {
  RemoteRedisEngine,
  getRedisBridge,
  isElectronRuntime,
  isRemoteEngine,
} from "./remote";

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** When true, uses the in-browser demo engine (no real network). */
  demo: boolean;
  color: string;
}

export interface CliLine {
  id: string;
  kind: "in" | "out" | "err" | "sys";
  text: string;
}

type Engine = RedisEngine | RemoteRedisEngine;

interface RedisState {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  connected: boolean;
  connecting: boolean;
  connectionError: string | null;
  engine: Engine | null;
  /** true when talking to real redis-server via Electron */
  remote: boolean;
  db: number;
  keys: KeyMeta[];
  filter: string;
  selectedKey: string | null;
  selectedValue: (RedisValue & { ttl: number }) | null;
  cliHistory: CliLine[];
  cliCmdHistory: string[];
  sidebarTab: "keys" | "cli" | "info" | "config";
  connect: (profileId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  addProfile: (p: Omit<ConnectionProfile, "id">) => string;
  updateProfile: (id: string, patch: Partial<ConnectionProfile>) => void;
  removeProfile: (id: string) => void;
  refreshKeys: () => Promise<void>;
  setFilter: (f: string) => void;
  selectDb: (db: number) => Promise<void>;
  selectKey: (key: string | null) => Promise<void>;
  saveValue: (key: string, value: RedisValue, ttl: number) => Promise<void>;
  deleteKeys: (keys: string[]) => Promise<void>;
  createKey: (key: string, type: RedisType, ttl?: number) => Promise<void>;
  runCli: (cmd: string) => Promise<void>;
  clearCli: () => void;
  setSidebarTab: (t: "keys" | "cli" | "info" | "config") => void;
  renameKey: (oldKey: string, newKey: string) => Promise<boolean>;
  setTtl: (key: string, ttl: number) => Promise<void>;
  getInfoText: () => Promise<string>;
}

const DEFAULT_PROFILES: ConnectionProfile[] = [
  {
    id: "embedded-redis",
    name: "Local redis-server",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    password: "",
    demo: false,
    color: "#dc382d",
  },
  {
    id: "local-redis",
    name: "External Redis",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    password: "",
    demo: false,
    color: "#3b82f6",
  },
  {
    id: "demo-local",
    name: "In-memory Demo",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    password: "",
    demo: true,
    color: "#e85d4c",
  },
];

let lineId = 0;
function nextId() {
  return `l${++lineId}`;
}

async function engineKeys(engine: Engine, pattern: string): Promise<KeyMeta[]> {
  if (isRemoteEngine(engine)) return engine.keysAsync(pattern);
  return engine.keys(pattern);
}

async function engineGetEntry(
  engine: Engine,
  key: string,
): Promise<(RedisValue & { ttl: number }) | null> {
  if (isRemoteEngine(engine)) return engine.getEntryAsync(key);
  return engine.getEntry(key);
}

async function engineExec(engine: Engine, line: string): Promise<string> {
  if (isRemoteEngine(engine)) return engine.execAsync(line);
  return engine.exec(line);
}

export const useRedisStore = create<RedisState>()(
  persist(
    (set, get) => ({
      profiles: DEFAULT_PROFILES,
      activeProfileId: null,
      connected: false,
      connecting: false,
      connectionError: null,
      engine: null,
      remote: false,
      db: 0,
      keys: [],
      filter: "*",
      selectedKey: null,
      selectedValue: null,
      cliHistory: [],
      cliCmdHistory: [],
      sidebarTab: "keys",

      connect: async (profileId) => {
        let profile = get().profiles.find((p) => p.id === profileId);
        if (!profile) return;
        set({
          connecting: true,
          connectionError: null,
          activeProfileId: profileId,
        });

        try {
          // Real Redis via Electron IPC when not a demo profile
          const bridge = getRedisBridge();
          const wantRemote = !profile.demo && isElectronRuntime() && !!bridge;

          if (wantRemote && bridge) {
            // Ensure built-in redis-server is up (especially Embedded profile)
            if (bridge.serverStart) {
              const srv = await bridge.serverStart({
                host: "127.0.0.1",
                port: 6379,
                seed: true,
              });
              if (srv.ok && srv.port) {
                if (profile.id === "embedded-redis") {
                  const host = srv.host || "127.0.0.1";
                  const port = srv.port;
                  if (host !== profile.host || port !== profile.port) {
                    get().updateProfile(profile.id, { host, port });
                  }
                  profile = { ...profile, host, port };
                }
              }
            }
            const remote = new RemoteRedisEngine(bridge);
            const connectHost = profile.host;
            const connectPort = profile.port;
            await remote.connect({
              host: connectHost,
              port: connectPort,
              username: profile.username,
              password: profile.password,
              db: 0,
            });
            set({
              engine: remote,
              remote: true,
              connected: true,
              connecting: false,
              db: 0,
              selectedKey: null,
              selectedValue: null,
              cliHistory: [
                {
                  id: nextId(),
                  kind: "sys",
                  text: `Connected to ${profile.name} (${profile.host}:${profile.port}) · redis-server`,
                },
                {
                  id: nextId(),
                  kind: "sys",
                  text:
                    profile.id === "embedded-redis"
                      ? "Bundled redis-server (redis-windows) is running inside this app. Full Redis protocol — Jedis, redis-cli, etc. work on this port."
                      : "Live TCP connection via Electron. Type any Redis command in the CLI.",
                },
              ],
            });
            await get().refreshKeys();
            return;
          }

          // Demo / browser fallback
          if (!profile.demo && !isElectronRuntime()) {
            // Browser cannot open TCP to Redis — fall back to demo with notice
            await new Promise((r) => setTimeout(r, 200));
            const engine = new RedisEngine();
            engine.seedDemo();
            set({
              engine,
              remote: false,
              connected: true,
              connecting: false,
              db: 0,
              selectedKey: null,
              selectedValue: null,
              connectionError: null,
              cliHistory: [
                {
                  id: nextId(),
                  kind: "sys",
                  text: `Browser preview cannot reach redis-server at ${profile.host}:${profile.port}.`,
                },
                {
                  id: nextId(),
                  kind: "sys",
                  text: "Using built-in demo engine. Open the Windows desktop app for real Redis TCP.",
                },
              ],
            });
            await get().refreshKeys();
            return;
          }

          await new Promise((r) => setTimeout(r, 280));
          const engine = new RedisEngine();
          engine.seedDemo();
          set({
            engine,
            remote: false,
            connected: true,
            connecting: false,
            db: 0,
            selectedKey: null,
            selectedValue: null,
            cliHistory: [
              {
                id: nextId(),
                kind: "sys",
                text: `Connected to ${profile.name} (${profile.host}:${profile.port}) · demo engine`,
              },
              {
                id: nextId(),
                kind: "sys",
                text: "Type HELP for supported commands. Sample keys loaded in db0.",
              },
            ],
          });
          await get().refreshKeys();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set({
            connecting: false,
            connected: false,
            engine: null,
            remote: false,
            connectionError: msg,
            cliHistory: [
              {
                id: nextId(),
                kind: "err",
                text: `Connection failed: ${msg}`,
              },
            ],
          });
        }
      },

      disconnect: async () => {
        const { engine } = get();
        if (isRemoteEngine(engine)) {
          try {
            await engine.disconnect();
          } catch {
            /* ignore */
          }
        }
        set({
          connected: false,
          engine: null,
          remote: false,
          keys: [],
          selectedKey: null,
          selectedValue: null,
          activeProfileId: null,
          connectionError: null,
        });
      },

      addProfile: (p) => {
        const id = `conn-${Date.now()}`;
        set((s) => ({ profiles: [...s.profiles, { ...p, id }] }));
        return id;
      },

      updateProfile: (id, patch) => {
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        }));
      },

      removeProfile: (id) => {
        const s = get();
        if (s.activeProfileId === id) void s.disconnect();
        set((st) => ({ profiles: st.profiles.filter((p) => p.id !== id) }));
      },

      refreshKeys: async () => {
        const { engine, filter } = get();
        if (!engine) return;
        try {
          const keys = await engineKeys(engine, filter || "*");
          set({ keys });
          const sel = get().selectedKey;
          if (sel) {
            const v = await engineGetEntry(engine, sel);
            set({ selectedValue: v });
            if (!v) set({ selectedKey: null });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((s) => ({
            cliHistory: [
              ...s.cliHistory,
              { id: nextId(), kind: "err", text: `Refresh keys failed: ${msg}` },
            ],
          }));
        }
      },

      setFilter: (f) => {
        set({ filter: f });
        void get().refreshKeys();
      },

      selectDb: async (db) => {
        const { engine } = get();
        if (!engine) return;
        await engine.select(db);
        set({ db, selectedKey: null, selectedValue: null });
        await get().refreshKeys();
      },

      selectKey: async (key) => {
        const { engine } = get();
        if (!engine || !key) {
          set({ selectedKey: null, selectedValue: null });
          return;
        }
        const value = await engineGetEntry(engine, key);
        set({ selectedKey: key, selectedValue: value });
      },

      saveValue: async (key, value, ttl) => {
        const { engine } = get();
        if (!engine) return;
        switch (value.type) {
          case "string":
            await engine.setString(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "hash":
            await engine.setHash(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "list":
            await engine.setList(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "set":
            await engine.setSet(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "zset":
            await engine.setZSet(key, value.value, ttl > 0 ? ttl : undefined);
            break;
        }
        if (ttl < 0) await engine.persist(key);
        else if (ttl > 0) await engine.expire(key, ttl);
        await get().refreshKeys();
        await get().selectKey(key);
      },

      deleteKeys: async (keys) => {
        const { engine, selectedKey } = get();
        if (!engine) return;
        await engine.del(...keys);
        if (selectedKey && keys.includes(selectedKey)) {
          set({ selectedKey: null, selectedValue: null });
        }
        await get().refreshKeys();
      },

      createKey: async (key, type, ttl) => {
        const { engine } = get();
        if (!engine) return;
        const existing = await engineGetEntry(engine, key);
        if (existing) {
          throw new Error("Key already exists");
        }
        switch (type) {
          case "string":
            await engine.setString(key, "", ttl);
            break;
          case "hash":
            await engine.setHash(key, { field: "value" }, ttl);
            break;
          case "list":
            await engine.setList(key, ["item"], ttl);
            break;
          case "set":
            await engine.setSet(key, ["member"], ttl);
            break;
          case "zset":
            await engine.setZSet(key, [{ member: "member", score: 0 }], ttl);
            break;
        }
        await get().refreshKeys();
        await get().selectKey(key);
      },

      runCli: async (cmd) => {
        const trimmed = cmd.trim();
        if (!trimmed) return;
        const { engine } = get();
        set((s) => ({
          cliHistory: [...s.cliHistory, { id: nextId(), kind: "in", text: trimmed }],
          cliCmdHistory: [trimmed, ...s.cliCmdHistory.filter((c) => c !== trimmed)].slice(
            0,
            100,
          ),
        }));
        if (!engine) {
          set((s) => ({
            cliHistory: [
              ...s.cliHistory,
              { id: nextId(), kind: "err", text: "(error) not connected" },
            ],
          }));
          return;
        }
        const reply = await engineExec(engine, trimmed);
        const kind = reply.startsWith("(error)") ? "err" : "out";
        set((s) => ({
          cliHistory: [...s.cliHistory, { id: nextId(), kind, text: reply }],
          db: engine.currentDb,
        }));
        const head = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";
        if (
          [
            "SET",
            "DEL",
            "EXPIRE",
            "PERSIST",
            "RENAME",
            "FLUSHDB",
            "FLUSHALL",
            "HSET",
            "LPUSH",
            "RPUSH",
            "SADD",
            "ZADD",
            "SELECT",
            "GETSET",
            "MSET",
            "INCR",
            "DECR",
          ].includes(head)
        ) {
          await get().refreshKeys();
        }
      },

      clearCli: () => set({ cliHistory: [] }),

      setSidebarTab: (t) => set({ sidebarTab: t }),

      renameKey: async (oldKey, newKey) => {
        const { engine } = get();
        if (!engine) return false;
        const ok = await engine.rename(oldKey, newKey);
        if (ok) {
          await get().refreshKeys();
          await get().selectKey(newKey);
        }
        return ok;
      },

      setTtl: async (key, ttl) => {
        const { engine } = get();
        if (!engine) return;
        if (ttl < 0) await engine.persist(key);
        else await engine.expire(key, ttl);
        await get().refreshKeys();
        await get().selectKey(key);
      },

      getInfoText: async () => {
        const { engine } = get();
        if (!engine) return "";
        return engineExec(engine, "INFO");
      },
    }),
    {
      name: "redis-desktop-profiles",
      partialize: (s) => ({ profiles: s.profiles }),
      // Merge new default profiles (e.g. Local Redis) for existing users
      merge: (persisted, current) => {
        const p = persisted as Partial<RedisState> | undefined;
        const saved = p?.profiles ?? [];
        const byId = new Map(saved.map((x) => [x.id, x]));
        for (const d of DEFAULT_PROFILES) {
          if (!byId.has(d.id)) byId.set(d.id, d);
        }
        return {
          ...current,
          ...p,
          profiles: [...byId.values()],
        };
      },
    },
  ),
);
