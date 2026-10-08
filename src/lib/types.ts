export type Wire = "ollama" | "open_ai" | "anthropic" | "simulator";

export interface ProviderInfo {
  id: string;
  label: string;
  wire: Wire;
  baseUrl: string;
  defaultBaseUrl: string;
  envKey: string | null;
  requiresKey: boolean;
  keySource: "settings" | "env" | null;
  ready: boolean;
}

export interface ModelInfo {
  id: string;
  label: string | null;
  created: number | null;
}

export interface ModelList {
  models: ModelInfo[];
  live: boolean;
  error: string | null;
}

export type RendererKind = "shader" | "ascii" | "vector";

export interface Preferences {
  provider: string | null;
  model: string | null;
  renderer: RendererKind;
  systemPrompt: string;
}

export type Phase = "waiting" | "reasoning" | "generating";

export type StreamEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "telemetry";
      tokensPerSecond: number;
      confidence: number | null;
      tokens: number;
      phase: Phase;
      elapsedMs: number;
    }
  | {
      type: "done";
      tokens: number;
      elapsedMs: number;
      avgTokensPerSecond: number;
      confidence: number | null;
      finishReason: string | null;
    }
  | { type: "error"; message: string; status: number | null }
  | { type: "cancelled" };

export type PadButton =
  | "south"
  | "east"
  | "north"
  | "west"
  | "lb"
  | "rb"
  | "lt"
  | "rt"
  | "select"
  | "start"
  | "mode"
  | "ls"
  | "rs"
  | "up"
  | "down"
  | "left"
  | "right";

export type PadAxis = "leftX" | "leftY" | "rightX" | "rightY" | "leftTrigger" | "rightTrigger";

/** Controller input forwarded by the Rust backend (`src-tauri/src/gamepad.rs`). */
export type PadEvent =
  | { kind: "button"; button: PadButton; pressed: boolean }
  | { kind: "axis"; axis: PadAxis; value: number }
  | { kind: "connected"; name: string }
  | { kind: "disconnected" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  provider?: string;
  model?: string;
  status?: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  stats?: { tokens: number; tps: number; confidence: number | null; elapsedMs: number };
}
