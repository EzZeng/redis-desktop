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
