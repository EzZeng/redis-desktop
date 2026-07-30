const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("redisDesktop", {
  platform: process.platform,
  isElectron: true,
  redis: {
    connect: (opts) => ipcRenderer.invoke("redis:connect", opts),
    disconnect: () => ipcRenderer.invoke("redis:disconnect"),
    status: () => ipcRenderer.invoke("redis:status"),
    keys: (pattern) => ipcRenderer.invoke("redis:keys", pattern),
    getEntry: (key) => ipcRenderer.invoke("redis:getEntry", key),
    setString: (key, value, ttl) => ipcRenderer.invoke("redis:setString", key, value, ttl),
    setHash: (key, fields, ttl) => ipcRenderer.invoke("redis:setHash", key, fields, ttl),
    setList: (key, values, ttl) => ipcRenderer.invoke("redis:setList", key, values, ttl),
    setSet: (key, members, ttl) => ipcRenderer.invoke("redis:setSet", key, members, ttl),
    setZSet: (key, members, ttl) => ipcRenderer.invoke("redis:setZSet", key, members, ttl),
    del: (keys) => ipcRenderer.invoke("redis:del", keys),
    expire: (key, seconds) => ipcRenderer.invoke("redis:expire", key, seconds),
    persist: (key) => ipcRenderer.invoke("redis:persist", key),
    rename: (oldKey, newKey) => ipcRenderer.invoke("redis:rename", oldKey, newKey),
    select: (db) => ipcRenderer.invoke("redis:select", db),
    exec: (line) => ipcRenderer.invoke("redis:exec", line),
    currentDb: () => ipcRenderer.invoke("redis:currentDb"),
    serverStatus: () => ipcRenderer.invoke("redis:server:status"),
    serverStart: (opts) => ipcRenderer.invoke("redis:server:start", opts),
    serverStop: () => ipcRenderer.invoke("redis:server:stop"),
    serverReseed: () => ipcRenderer.invoke("redis:server:reseed"),
  },
});
