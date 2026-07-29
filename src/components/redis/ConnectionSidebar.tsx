import { useState } from "react";
import {
  Cable,
  ChevronRight,
  Database,
  Loader2,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRedisStore, type ConnectionProfile } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

export function ConnectionSidebar() {
  const profiles = useRedisStore((s) => s.profiles);
  const activeProfileId = useRedisStore((s) => s.activeProfileId);
  const connected = useRedisStore((s) => s.connected);
  const connecting = useRedisStore((s) => s.connecting);
  const connect = useRedisStore((s) => s.connect);
  const disconnect = useRedisStore((s) => s.disconnect);
  const addProfile = useRedisStore((s) => s.addProfile);
  const removeProfile = useRedisStore((s) => s.removeProfile);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    host: "127.0.0.1",
    port: "6379",
    username: "",
    password: "",
  });

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.host.trim()) return;
    const id = addProfile({
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port) || 6379,
      username: form.username,
      password: form.password,
      demo: true,
      color: pickColor(form.name),
    });
    setShowForm(false);
    setForm({ name: "", host: "127.0.0.1", port: "6379", username: "", password: "" });
    void connect(id);
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-surface sm:w-56 md:w-60">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
          <Server className="h-3.5 w-3.5" />
          Connections
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowForm((v) => !v)}
          aria-label="Add connection"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="space-y-2 border-b border-border p-3">
          <Input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="Host"
              value={form.host}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
            />
            <Input
              className="w-16"
              placeholder="Port"
              value={form.port}
              onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            />
          </div>
          <Input
            placeholder="Username (optional)"
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          />
          <Input
            type="password"
            placeholder="Password (optional)"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
          <p className="text-[10px] leading-snug text-subtle">
            Runs against the built-in demo engine in this preview (no real TCP).
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="flex-1">
              Save & Connect
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {profiles.map((p) => (
          <ConnectionRow
            key={p.id}
            profile={p}
            active={activeProfileId === p.id && connected}
            connecting={connecting && activeProfileId === p.id}
            onConnect={() => void connect(p.id)}
            onDisconnect={disconnect}
            onRemove={() => removeProfile(p.id)}
          />
        ))}
      </div>

      <div className="border-t border-border px-3 py-2 text-[10px] text-subtle">
        Redis Desktop · Electron-style client
      </div>
    </aside>
  );
}

function ConnectionRow({
  profile,
  active,
  connecting,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  profile: ConnectionProfile;
  active: boolean;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group mb-1 rounded-[var(--radius-md)] border border-transparent px-2 py-2 transition-colors",
        active
          ? "border-border bg-surface-2"
          : "hover:border-border/60 hover:bg-surface-2/60",
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => (active ? onDisconnect() : onConnect())}
      >
        <span
          className="mt-1 h-2 w-2 shrink-0 rounded-full"
          style={{ background: profile.color }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[13px] font-medium text-fg">
            {connecting ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted" />
            ) : active ? (
              <Cable className="h-3 w-3 text-success" />
            ) : (
              <Database className="h-3 w-3 text-subtle" />
            )}
            <span className="truncate">{profile.name}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-subtle">
            {profile.host}:{profile.port}
          </span>
        </span>
        <ChevronRight
          className={cn(
            "mt-1 h-3.5 w-3.5 shrink-0 text-subtle transition-transform",
            active && "rotate-90 text-muted",
          )}
        />
      </button>
      <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="sm"
          variant={active ? "secondary" : "default"}
          className="h-6 flex-1 text-[11px]"
          onClick={() => (active ? onDisconnect() : onConnect())}
          disabled={connecting}
        >
          {connecting ? "Connecting…" : active ? "Disconnect" : "Connect"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="h-6 w-6 text-subtle hover:text-danger"
          onClick={onRemove}
          aria-label="Remove connection"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function pickColor(name: string) {
  const colors = ["#dc382d", "#3b82f6", "#3d9a6a", "#c4922a", "#4a8fd4", "#d46b8a"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i) * 17) % colors.length;
  return colors[h]!;
}
