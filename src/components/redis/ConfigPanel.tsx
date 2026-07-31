import { useEffect, useState } from "react";
import { FileCode2, FolderOpen, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getRedisBridge, isElectronRuntime } from "@/lib/redis/remote";
import { useRedisStore } from "@/lib/redis/store";

export function ConfigPanel() {
  const connect = useRedisStore((s) => s.connect);
  const activeProfileId = useRedisStore((s) => s.activeProfileId);
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const electron = isElectronRuntime();

  async function load() {
    const bridge = getRedisBridge();
    if (!bridge?.confGet) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await bridge.confGet();
      if (res.ok) {
        setText(res.text);
        setPath(res.path);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleSave() {
    const bridge = getRedisBridge();
    if (!bridge?.confSet) return;
    setSaving(true);
    try {
      const res = await bridge.confSet({ text });
      if (!res.ok) {
        toast.error(res.error || "Failed to save redis.conf");
        return;
      }
      toast.success(
        res.restarted
          ? "redis.conf saved — server restarted"
          : "redis.conf saved",
      );
      if (res.status?.port && activeProfileId === "embedded-redis") {
        // reconnect to possibly new port
        await connect("embedded-redis");
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function openDir() {
    const bridge = getRedisBridge();
    await bridge?.confOpenDir?.();
  }

  if (!electron) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg p-6 text-center">
        <FileCode2 className="h-8 w-8 text-muted" />
        <p className="text-[13px] font-medium text-fg">redis.conf</p>
        <p className="max-w-sm text-[12px] text-muted">
          Config editing is available in the desktop app where the embedded
          redis-server runs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <FileCode2 className="h-3.5 w-3.5 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-fg">redis.conf</div>
          <div className="truncate font-mono text-[10px] text-subtle" title={path}>
            {path || "…"}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void openDir()}>
          <FolderOpen className="mr-1 h-3.5 w-3.5" />
          Folder
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reload
        </Button>
        <Button size="sm" disabled={saving || loading} onClick={() => void handleSave()}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save & apply"}
        </Button>
      </div>
      <p className="border-b border-border px-3 py-2 text-[11px] text-muted">
        Full <code className="text-fg">redis.conf</code> for the bundled{" "}
        <strong className="text-fg">redis-server.exe</strong> (redis-windows 8.x). Same directives
        as Redis on Linux/Windows: bind, port, requirepass, maxmemory, save, appendonly, modules,
        etc. Saving restarts the server process.
      </p>
      <textarea
        className="min-h-0 flex-1 resize-none bg-cli-bg p-3 font-mono text-[12px] leading-relaxed text-cli-out outline-none"
        spellCheck={false}
        value={loading ? "# Loading…" : text}
        onChange={(e) => setText(e.target.value)}
        disabled={loading}
      />
    </div>
  );
}
