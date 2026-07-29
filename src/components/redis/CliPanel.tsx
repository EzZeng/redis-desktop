import { useEffect, useRef, useState } from "react";
import { Eraser, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRedisStore } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

export function CliPanel({ compact = false }: { compact?: boolean }) {
  const history = useRedisStore((s) => s.cliHistory);
  const cmdHistory = useRedisStore((s) => s.cliCmdHistory);
  const runCli = useRedisStore((s) => s.runCli);
  const clearCli = useRedisStore((s) => s.clearCli);
  const db = useRedisStore((s) => s.db);
  const connected = useRedisStore((s) => s.connected);
  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  function submit() {
    if (!input.trim()) return;
    runCli(input);
    setInput("");
    setHistIdx(-1);
  }

  return (
    <div
      className={cn(
        "flex flex-col border-t border-border bg-cli-bg",
        compact ? "h-full border-t-0" : "h-48 shrink-0 md:h-56",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Terminal className="h-3.5 w-3.5 text-muted" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          CLI
        </span>
        <span className="font-mono text-[10px] text-subtle">db{db}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={clearCli}
          aria-label="Clear CLI"
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        {history.map((line) => (
          <div
            key={line.id}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.kind === "in" && "text-cli-in",
              line.kind === "out" && "text-cli-out",
              line.kind === "err" && "text-cli-err",
              line.kind === "sys" && "text-cli-sys",
            )}
          >
            {line.kind === "in" ? `> ${line.text}` : line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
        <span className="font-mono text-[12px] text-primary">{connected ? ">" : "#"}</span>
        <input
          ref={inputRef}
          value={input}
          disabled={!connected}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.min(histIdx + 1, cmdHistory.length - 1);
              if (cmdHistory[next]) {
                setHistIdx(next);
                setInput(cmdHistory[next]!);
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = histIdx - 1;
              if (next < 0) {
                setHistIdx(-1);
                setInput("");
              } else {
                setHistIdx(next);
                setInput(cmdHistory[next] ?? "");
              }
            }
          }}
          placeholder={connected ? "GET key  ·  HELP" : "Connect to run commands"}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg placeholder:text-subtle focus:outline-none"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    </div>
  );
}
