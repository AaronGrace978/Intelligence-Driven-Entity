import { useState } from "react";
import { inTauri, setProviderConfig } from "../lib/api";
import type { ProviderInfo } from "../lib/types";

function ProviderRow({ p, onSaved }: { p: ProviderInfo; onSaved: (list: ProviderInfo[]) => void }) {
  const [key, setKey] = useState("");
  const [base, setBase] = useState(p.baseUrl === p.defaultBaseUrl ? "" : p.baseUrl);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const save = async (clearKey = false) => {
    setBusy(true);
    setNote(null);
    try {
      const list = await setProviderConfig(p.id, clearKey ? "" : key || null, base);
      setKey("");
      onSaved(list);
      setNote(clearKey ? "key cleared" : "saved");
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const status = p.keySource === "settings" ? "STORED KEY" : p.keySource === "env" ? `ENV ${p.envKey}` : p.requiresKey ? "NO KEY" : "OPEN";

  return (
    <div className={`provider-row ${p.ready ? "ready" : ""}`}>
      <div className="provider-row-head">
        <strong>{p.label}</strong>
        <span className={`badge ${p.ready ? "live" : "fallback"}`}>{status}</span>
      </div>
      <div className="provider-fields">
        {p.requiresKey || p.id === "custom" ? (
          <input
            type="password"
            autoComplete="off"
            placeholder={p.keySource ? "•••••••• (replace key)" : `API key${p.envKey ? ` or $${p.envKey}` : ""}`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        ) : null}
        <input placeholder={p.defaultBaseUrl} value={base} onChange={(e) => setBase(e.target.value)} />
        <div className="provider-actions">
          <button disabled={busy} onClick={() => save()}>
            SAVE
          </button>
          {p.keySource === "settings" && (
            <button className="ghost" disabled={busy} onClick={() => save(true)}>
              CLEAR KEY
            </button>
          )}
          {note && <span className="note">{note}</span>}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPanel({
  providers,
  systemPrompt,
  onSystemPrompt,
  onProviders,
  onClose,
}: {
  providers: ProviderInfo[];
  systemPrompt: string;
  onSystemPrompt: (s: string) => void;
  onProviders: (list: ProviderInfo[]) => void;
  onClose: () => void;
}) {
  const real = providers.filter((p) => p.wire !== "simulator");
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="hud-kicker">CONFIGURATION</div>
            <h2>Neural links</h2>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <section className="drawer-section">
          <div className="hud-kicker">SYSTEM DIRECTIVE</div>
          <textarea rows={4} value={systemPrompt} onChange={(e) => onSystemPrompt(e.target.value)} />
        </section>

        <section className="drawer-section">
          <div className="hud-kicker">PROVIDERS</div>
          {!inTauri ? (
            <p className="muted">
              Running in a plain browser. Provider keys and real models are available in the desktop app (<code>pnpm tauri dev</code>). The
              offline simulator works here.
            </p>
          ) : (
            <>
              <p className="muted">
                Keys are stored by the Rust backend in your app config directory (file mode 600) and never sent back to the UI. Environment
                variables are used when no key is stored.
              </p>
              {real.map((p) => (
                <ProviderRow key={p.id} p={p} onSaved={onProviders} />
              ))}
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
