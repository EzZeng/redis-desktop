import { toast } from "sonner";
import { useMemo, useState } from "react";
import {
  Clock,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RedisType } from "@/lib/redis/engine";
import { useRedisStore } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

const TYPES: RedisType[] = ["string", "hash", "list", "set", "zset"];

export function KeyBrowser() {
  const keys = useRedisStore((s) => s.keys);
  const filter = useRedisStore((s) => s.filter);
  const setFilter = useRedisStore((s) => s.setFilter);
  const selectedKey = useRedisStore((s) => s.selectedKey);
  const selectKey = useRedisStore((s) => s.selectKey);
  const refreshKeys = useRedisStore((s) => s.refreshKeys);
  const deleteKeys = useRedisStore((s) => s.deleteKeys);
  const createKey = useRedisStore((s) => s.createKey);
  const db = useRedisStore((s) => s.db);
  const selectDb = useRedisStore((s) => s.selectDb);
  const flushDb = useRedisStore((s) => s.flushDb);
  const [draftFilter, setDraftFilter] = useState(filter);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<RedisType>("string");
  const [typeFilter, setTypeFilter] = useState<RedisType | "all">("all");

  const visible = useMemo(() => {
    if (typeFilter === "all") return keys;
    return keys.filter((k) => k.type === typeFilter);
  }, [keys, typeFilter]);

  function applyFilter() {
    setFilter(draftFilter.trim() || "*");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKey.trim()) return;
    try {
      createKey(newKey.trim(), newType);
      setShowCreate(false);
      setNewKey("");
    } catch {
      // ignore duplicate
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-bg">
      <div className="space-y-2 border-b border-border p-2.5">
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] font-medium text-muted">DB</label>
          <select
            value={db}
            onChange={(e) => selectDb(Number(e.target.value))}
            className="h-7 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 font-mono text-[12px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-subtle">
            {visible.length} keys
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-[10px] text-danger"
            title="Delete all keys in current DB (fixes mixed Spring serializers)"
            onClick={() => {
              if (window.confirm("FLUSHDB — delete ALL keys in this database?")) {
                void flushDb().then(() => { try { toast.success("Database flushed"); } catch { /* ignore */ } });
              }
            }}
          >
            FLUSHDB
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void refreshKeys()} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowCreate((v) => !v)}
            aria-label="Add key"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input
              className="pl-7 font-mono text-[12px]"
              value={draftFilter}
              onChange={(e) => setDraftFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilter();
              }}
              placeholder="KEYS pattern *"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={applyFilter}>
            Go
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          <TypeChip active={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
            all
          </TypeChip>
          {TYPES.map((t) => (
            <TypeChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)} type={t}>
              {t}
            </TypeChip>
          ))}
        </div>
        {showCreate && (
          <form onSubmit={handleCreate} className="space-y-1.5 rounded-[var(--radius-md)] border border-border bg-surface p-2">
            <Input
              className="font-mono text-[12px]"
              placeholder="new:key:name"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoFocus
            />
            <div className="flex gap-1.5">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as RedisType)}
                className="h-7 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-1.5 text-[12px]"
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm">
                Create
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-subtle">
            No keys match this filter.
          </div>
        ) : (
          <ul className="py-1">
            {visible.map((k) => (
              <li key={k.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectKey(k.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectKey(k.key);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
                    selectedKey === k.key
                      ? "bg-surface-2"
                      : "hover:bg-surface/80",
                  )}
                >
                  <Badge variant={k.type}>{k.type}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                    {k.key}
                  </span>
                  {k.ttl >= 0 && (
                    <span className="inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums text-warning">
                      <Clock className="h-2.5 w-2.5" />
                      {formatTtl(k.ttl)}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "h-6 w-6 shrink-0",
                      selectedKey === k.key ? "opacity-100" : "opacity-70 hover:opacity-100",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteKeys([k.key]);
                    }}
                    aria-label={`Delete ${k.key}`}
                  >
                    <Trash2 className="h-3 w-3 text-subtle hover:text-danger" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  children,
  active,
  onClick,
  type,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  type?: RedisType;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
        active
          ? "border-border-strong bg-surface-3 text-fg"
          : "border-border bg-transparent text-subtle hover:text-muted",
      )}
    >
      {type ? <Badge variant={type} className="border-0 bg-transparent p-0">{children}</Badge> : children}
    </button>
  );
}

function formatTtl(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
