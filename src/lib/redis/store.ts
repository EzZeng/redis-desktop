import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  RedisEngine,
  type KeyMeta,
  type RedisType,
  type RedisValue,
} from "./engine";

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

interface RedisState {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  connected: boolean;
  connecting: boolean;
  connectionError: string | null;
  engine: RedisEngine | null;
  db: number;
  keys: KeyMeta[];
  filter: string;
  selectedKey: string | null;
  selectedValue: (RedisValue & { ttl: number }) | null;
  cliHistory: CliLine[];
  cliCmdHistory: string[];
  sidebarTab: "keys" | "cli" | "info";
  connect: (profileId: string) => Promise<void>;
  disconnect: () => void;
  addProfile: (p: Omit<ConnectionProfile, "id">) => string;
  updateProfile: (id: string, patch: Partial<ConnectionProfile>) => void;
  removeProfile: (id: string) => void;
  refreshKeys: () => void;
  setFilter: (f: string) => void;
  selectDb: (db: number) => void;
  selectKey: (key: string | null) => void;
  saveValue: (key: string, value: RedisValue, ttl: number) => void;
  deleteKeys: (keys: string[]) => void;
  createKey: (key: string, type: RedisType, ttl?: number) => void;
  runCli: (cmd: string) => void;
  clearCli: () => void;
  setSidebarTab: (t: "keys" | "cli" | "info") => void;
  renameKey: (oldKey: string, newKey: string) => boolean;
  setTtl: (key: string, ttl: number) => void;
}

const DEFAULT_PROFILES: ConnectionProfile[] = [
  {
    id: "demo-local",
    name: "Local Demo",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    password: "",
    demo: true,
    color: "#dc382d",
  },
  {
    id: "demo-staging",
    name: "Staging Cache",
    host: "redis.staging.internal",
    port: 6379,
    username: "app",
    password: "",
    demo: true,
    color: "#3b82f6",
  },
];

let lineId = 0;
function nextId() {
  return `l${++lineId}`;
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
      db: 0,
      keys: [],
      filter: "*",
      selectedKey: null,
      selectedValue: null,
      cliHistory: [],
      cliCmdHistory: [],
      sidebarTab: "keys",

      connect: async (profileId) => {
        const profile = get().profiles.find((p) => p.id === profileId);
        if (!profile) return;
        set({
          connecting: true,
          connectionError: null,
          activeProfileId: profileId,
        });
        await new Promise((r) => setTimeout(r, 420));
        // Browser sandbox: always use demo engine (real TCP Redis is not available).
        const engine = new RedisEngine();
        engine.seedDemo();
        set({
          engine,
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
        get().refreshKeys();
      },

      disconnect: () => {
        set({
          connected: false,
          engine: null,
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
        if (s.activeProfileId === id) s.disconnect();
        set((st) => ({ profiles: st.profiles.filter((p) => p.id !== id) }));
      },

      refreshKeys: () => {
        const { engine, filter } = get();
        if (!engine) return;
        set({ keys: engine.keys(filter || "*") });
        const sel = get().selectedKey;
        if (sel) {
          const v = engine.getEntry(sel);
          set({ selectedValue: v });
          if (!v) set({ selectedKey: null });
        }
      },

      setFilter: (f) => {
        set({ filter: f });
        get().refreshKeys();
      },

      selectDb: (db) => {
        const { engine } = get();
        if (!engine) return;
        engine.select(db);
        set({ db, selectedKey: null, selectedValue: null });
        get().refreshKeys();
      },

      selectKey: (key) => {
        const { engine } = get();
        if (!engine || !key) {
          set({ selectedKey: null, selectedValue: null });
          return;
        }
        set({ selectedKey: key, selectedValue: engine.getEntry(key) });
      },

      saveValue: (key, value, ttl) => {
        const { engine } = get();
        if (!engine) return;
        switch (value.type) {
          case "string":
            engine.setString(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "hash":
            engine.setHash(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "list":
            engine.setList(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "set":
            engine.setSet(key, value.value, ttl > 0 ? ttl : undefined);
            break;
          case "zset":
            engine.setZSet(key, value.value, ttl > 0 ? ttl : undefined);
            break;
        }
        if (ttl < 0) engine.persist(key);
        else if (ttl > 0) engine.expire(key, ttl);
        get().refreshKeys();
        get().selectKey(key);
      },

      deleteKeys: (keys) => {
        const { engine, selectedKey } = get();
        if (!engine) return;
        engine.del(...keys);
        if (selectedKey && keys.includes(selectedKey)) {
          set({ selectedKey: null, selectedValue: null });
        }
        get().refreshKeys();
      },

      createKey: (key, type, ttl) => {
        const { engine } = get();
        if (!engine) return;
        if (engine.getEntry(key)) {
          throw new Error("Key already exists");
        }
        switch (type) {
          case "string":
            engine.setString(key, "", ttl);
            break;
          case "hash":
            engine.setHash(key, { field: "value" }, ttl);
            break;
          case "list":
            engine.setList(key, ["item"], ttl);
            break;
          case "set":
            engine.setSet(key, ["member"], ttl);
            break;
          case "zset":
            engine.setZSet(key, [{ member: "member", score: 0 }], ttl);
            break;
        }
        get().refreshKeys();
        get().selectKey(key);
      },

      runCli: (cmd) => {
        const trimmed = cmd.trim();
        if (!trimmed) return;
        const { engine } = get();
        set((s) => ({
          cliHistory: [
            ...s.cliHistory,
            { id: nextId(), kind: "in", text: trimmed },
          ],
          cliCmdHistory: [trimmed, ...s.cliCmdHistory.filter((c) => c !== trimmed)].slice(0, 100),
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
        const reply = engine.exec(trimmed);
        const kind = reply.startsWith("(error)") ? "err" : "out";
        set((s) => ({
          cliHistory: [...s.cliHistory, { id: nextId(), kind, text: reply }],
          db: engine.currentDb,
        }));
        // Refresh if mutating-ish commands
        const head = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";
        if (
          [
            "SET",
            "DEL",
            "EXPIRE",
            "PERSIST",
            "RENAME",
            "FLUSHDB",
            "HSET",
            "LPUSH",
            "RPUSH",
            "SADD",
            "ZADD",
            "SELECT",
          ].includes(head)
        ) {
          get().refreshKeys();
        }
      },

      clearCli: () => set({ cliHistory: [] }),

      setSidebarTab: (t) => set({ sidebarTab: t }),

      renameKey: (oldKey, newKey) => {
        const { engine } = get();
        if (!engine) return false;
        const ok = engine.rename(oldKey, newKey);
        if (ok) {
          get().refreshKeys();
          get().selectKey(newKey);
        }
        return ok;
      },

      setTtl: (key, ttl) => {
        const { engine } = get();
        if (!engine) return;
        if (ttl < 0) engine.persist(key);
        else engine.expire(key, ttl);
        get().refreshKeys();
        get().selectKey(key);
      },
    }),
    {
      name: "redis-desktop-profiles",
      partialize: (s) => ({ profiles: s.profiles }),
    },
  ),
);
