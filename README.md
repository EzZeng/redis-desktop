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



## Windows desktop app

Download the portable executable (no installer):

- **[RedisDesktop-1.0.0-win-portable.exe](https://github.com/EzZeng/redis-desktop/releases/download/v1.0.0/RedisDesktop-1.0.0-win-portable.exe)**

Double-click to run. Uses the built-in demo Redis engine (no Redis server required).

### Build the Windows app yourself

```bash
npm install
npm run electron:build:win
# output: release/Redis Desktop-1.0.0-win-portable.exe
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
