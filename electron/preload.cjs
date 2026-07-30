// Preload reserved for future native Redis bridges (e.g. TCP via node:net).
// Keep contextIsolation on; expose APIs only via contextBridge when needed.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("redisDesktop", {
  platform: process.platform,
  isElectron: true,
});
