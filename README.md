# Redis Desktop

Desktop-style Redis client built with React, TanStack Start, and Tailwind CSS.

Browse keys, edit string/hash/list/set/zset values, manage TTLs, and run Redis CLI commands against a built-in demo engine (fully usable in the browser without a real Redis server).

## Features

- Connection profiles (demo engine in preview)
- Key browser with pattern filter, type chips, DB 0–15
- Type-aware value editors with save / rename / TTL / copy
- Interactive CLI (`GET`, `SET`, `HGETALL`, `ZRANGE`, `INFO`, `HELP`, …)
- Server info panel with key-type breakdown
- Electron-style title bar and multi-pane layout
- Responsive mobile layout

## Quick start

```bash
npm install
npm run dev
```

Open the app (default: `http://localhost:8080`).

## Offline install (no npmjs.org)

If your network blocks the npm registry, restore dependencies from the GitHub Release bundle (Linux x64):

```bash
# Preferred
./scripts/offline-install.sh

# Or manually
curl -fL -o node_modules.tar.gz \
  https://github.com/EzZeng/redis-desktop/releases/download/offline-deps-v1/node_modules.tar.gz
tar -xzf node_modules.tar.gz
npm run dev
```

Release: https://github.com/EzZeng/redis-desktop/releases/tag/offline-deps-v1






## redis.conf

The embedded server is **redis.conf-compatible**.

- Default config ships as `electron/redis.conf`
- On first run, copied to the app user data folder as `redis.conf`
- Edit in the app **Conf** tab, or open the folder and use your editor
- Supported directives include: `bind`, `port`, `requirepass`, `databases`,
  `maxmemory`, `maxmemory-policy`, `maxclients`, `timeout`, `save`, `dir`,
  `dbfilename`, `appendonly`, `appendfsync`, `rename-command`, `protected-mode`, …
- Runtime: `CONFIG GET *`, `CONFIG SET`, `CONFIG REWRITE`, `SAVE` / `BGSAVE`
- Snapshots written to `dir`/`dbfilename` (JSON dump format for the embedded engine)

## Built-in redis-server

The **desktop app embeds a Redis-compatible server** (RESP/TCP on `127.0.0.1:6379`).

- Starts automatically when the app launches
- Seeded with sample keys
- Connect with **Embedded Redis Server** (default)
- Other tools (`redis-cli`, another Redis GUI) can also connect to that port
- Still supports **External Redis** hosts and the offline **In-memory Demo**

## Real Redis server (desktop app)

The **Windows Electron app** connects over TCP to a real `redis-server`:

1. Start Redis locally (e.g. `redis-server` or Docker `redis:7`).
2. Open **Local Redis** connection (`127.0.0.1:6379`) or add your host/port/password.
3. Browse keys, edit values, run CLI against the live server.

The web preview cannot open Redis TCP sockets; it uses the built-in **demo engine**. New connections default to TCP in the desktop app (optional “demo engine” checkbox).

## Windows desktop app

Download the portable executable (no installer):

- **[RedisDesktop-1.3.0-win-portable.exe](https://github.com/EzZeng/redis-desktop/releases/download/v1.3.0/RedisDesktop-1.3.0-win-portable.exe)**

Double-click to run. Uses the built-in demo Redis engine (no Redis server required).

### Build the Windows app yourself

```bash
npm install
npm run electron:build:win
# output: release/Redis Desktop-1.3.0-win-portable.exe
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server on `0.0.0.0:8080` |
| `npm run build` | Production build (Vercel/Nitro) |
| `npm run typecheck` | TypeScript check |
| `npm run preview` | Preview production build |

## Stack

- React 19 + TypeScript
- TanStack Start / Router
- Tailwind CSS v4
- Zustand
- Lucide icons
- Sonner toasts

## Note

This is a browser-hosted desktop UI with an in-memory Redis-compatible engine for demo and development. Real TCP Redis connections are not available in the browser sandbox; the engine supports common commands for browsing and CLI work.
