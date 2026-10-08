import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { simulateStream } from "./simulator";
import type { ModelList, PadEvent, Preferences, ProviderInfo, StreamEvent } from "./types";

export const inTauri = isTauri();

export interface DeckStatus {
  deck: boolean;
  gameMode: boolean;
  /** The backend reads controllers and forwards them as `gamepad` events. */
  controller: boolean;
}

export const DESKTOP_STATUS: DeckStatus = { deck: false, gameMode: false, controller: false };

export async function deckStatus(): Promise<DeckStatus> {
  if (!inTauri) {
    const query = new URLSearchParams(window.location.search);
    const deck = query.get("deck") === "1";
    const gameMode = deck && query.get("game") === "1";
    return { deck, gameMode, controller: gameMode };
  }
  return invoke<DeckStatus>("deck_status");
}

export async function onGamepad(handler: (e: PadEvent) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  return listen<PadEvent>("gamepad", (e) => handler(e.payload));
}

export async function showDeckKeyboard(): Promise<void> {
  if (!inTauri) return;
  await invoke("show_deck_keyboard");
}

export const SIMULATOR: ProviderInfo = {
  id: "simulator",
  label: "Simulator (offline)",
  wire: "simulator",
  baseUrl: "local://simulator",
  defaultBaseUrl: "local://simulator",
  envKey: null,
  requiresKey: false,
  keySource: null,
  ready: true,
};

const DEFAULT_PREFS: Preferences = {
  provider: null,
  model: null,
  renderer: "shader",
  systemPrompt:
    "You are THE ENTITY: a sharp, concise, slightly uncanny AI living inside a terminal. Answer precisely. Use markdown and fenced code blocks when useful.",
};

const PREFS_KEY = "entity.preferences";

export async function getProviders(): Promise<ProviderInfo[]> {
  if (!inTauri) return [SIMULATOR];
  const list = await invoke<ProviderInfo[]>("get_providers");
  return [...list, SIMULATOR];
}

export async function setProviderConfig(
  id: string,
  apiKey: string | null,
  baseUrl: string | null,
): Promise<ProviderInfo[]> {
  const list = await invoke<ProviderInfo[]>("set_provider_config", { id, apiKey, baseUrl });
  return [...list, SIMULATOR];
}

export async function getPreferences(): Promise<Preferences> {
  if (!inTauri) {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  }
  return { ...DEFAULT_PREFS, ...(await invoke<Preferences>("get_preferences")) };
}

export async function savePreferences(preferences: Preferences): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    return;
  }
  await invoke("save_preferences", { preferences });
}

export async function listModels(provider: string): Promise<ModelList> {
  if (provider === SIMULATOR.id) {
    return { models: [{ id: "entity-sim-1", label: "Entity Simulator", created: null }], live: true, error: null };
  }
  return invoke<ModelList>("list_models", { provider });
}

export interface StreamRequest {
  streamId: string;
  provider: string;
  model: string;
  system: string | null;
  messages: { role: string; content: string }[];
}

const simAborts = new Map<string, AbortController>();

export async function chatStream(req: StreamRequest, onEvent: (e: StreamEvent) => void) {
  if (req.provider === SIMULATOR.id) {
    const ctrl = new AbortController();
    simAborts.set(req.streamId, ctrl);
    const last = req.messages.filter((m) => m.role === "user").pop()?.content ?? "";
    try {
      await simulateStream(last, onEvent, ctrl.signal);
    } finally {
      simAborts.delete(req.streamId);
    }
    return;
  }
  if (!inTauri) {
    onEvent({ type: "error", message: "Real providers need the desktop app (pnpm tauri dev).", status: null });
    return;
  }
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  await invoke("chat_stream", { request: { ...req, temperature: null }, onEvent: channel });
}

export async function cancelStream(streamId: string) {
  const sim = simAborts.get(streamId);
  if (sim) {
    sim.abort();
    return;
  }
  if (inTauri) await invoke("cancel_stream", { streamId });
}
