import { useEffect, useState } from "react";
import { Database, Server } from "lucide-react";
import { useRedisStore } from "@/lib/redis/store";
import { getRedisBridge, isElectronRuntime } from "@/lib/redis/remote";
import { cn } from "@/lib/utils";

export function TitleBar() {
  const connected = useRedisStore((s) => s.connected);
  const remote = useRedisStore((s) => s.remote);
  const profiles = useRedisStore((s) => s.profiles);
  const activeProfileId = useRedisStore((s) => s.activeProfileId);
  const profile = profiles.find((p) => p.id === activeProfileId);
  const [server, setServer] = useState<{
    running: boolean;
    host: string;
    port: number;
    mode?: string;
    version?: string;
    backend?: string;
  } | null>(null);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = getRedisBridge();
    if (!bridge?.serverStatus) return;
    let cancelled = false;
    const tick = () => {
      void bridge.serverStatus().then((s) => {
        if (!cancelled)
          setServer({
            running: s.running,
            host: s.host,
            port: s.port,
            mode: (s as { mode?: string }).mode,
            version: (s as { version?: string }).version,
            backend: (s as { backend?: string }).backend,
          });
      });
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border bg-titlebar select-none">
      <div className="flex w-20 items-center gap-1.5 px-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" title="Close" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" title="Minimize" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" title="Maximize" />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <Database className="h-3.5 w-3.5 text-primary" />
        <span className="text-[12px] font-semibold tracking-wide text-fg">Redis Desktop</span>
        {server?.running && (
          <span
            className="hidden items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success sm:inline-flex"
            title={
              server.mode === "native-redis-server"
                ? `Bundled redis-server.exe (${server.version || "redis-windows"})`
                : "Embedded JS redis-compatible server"
            }
          >
            <Server className="h-3 w-3" />
            {server.mode === "native-redis-server" ? "redis-server" : "embedded"}{" "}
            {server.host}:{server.port}
          </span>
        )}
        {profile && (
          <span
            className={cn(
              "max-w-[200px] truncate rounded-full px-2 py-0.5 text-[10px] font-medium",
              connected
                ? remote
                  ? "bg-primary/15 text-primary"
                  : "bg-surface-3 text-muted"
                : "bg-surface-3 text-subtle",
            )}
          >
            {connected ? profile.name : "Disconnected"}
          </span>
        )}
      </div>

      <div className="w-20" />
    </header>
  );
}
