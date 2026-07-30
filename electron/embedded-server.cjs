/**
 * Embedded redis-server: RESP protocol TCP server bound to localhost.
 * Ships inside Redis Desktop — no external redis install required.
 */
const net = require("net");
const { EmbeddedEngine } = require("./embedded-engine.cjs");

function encodeResp(value) {
  if (value instanceof Error) {
    const msg = value.message.startsWith("ERR") || value.message.startsWith("WRONGTYPE")
      ? value.message
      : `ERR ${value.message}`;
    return `-${msg}\r\n`;
  }
  if (value === null || value === undefined) return "$-1\r\n";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `:${Math.trunc(value)}\r\n`;
  }
  if (typeof value === "boolean") return `:${value ? 1 : 0}\r\n`;
  if (typeof value === "string") {
    // Simple strings for OK / PONG / status
    if (value === "OK" || value === "PONG" || value === "QUEUED") {
      return `+${value}\r\n`;
    }
    const buf = Buffer.from(value, "utf8");
    return `$${buf.length}\r\n${value}\r\n`;
  }
  if (Array.isArray(value)) {
    let out = `*${value.length}\r\n`;
    for (const item of value) out += encodeResp(item);
    return out;
  }
  const s = String(value);
  const buf = Buffer.from(s, "utf8");
  return `$${buf.length}\r\n${s}\r\n`;
}

function parseResp(buf, offset = 0) {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  const nl = buf.indexOf("\r\n", offset);
  if (nl === -1) return null;
  const line = buf.toString("utf8", offset + 1, nl);

  if (type === "+") return [line, nl + 2];
  if (type === "-") return [new Error(line), nl + 2];
  if (type === ":") return [Number(line), nl + 2];
  if (type === "$") {
    const len = Number(line);
    if (len === -1) return [null, nl + 2];
    const start = nl + 2;
    const end = start + len;
    if (buf.length < end + 2) return null;
    return [buf.toString("utf8", start, end), end + 2];
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) return [null, nl + 2];
    let pos = nl + 2;
    const arr = [];
    for (let i = 0; i < count; i++) {
      const next = parseResp(buf, pos);
      if (!next) return null;
      arr.push(next[0]);
      pos = next[1];
    }
    return [arr, pos];
  }
  // Inline command protocol (telnet style): COMMAND arg arg\r\n
  if (type !== "*" && type !== "$" && type !== "+" && type !== "-" && type !== ":") {
    const lineEnd = buf.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const raw = buf.toString("utf8", offset, lineEnd).trim();
    if (!raw) return [[], lineEnd + 2];
    // crude split respecting quotes
    const args = [];
    let cur = "";
    let q = null;
    for (const ch of raw) {
      if (q) {
        if (ch === q) q = null;
        else cur += ch;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (/\s/.test(ch)) {
        if (cur) {
          args.push(cur);
          cur = "";
        }
      } else cur += ch;
    }
    if (cur) args.push(cur);
    return [args, lineEnd + 2];
  }
  return null;
}

class EmbeddedRedisServer {
  constructor() {
    this.engine = new EmbeddedEngine();
    this.server = null;
    this.host = "127.0.0.1";
    this.port = 6379;
    this.running = false;
    this.clients = new Set();
    this.seeded = false;
    this._chain = Promise.resolve();
  }

  /** Serialize engine access across TCP clients */
  _withEngine(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  async start({ host = "127.0.0.1", preferredPort = 6379, seed = true } = {}) {
    if (this.running) return this.status();

    if (seed && !this.seeded) {
      this.engine.seedDemo();
      this.seeded = true;
    }

    const ports = [preferredPort, preferredPort + 1, preferredPort + 2, 16379, 26379];
    let lastErr;
    for (const port of ports) {
      try {
        await this._listen(host, port);
        this.host = host;
        this.port = port;
        this.running = true;
        return this.status();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Could not bind embedded Redis server");
  }

  _listen(host, port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));
      const onErr = (err) => {
        server.removeAllListeners();
        reject(err);
      };
      server.once("error", onErr);
      server.listen(port, host, () => {
        server.removeListener("error", onErr);
        server.on("error", (err) => console.error("[embedded-redis]", err));
        this.server = server;
        resolve();
      });
    });
  }

  _onConnection(socket) {
    this.clients.add(socket);
    // Per-connection SELECT db (clone index on session)
    let sessionDb = 0;
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const processBuffer = () => {
        const parsed = parseResp(buffer, 0);
        if (!parsed) return;
        const [value, consumed] = parsed;
        buffer = buffer.subarray(consumed);

        let args = value;
        if (!Array.isArray(args)) {
          socket.write(encodeResp(new Error("ERR Protocol error: expected array")));
          processBuffer();
          return;
        }

        void this._withEngine(() => {
          const prev = this.engine.dbIndex;
          this.engine.dbIndex = sessionDb;
          try {
            const result = this.engine.dispatch(args.map(String));
            if (String(args[0] || "").toUpperCase() === "SELECT" && args[1] !== undefined) {
              sessionDb = this.engine.dbIndex;
            }
            if (String(args[0] || "").toUpperCase() === "QUIT") {
              socket.write(encodeResp("OK"));
              socket.end();
              return;
            }
            socket.write(encodeResp(result));
          } catch (err) {
            socket.write(encodeResp(err instanceof Error ? err : new Error(String(err))));
          } finally {
            this.engine.dbIndex = prev;
          }
          processBuffer();
        });
      };
      processBuffer();
    });

    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }

  stop() {
    for (const c of this.clients) {
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
    }
    this.server = null;
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      clients: this.clients.size,
      mode: "embedded",
      version: "7.2.0-embedded",
    };
  }

  reseed() {
    this.engine.seedDemo();
    this.seeded = true;
  }
}

module.exports = { EmbeddedRedisServer, encodeResp };
