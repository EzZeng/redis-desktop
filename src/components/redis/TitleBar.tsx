import { Database, Minus, Square, X } from "lucide-react";
import { useRedisStore } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

export function TitleBar() {
  const connected = useRedisStore((s) => s.connected);
  const profiles = useRedisStore((s) => s.profiles);
  const activeProfileId = useRedisStore((s) => s.activeProfileId);
  const profile = profiles.find((p) => p.id === activeProfileId);

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-border bg-titlebar select-none">
      <div className="flex w-20 items-center gap-1.5 px-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" title="Close" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" title="Minimize" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" title="Maximize" />
      </div>
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Database className="h-3.5 w-3.5 text-primary" />
        <span className="text-[12px] font-medium tracking-tight text-fg">
          Redis Desktop
        </span>
        {connected && profile && (
          <>
            <span className="text-subtle">—</span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: profile.color }}
              />
              {profile.name}
              <span className="text-subtle">
                {profile.host}:{profile.port}
              </span>
            </span>
          </>
        )}
      </div>
      <div className="hidden w-20 items-center justify-end gap-0.5 px-2 text-subtle sm:flex">
        <button type="button" className="rounded p-1 hover:bg-surface-2" aria-label="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-surface-2" aria-label="Maximize">
          <Square className="h-3 w-3" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-danger/20 hover:text-danger" aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className={cn("sm:hidden w-3")} />
    </header>
  );
}
