import { useEffect, useMemo, useState } from "react";
import { useRedisStore } from "@/lib/redis/store";

export function InfoPanel() {
  const keys = useRedisStore((s) => s.keys);
  const db = useRedisStore((s) => s.db);
  const profiles = useRedisStore((s) => s.profiles);
  const activeProfileId = useRedisStore((s) => s.activeProfileId);
  const remote = useRedisStore((s) => s.remote);
  const getInfoText = useRedisStore((s) => s.getInfoText);
  const connected = useRedisStore((s) => s.connected);
  const profile = profiles.find((p) => p.id === activeProfileId);
  const [infoText, setInfoText] = useState("");

  useEffect(() => {
    if (!connected) {
      setInfoText("");
      return;
    }
    let cancelled = false;
    void getInfoText().then((t) => {
      if (!cancelled) setInfoText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [connected, getInfoText, db, keys.length, remote]);

  const stats = useMemo(() => {
    const byType = { string: 0, hash: 0, list: 0, set: 0, zset: 0 };
    let withTtl = 0;
    for (const k of keys) {
      byType[k.type]++;
      if (k.ttl >= 0) withTtl++;
    }
    return { byType, withTtl, total: keys.length };
  }, [keys]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-bg p-3">
      <h2 className="text-[13px] font-semibold text-fg">Server info</h2>
      {profile && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
          <dt className="text-muted">Connection</dt>
          <dd className="font-medium text-fg">{profile.name}</dd>
          <dt className="text-muted">Endpoint</dt>
          <dd className="font-mono text-fg">
            {profile.host}:{profile.port}
          </dd>
          <dt className="text-muted">Mode</dt>
          <dd className="font-medium text-fg">{remote ? "redis-server (TCP)" : "demo engine"}</dd>
          <dt className="text-muted">Database</dt>
          <dd className="font-mono text-fg">db{db}</dd>
          <dt className="text-muted">Keys (filter)</dt>
          <dd className="font-mono tabular-nums text-fg">{stats.total}</dd>
          <dt className="text-muted">With TTL</dt>
          <dd className="font-mono tabular-nums text-fg">{stats.withTtl}</dd>
        </dl>
      )}

      <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Key types
      </h3>
      <div className="mt-2 space-y-1.5">
        {(Object.entries(stats.byType) as Array<[keyof typeof stats.byType, number]>).map(
          ([type, n]) => (
            <div key={type} className="flex items-center gap-2 text-[12px]">
              <span className="w-14 font-mono uppercase text-muted">{type}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-primary/80 transition-all"
                  style={{
                    width: stats.total ? `${(n / stats.total) * 100}%` : "0%",
                  }}
                />
              </div>
              <span className="w-6 text-right font-mono tabular-nums text-subtle">{n}</span>
            </div>
          ),
        )}
      </div>

      <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        INFO
      </h3>
      <pre className="mt-2 overflow-auto rounded-[var(--radius-md)] border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted">
        {infoText || (connected ? "Loading…" : "Not connected")}
      </pre>
    </div>
  );
}
