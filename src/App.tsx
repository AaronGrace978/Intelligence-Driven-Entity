import { useCallback, useEffect, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import ModelPicker from "./components/ModelPicker";
import SettingsPanel from "./components/SettingsPanel";
import EntityStage from "./entity/EntityStage";
import DeckKeyboard, { watchDeckField } from "./components/DeckKeyboard";
import PadHints from "./components/PadHints";
import {
  cancelStream,
  chatStream,
  getPreferences,
  getProviders,
  inTauri,
  listModels,
  onGamepad,
  savePreferences,
  SIMULATOR,
  type DeckStatus,
} from "./lib/api";
import { budget, setLightGraphics } from "./lib/budget";
import { feedPad, watchPointer } from "./lib/pad";
import { signal } from "./lib/signal";
import type { ChatMessage, ModelList, Preferences, ProviderInfo, StreamEvent } from "./lib/types";

const CONVO_KEY = "entity.conversation";
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadConversation(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CONVO_KEY);
    const list: ChatMessage[] = raw ? JSON.parse(raw) : [];
    return list.map((m) => (m.status === "streaming" ? { ...m, status: "cancelled" } : m));
  } catch {
    return [];
  }
}

export default function App({ platform }: { platform: DeckStatus }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([SIMULATOR]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(loadConversation);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pending = useRef<{ id: string; content: string; reasoning: string } | null>(null);
  const flushHandle = useRef(0);

  const deck = platform.deck;
  const [lightGraphics, setLightGraphicsOn] = useState(deck && budget.light);

  useEffect(() => (deck ? watchDeckField() : undefined), [deck]);

  useEffect(() => {
    if (!platform.controller) return;
    const stopPointer = watchPointer();
    let stopPad = () => {};
    let alive = true;
    onGamepad(feedPad)
      .then((unlisten) => {
        if (alive) stopPad = unlisten;
        else unlisten();
      })
      .catch((e) => console.error(e));
    return () => {
      alive = false;
      stopPointer();
      stopPad();
    };
  }, [platform.controller]);

  useEffect(() => {
    (async () => {
      const [list, p] = await Promise.all([getProviders(), getPreferences()]);
      setProviders(list);
      const provider = list.find((x) => x.id === p.provider) ?? list.find((x) => x.ready && x.wire !== "simulator") ?? SIMULATOR;
      setPrefs({ ...p, provider: provider.id, model: provider.id === p.provider ? p.model : null });
    })().catch((e) => console.error(e));
  }, []);

  useEffect(() => {
    if (prefs) savePreferences(prefs).catch((e) => console.error(e));
  }, [prefs]);

  useEffect(() => {
    if (!messages.some((m) => m.status === "streaming")) localStorage.setItem(CONVO_KEY, JSON.stringify(messages));
  }, [messages]);

  const refreshModels = useCallback(async (provider: string) => {
    setModelsLoading(true);
    setModels(null);
    try {
      const list = await listModels(provider);
      setModels(list);
      setPrefs((p) => {
        if (!p || p.provider !== provider) return p;
        if (p.model && (list.models.some((m) => m.id === p.model) || !list.live)) return p;
        return { ...p, model: list.models[0]?.id ?? p.model };
      });
    } catch (e) {
      setModels({ models: [], live: false, error: String(e) });
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const providerId = prefs?.provider ?? null;
  useEffect(() => {
    if (providerId) refreshModels(providerId);
  }, [providerId, refreshModels]);

  const patch = (id: string, f: (m: ChatMessage) => ChatMessage) => setMessages((list) => list.map((m) => (m.id === id ? f(m) : m)));

  const flush = () => {
    flushHandle.current = 0;
    const p = pending.current;
    if (!p || (!p.content && !p.reasoning)) return;
    const { id, content, reasoning } = p;
    p.content = "";
    p.reasoning = "";
    patch(id, (m) => ({ ...m, content: m.content + content, reasoning: reasoning ? (m.reasoning ?? "") + reasoning : m.reasoning }));
  };

  const send = async (text: string) => {
    if (!prefs?.provider || !prefs.model || streamId) return;
    const provider = prefs.provider;
    const model = prefs.model;
    const user: ChatMessage = { id: uid(), role: "user", content: text };
    let history = [...messages, user]
      .filter((m) => m.content && (m.role === "user" || m.status === "done"))
      .map((m) => ({ role: m.role, content: m.content }));
    const firstReply: ChatMessage = { id: uid(), role: "assistant", content: "", provider, model, status: "streaming" };
    setMessages((list) => [...list, user, firstReply]);

    const replyId = firstReply.id;
    const sid = uid();
    setStreamId(sid);
    pending.current = { id: replyId, content: "", reasoning: "" };
    let tokens = 0;

    const onEvent = (e: StreamEvent) => {
      signal.ingest(e);
      const p = pending.current!;
      switch (e.type) {
        case "delta":
          p.content += e.content;
          if (!flushHandle.current) flushHandle.current = requestAnimationFrame(flush);
          break;
        case "reasoning":
          p.reasoning += e.content;
          if (!flushHandle.current) flushHandle.current = requestAnimationFrame(flush);
          break;
        case "telemetry":
          tokens = e.tokens;
          break;
        case "done":
          flush();
          patch(replyId, (m) => ({
            ...m,
            status: "done",
            stats: { tokens: e.tokens, tps: e.avgTokensPerSecond, confidence: e.confidence, elapsedMs: e.elapsedMs },
          }));
          break;
        case "error":
          flush();
          patch(replyId, (m) => ({ ...m, status: "error", error: e.message }));
          break;
        case "cancelled":
          flush();
          patch(replyId, (m) => ({ ...m, status: "cancelled" }));
          break;
      }
    };

    try {
      await chatStream({ streamId: sid, provider, model, system: prefs.systemPrompt || null, messages: history }, onEvent);
    } catch (e) {
      onEvent({ type: "error", message: String(e), status: null });
    } finally {
      flush();
      setMessages((list) =>
        list.map((m) => (m.id === replyId && m.status === "streaming" ? { ...m, status: tokens ? "done" : "cancelled" } : m)),
      );
      pending.current = null;
      setStreamId(null);
    }
  };

  const stop = () => {
    if (streamId) cancelStream(streamId).catch((e) => console.error(e));
  };

  const current = providers.find((p) => p.id === prefs?.provider) ?? null;
  let hint: string | null = null;
  if (current && !current.ready) {
    hint = `${current.label} needs an API key — open CONFIG${current.envKey ? ` or set $${current.envKey}` : ""}.`;
  } else if (!inTauri && current?.id !== SIMULATOR.id) {
    hint = "Browser preview: only the offline simulator can transmit.";
  }

  return (
    <div className={["app", deck && "is-deck", deck && lightGraphics && "is-lite", platform.gameMode && "is-game-mode"].filter(Boolean).join(" ")}>
      <div className="crt" aria-hidden />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span className="brand-name glitch" data-text="THE ENTITY">
            THE ENTITY
          </span>
          <span className="brand-sub">multi-model neural interface</span>
        </div>
        <ModelPicker
          providers={providers}
          provider={prefs?.provider ?? null}
          model={prefs?.model ?? null}
          models={models}
          loading={modelsLoading}
          onProvider={(id) => setPrefs((p) => (p ? { ...p, provider: id, model: null } : p))}
          onModel={(id) => setPrefs((p) => (p ? { ...p, model: id } : p))}
          onRefresh={() => providerId && refreshModels(providerId)}
        />
        <button className="config-button" onClick={() => setSettingsOpen(true)}>
          CONFIG
        </button>
      </header>

      <main className="layout">
        <EntityStage
          renderer={prefs?.renderer ?? "shader"}
          onRenderer={(r) => setPrefs((p) => (p ? { ...p, renderer: r } : p))}
          providerLabel={current?.label ?? "—"}
          model={prefs?.model ?? null}
          lightGraphics={deck ? lightGraphics : undefined}
          onToggleGraphics={
            deck
              ? () => {
                  const next = !budget.light;
                  setLightGraphics(next);
                  setLightGraphicsOn(next);
                }
              : undefined
          }
        />
        <ChatPanel
          messages={messages}
          streaming={!!streamId}
          canSend={!!prefs?.model && !!current?.ready}
          hint={hint}
          onSend={send}
          onStop={stop}
          onClear={() => setMessages([])}
        />
      </main>

      {deck && <DeckKeyboard />}
      {platform.controller && <PadHints />}

      {settingsOpen && prefs && (
        <SettingsPanel
          providers={providers}
          systemPrompt={prefs.systemPrompt}
          onSystemPrompt={(s) => setPrefs((p) => (p ? { ...p, systemPrompt: s } : p))}
          onProviders={(list) => {
            setProviders(list);
            if (providerId) refreshModels(providerId);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
