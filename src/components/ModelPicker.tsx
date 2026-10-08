import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelList, ProviderInfo } from "../lib/types";

export default function ModelPicker({
  providers,
  provider,
  model,
  models,
  loading,
  onProvider,
  onModel,
  onRefresh,
}: {
  providers: ProviderInfo[];
  provider: string | null;
  model: string | null;
  models: ModelList | null;
  loading: boolean;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    input.current?.focus();
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models?.models ?? [];
    return q ? list.filter((m) => m.id.toLowerCase().includes(q) || m.label?.toLowerCase().includes(q)) : list;
  }, [models, query]);

  const current = providers.find((p) => p.id === provider);
  const pick = (id: string) => {
    onModel(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="picker" ref={root}>
      <label className="select">
        <span className="select-label">LINK</span>
        <select value={provider ?? ""} onChange={(e) => onProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.ready ? "● " : "○ "}
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <button className={`model-button ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} disabled={!current}>
        <span className="select-label">MODEL</span>
        <span className="model-name">{model ?? (loading ? "scanning…" : "select a model")}</span>
        <span className="chev">▾</span>
      </button>

      {open && (
        <div className="model-menu">
          <div className="model-menu-head">
            <input
              ref={input}
              value={query}
              placeholder="filter or type a model id…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (filtered[0] && filtered[0].id.toLowerCase() === query.trim().toLowerCase()) pick(filtered[0].id);
                  else if (filtered.length === 1) pick(filtered[0].id);
                  else if (query.trim()) pick(query.trim());
                }
                if (e.key === "Escape") setOpen(false);
              }}
            />
            <button className="ghost" onClick={onRefresh} title="Re-scan models">
              ↻
            </button>
          </div>
          <div className="model-menu-status">
            {loading ? (
              <span>SCANNING {current?.label.toUpperCase()}…</span>
            ) : models ? (
              <>
                <span className={`badge ${models.live ? "live" : "fallback"}`}>{models.live ? "LIVE" : "FALLBACK"}</span>
                <span>{models.models.length} models</span>
                {models.error && <span className="menu-error" title={models.error}>{models.error}</span>}
              </>
            ) : null}
          </div>
          <ul className="model-list">
            {filtered.map((m) => (
              <li key={m.id}>
                <button className={m.id === model ? "on" : ""} onClick={() => pick(m.id)}>
                  <span>{m.id}</span>
                  {m.label && <em>{m.label}</em>}
                </button>
              </li>
            ))}
            {!loading && query.trim() && !filtered.some((m) => m.id === query.trim()) && (
              <li>
                <button onClick={() => pick(query.trim())}>
                  <span>use “{query.trim()}”</span>
                  <em>custom id</em>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
