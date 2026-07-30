import { useEffect, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import {
  PanelLeft,
  Terminal,
  Info,
  KeyRound,
} from "lucide-react";
import { Toaster } from "sonner";
import { TitleBar } from "./TitleBar";
import { ConnectionSidebar } from "./ConnectionSidebar";
import { KeyBrowser } from "./KeyBrowser";
import { ValueEditor } from "./ValueEditor";
import { CliPanel } from "./CliPanel";
import { InfoPanel } from "./InfoPanel";
import { Button } from "@/components/ui/button";
import { useRedisStore } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

type MobilePane = "connections" | "keys" | "value" | "cli" | "info";

function RedisDesktopInner() {
  const connected = useRedisStore((s) => s.connected);
  const connect = useRedisStore((s) => s.connect);
  const profiles = useRedisStore((s) => s.profiles);
  const sidebarTab = useRedisStore((s) => s.sidebarTab);
  const setSidebarTab = useRedisStore((s) => s.setSidebarTab);
  const [connOpen, setConnOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>("connections");
  const [autoConnected, setAutoConnected] = useState(false);

  // Auto-connect: prefer real Local Redis in Electron, else demo
  useEffect(() => {
    if (autoConnected || connected) return;
    const isElectron = typeof window !== "undefined" && !!(window as unknown as { redisDesktop?: { isElectron?: boolean } }).redisDesktop?.isElectron;
    const preferred =
      (isElectron && profiles.find((p) => p.id === "embedded-redis")) ||
      (isElectron && profiles.find((p) => !p.demo)) ||
      profiles.find((p) => p.demo) ||
      profiles[0];
    if (preferred) {
      setAutoConnected(true);
      void connect(preferred.id);
    }
  }, [autoConnected, connected, profiles, connect]);

  useEffect(() => {
    if (connected && mobilePane === "connections") {
      setMobilePane("keys");
    }
  }, [connected, mobilePane]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <TitleBar />

      {/* Desktop / tablet layout */}
      <div className="hidden min-h-0 flex-1 md:flex">
        <div
          className={cn(
            "shrink-0 overflow-hidden transition-[width] duration-200",
            connOpen ? "w-56 md:w-60" : "w-0",
          )}
        >
          <div className="h-full w-56 md:w-60">
            <ConnectionSidebar />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border bg-surface px-2 py-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setConnOpen((v) => !v)}
              aria-label="Toggle connections"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
            <div className="ml-1 flex gap-0.5 rounded-[var(--radius-sm)] border border-border bg-bg p-0.5">
              {(
                [
                  ["keys", KeyRound, "Keys"],
                  ["cli", Terminal, "CLI"],
                  ["info", Info, "Info"],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSidebarTab(id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-2.5 py-1 text-[11px] font-medium transition-colors",
                    sidebarTab === id
                      ? "bg-surface-2 text-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            {!connected && (
              <span className="ml-2 text-[11px] text-warning">Not connected</span>
            )}
          </div>

          {!connected ? (
            <Welcome />
          ) : sidebarTab === "cli" ? (
            <div className="min-h-0 flex-1">
              <CliPanel compact />
            </div>
          ) : sidebarTab === "info" ? (
            <div className="min-h-0 flex-1">
              <InfoPanel />
            </div>
          ) : (
            <>
              <div className="flex min-h-0 flex-1">
                <div className="w-[min(100%,280px)] shrink-0 lg:w-72">
                  <KeyBrowser />
                </div>
                <div className="min-w-0 flex-1">
                  <ValueEditor />
                </div>
              </div>
              <CliPanel />
            </>
          )}
        </div>
      </div>

      {/* Mobile layout */}
      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobilePane === "connections" && <ConnectionSidebar />}
          {mobilePane === "keys" &&
            (connected ? <KeyBrowser /> : <Welcome />)}
          {mobilePane === "value" &&
            (connected ? <ValueEditor /> : <Welcome />)}
          {mobilePane === "cli" &&
            (connected ? <CliPanel compact /> : <Welcome />)}
          {mobilePane === "info" &&
            (connected ? <InfoPanel /> : <Welcome />)}
        </div>
        <nav className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
          {(
            [
              ["connections", ServerIcon, "Conn"],
              ["keys", KeyRound, "Keys"],
              ["value", ValueIcon, "Value"],
              ["cli", Terminal, "CLI"],
              ["info", Info, "Info"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMobilePane(id)}
              className={cn(
                "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium",
                mobilePane === id ? "text-primary" : "text-muted",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          className: "!bg-surface-2 !border-border !text-fg !text-[12px]",
        }}
      />
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-panel)]">
        <KeyRound className="h-5 w-5 text-primary" />
      </div>
      <div>
        <h1 className="text-[16px] font-semibold tracking-tight text-fg">
          Redis Desktop
        </h1>
        <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-muted">
          Connect to a profile on the left to browse keys, edit values, and run CLI commands.
          Sample data is ready in the Local Demo connection.
        </p>
      </div>
    </div>
  );
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="8" rx="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01M6 17h.01" />
    </svg>
  );
}

function ValueIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

export function RedisDesktop() {
  return (
    <ClientOnly
      fallback={
        <div className="flex h-dvh items-center justify-center bg-bg text-muted">
          Loading Redis Desktop…
        </div>
      }
    >
      <RedisDesktopInner />
    </ClientOnly>
  );
}
