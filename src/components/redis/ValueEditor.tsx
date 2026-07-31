import { useEffect, useState } from "react";
import {
  Clock,
  Copy,
  Pencil,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RedisType, RedisValue } from "@/lib/redis/engine";
import { useRedisStore } from "@/lib/redis/store";
import { cn } from "@/lib/utils";

export function ValueEditor() {
  const selectedKey = useRedisStore((s) => s.selectedKey);
  const selectedValue = useRedisStore((s) => s.selectedValue);
  const saveValue = useRedisStore((s) => s.saveValue);
  const deleteKeys = useRedisStore((s) => s.deleteKeys);
  const renameKey = useRedisStore((s) => s.renameKey);
  const setTtl = useRedisStore((s) => s.setTtl);

  const [draft, setDraft] = useState<RedisValue | null>(null);
  const [ttlDraft, setTtlDraft] = useState("-1");
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!selectedValue || !selectedKey) {
      setDraft(null);
      setDirty(false);
      return;
    }
    setDraft(structuredClone(selectedValue));
    setTtlDraft(selectedValue.ttl < 0 ? "-1" : String(selectedValue.ttl));
    setRenameDraft(selectedKey);
    setRenaming(false);
    setDirty(false);
  }, [selectedKey, selectedValue]);

  if (!selectedKey || !selectedValue || !draft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-6 py-8 shadow-[var(--shadow-panel)]">
          <p className="text-[14px] font-medium text-fg">No key selected</p>
          <p className="mt-1 max-w-xs text-[12px] text-muted">
            Pick a key from the browser, or create one. Values open here with type-aware editors.
          </p>
        </div>
      </div>
    );
  }

  const encoding =
    "encoding" in selectedValue
      ? String((selectedValue as { encoding?: string }).encoding || "raw")
      : draft.type === "string" &&
          typeof draft.value === "string" &&
          (draft.value.trimStart().startsWith("{") || draft.value.trimStart().startsWith("["))
        ? "json"
        : "raw";
  const isJavaSer = encoding === "java-serialized" || encoding === "binary";
  const isJson = encoding === "json";
  const readOnlyValue =
    isJavaSer ||
    !!("readOnly" in selectedValue && (selectedValue as { readOnly?: boolean }).readOnly);

  function markDirty(next: RedisValue) {
    setDraft(next);
    setDirty(true);
  }

  async function handleSave() {
    if (!draft || !selectedKey) return;
    if (readOnlyValue) {
      toast.error("Binary/Java-serialized value is read-only — editing would break Spring JDK deserialization");
      return;
    }
    const ttl = Number(ttlDraft);
    try {
      await saveValue(selectedKey, draft, Number.isFinite(ttl) ? ttl : -1);
      setDirty(false);
      toast.success("Key saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function handleRename() {
    if (!selectedKey || !renameDraft.trim() || renameDraft === selectedKey) {
      setRenaming(false);
      return;
    }
    try {
      const ok = await renameKey(selectedKey, renameDraft.trim());
      if (ok) {
        toast.success("Key renamed");
        setRenaming(false);
      } else {
        toast.error("Rename failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    }
  }

  function handleCopy() {
    const text =
      draft?.type === "string"
        ? draft.value
        : JSON.stringify(draft && "value" in draft ? draft.value : draft, null, 2);
    void navigator.clipboard.writeText(text ?? "");
    toast.success("Copied to clipboard");
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">

      {(isJavaSer || isJson) && (
        <div
          className={cn(
            "border-b px-3 py-2 text-[11px] leading-relaxed",
            isJavaSer
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-primary/30 bg-primary/10 text-fg",
          )}
        >
          {isJavaSer ? (
            <>
              <strong>Java serialized / binary</strong> (Spring Session uses JDK serialization).
              Shown as type preview + base64 — not as {"\uFFFD"} garbage.
              Read-only: editing would break Spring.
            </>
          ) : (
            <>
              <strong>JSON value</strong> detected. If Spring throws{" "}
              <code className="text-[10px]">StreamCorruptedException</code> / invalid stream header{" "}
              <code className="text-[10px]">7B2274</code>, the app is using JDK{" "}
              <code className="text-[10px]">DefaultDeserializer</code> instead of Jackson.
              Fix RedisTemplate serializers or run FLUSHDB and rewrite from Spring.
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Badge variant={selectedValue.type}>{selectedValue.type}</Badge>
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              handleRename();
            }}
          >
            <Input
              className="h-7 font-mono text-[12px]"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              autoFocus
            />
            <Button type="submit" size="sm">
              OK
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono text-[13px] font-medium text-fg hover:text-primary"
            onClick={() => setRenaming(true)}
            title="Click to rename"
          >
            {selectedKey}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-subtle" />
          <Input
            className="h-7 w-20 font-mono text-[12px]"
            value={ttlDraft}
            onChange={(e) => {
              setTtlDraft(e.target.value);
              setDirty(true);
            }}
            onBlur={() => {
              const n = Number(ttlDraft);
              if (Number.isFinite(n) && selectedKey) setTtl(selectedKey, n);
            }}
            title="TTL seconds (-1 = no expiry)"
          />
          <Button variant="ghost" size="icon-sm" onClick={handleCopy} aria-label="Copy">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setRenaming(true)} aria-label="Rename">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              deleteKeys([selectedKey]);
              toast.success("Key deleted");
            }}
            aria-label="Delete"
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!dirty || readOnlyValue}>
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {draft.type === "string" && (
          <StringEditor
            value={draft.value}
            onChange={(v) => markDirty({ type: "string", value: v })}
            readOnly={readOnlyValue}
          />
        )}
        {draft.type === "hash" && (
          <HashEditor
            value={draft.value}
            onChange={(v) => markDirty({ type: "hash", value: v })}
          />
        )}
        {draft.type === "list" && (
          <ListEditor
            value={draft.value}
            onChange={(v) => markDirty({ type: "list", value: v })}
          />
        )}
        {draft.type === "set" && (
          <SetEditor
            value={draft.value}
            onChange={(v) => markDirty({ type: "set", value: v })}
          />
        )}
        {draft.type === "zset" && (
          <ZSetEditor
            value={draft.value}
            onChange={(v) => markDirty({ type: "zset", value: v })}
          />
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-[10px] text-subtle">
        <span>encoding · {encodingLabel(selectedValue.type)}</span>
        <span>size · {sizeLabel(draft)}</span>
        <span className={cn(dirty && "text-warning")}>{dirty ? "unsaved changes" : "saved"}</span>
      </div>
    </div>
  );
}

function StringEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  const isJson = looksLikeJson(value);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Value
        </span>
        {isJson && !readOnly && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              try {
                onChange(JSON.stringify(JSON.parse(value), null, 2));
              } catch {
                /* ignore */
              }
            }}
          >
            Format JSON
          </Button>
        )}
      </div>
      <textarea
        readOnly={readOnly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-[280px] flex-1 resize-y rounded-[var(--radius-md)] border border-border bg-surface p-3 font-mono text-[12px] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:opacity-80"
      />
    </div>
  );
}

function HashEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const rows = Object.entries(value);
  return (
    <FieldTable
      headers={["Field", "Value"]}
      onAdd={() => onChange({ ...value, [`field_${rows.length + 1}`]: "" })}
    >
      {rows.map(([field, val], idx) => (
        <tr key={idx} className="border-b border-border/60">
          <td className="p-1">
            <Input
              className="font-mono text-[12px]"
              value={field}
              onChange={(e) => {
                const next: Record<string, string> = {};
                rows.forEach(([f, v], i) => {
                  if (i === idx) next[e.target.value] = v;
                  else next[f] = v;
                });
                onChange(next);
              }}
            />
          </td>
          <td className="p-1">
            <textarea
              className="min-h-[32px] w-full resize-y rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug text-fg"
              rows={String(val).includes("\n") || String(val).startsWith("[Java") || String(val).startsWith("[Binary") ? 5 : 1}
              value={val}
              readOnly={String(val).startsWith("[Java") || String(val).startsWith("[Binary")}
              onChange={(e) => onChange({ ...value, [field]: e.target.value })}
            />
          </td>
          <td className="w-8 p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                const next = { ...value };
                delete next[field];
                onChange(next);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </td>
        </tr>
      ))}
    </FieldTable>
  );
}

function ListEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <FieldTable headers={["#", "Element"]} onAdd={() => onChange([...value, ""])}>
      {value.map((item, idx) => (
        <tr key={idx} className="border-b border-border/60">
          <td className="w-10 px-2 py-1 font-mono text-[11px] tabular-nums text-subtle">
            {idx}
          </td>
          <td className="p-1">
            <textarea
              className="min-h-[32px] w-full resize-y rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug text-fg"
              rows={String(item).includes("\n") || String(item).startsWith("[Java") || String(item).startsWith("[Binary") ? 4 : 1}
              value={item}
              readOnly={String(item).startsWith("[Java") || String(item).startsWith("[Binary")}
              onChange={(e) => {
                const next = [...value];
                next[idx] = e.target.value;
                onChange(next);
              }}
            />
          </td>
          <td className="w-8 p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </td>
        </tr>
      ))}
    </FieldTable>
  );
}

function SetEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <FieldTable headers={["Member"]} onAdd={() => onChange([...value, `member_${value.length + 1}`])}>
      {value.map((item, idx) => (
        <tr key={idx} className="border-b border-border/60">
          <td className="p-1">
            <textarea
              className="min-h-[32px] w-full resize-y rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug text-fg"
              rows={String(item).includes("\n") || String(item).startsWith("[Java") || String(item).startsWith("[Binary") ? 4 : 1}
              value={item}
              readOnly={String(item).startsWith("[Java") || String(item).startsWith("[Binary")}
              onChange={(e) => {
                const next = [...value];
                next[idx] = e.target.value;
                onChange(next);
              }}
            />
          </td>
          <td className="w-8 p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </td>
        </tr>
      ))}
    </FieldTable>
  );
}

function ZSetEditor({
  value,
  onChange,
}: {
  value: Array<{ member: string; score: number }>;
  onChange: (v: Array<{ member: string; score: number }>) => void;
}) {
  return (
    <FieldTable
      headers={["Score", "Member"]}
      onAdd={() => onChange([...value, { member: `m_${value.length + 1}`, score: 0 }])}
    >
      {value.map((item, idx) => (
        <tr key={idx} className="border-b border-border/60">
          <td className="w-28 p-1">
            <Input
              className="font-mono text-[12px]"
              type="number"
              value={item.score}
              onChange={(e) => {
                const next = [...value];
                next[idx] = { ...item, score: Number(e.target.value) };
                onChange(next);
              }}
            />
          </td>
          <td className="p-1">
            <Input
              className="font-mono text-[12px]"
              value={item.member}
              onChange={(e) => {
                const next = [...value];
                next[idx] = { ...item, member: e.target.value };
                onChange(next);
              }}
            />
          </td>
          <td className="w-8 p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </td>
        </tr>
      ))}
    </FieldTable>
  );
}

function FieldTable({
  headers,
  children,
  onAdd,
}: {
  headers: string[];
  children: React.ReactNode;
  onAdd: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-border bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wide text-muted">
            {headers.map((h) => (
              <th key={h} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      <div className="border-t border-border p-2">
        <Button size="sm" variant="secondary" onClick={onAdd}>
          Add row
        </Button>
      </div>
    </div>
  );
}

function looksLikeJson(s: string) {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function encodingLabel(type: RedisType) {
  switch (type) {
    case "string":
      return "raw";
    case "hash":
      return "hashtable";
    case "list":
      return "quicklist";
    case "set":
      return "hashtable";
    case "zset":
      return "skiplist";
  }
}

function sizeLabel(v: RedisValue) {
  switch (v.type) {
    case "string":
      return `${v.value.length} bytes`;
    case "hash":
      return `${Object.keys(v.value).length} fields`;
    case "list":
      return `${v.value.length} elements`;
    case "set":
      return `${v.value.length} members`;
    case "zset":
      return `${v.value.length} members`;
  }
}
