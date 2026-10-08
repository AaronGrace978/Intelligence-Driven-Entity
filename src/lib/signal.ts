import type { Phase, StreamEvent } from "./types";

/**
 * Bridges backend stream telemetry to the entity renderers.
 * Renderers call `tick(dt)` once per frame and read `out` — never through React state,
 * so 60fps animation does not re-render the UI.
 */
export interface EntityOutputs {
  tokensPerSecond: number;
  confidence: number;
  error: number;
  activity: number;
  success: number;
  speak: number;
}

const ACTIVITY: Record<Phase | "idle", number> = {
  idle: 0,
  waiting: 0.45,
  reasoning: 0.8,
  generating: 1,
};

const ease = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

class EntitySignal {
  phase: Phase | "idle" = "idle";
  tokensPerSecond = 0;
  /** `null` when the provider does not expose logprobs. */
  confidence: number | null = null;
  tokens = 0;
  lastError: string | null = null;

  /** Late telemetry can arrive after a terminal event; it must not revive the phase. */
  private active = false;
  private error = 0;
  private errorHold = 0;
  private success = 0;
  private speak = 0;

  /** Manual stimulus from the diagnostics panel. */
  stimulus = { surge: 0, doubt: 0 };
  look = { x: 0, y: 0 };

  out: EntityOutputs = { tokensPerSecond: 0, confidence: 1, error: 0, activity: 0, success: 0, speak: 0 };

  ingest(e: StreamEvent) {
    if (e.type !== "start" && !this.active) return;
    switch (e.type) {
      case "start":
        this.active = true;
        this.phase = "waiting";
        this.tokens = 0;
        this.confidence = null;
        this.lastError = null;
        break;
      case "delta":
      case "reasoning":
        this.speak = Math.min(1, this.speak + (e.type === "delta" ? 0.35 : 0.15));
        if (this.phase === "waiting") this.phase = e.type === "delta" ? "generating" : "reasoning";
        break;
      case "telemetry":
        this.phase = e.phase;
        this.tokensPerSecond = e.tokensPerSecond;
        this.confidence = e.confidence;
        this.tokens = e.tokens;
        break;
      case "done":
        this.active = false;
        this.phase = "idle";
        this.tokensPerSecond = 0;
        this.success = 1;
        this.confidence = e.confidence;
        break;
      case "error":
        this.fail(e.message);
        break;
      case "cancelled":
        this.active = false;
        this.phase = "idle";
        this.tokensPerSecond = 0;
        break;
    }
  }

  fail(message: string) {
    this.active = false;
    this.phase = "idle";
    this.tokensPerSecond = 0;
    this.error = 1;
    this.errorHold = 1.4;
    this.success = 0;
    this.lastError = message;
  }

  celebrate() {
    this.success = 1;
    this.error = 0;
  }

  get streaming() {
    return this.phase !== "idle";
  }

  tick(dt: number): EntityOutputs {
    dt = Math.min(dt, 0.1);
    if (this.errorHold > 0) this.errorHold -= dt;
    else this.error *= Math.exp(-dt * 0.55);
    this.success *= Math.exp(-dt * 0.4);
    this.speak *= Math.exp(-dt * 7);
    this.stimulus.surge *= Math.exp(-dt * 0.35);
    this.stimulus.doubt *= Math.exp(-dt * 0.3);

    const o = this.out;
    const conf = this.phase === "idle" ? 1 : (this.confidence ?? 0.86);
    const confTarget = Math.max(0, Math.min(conf, 1 - this.stimulus.doubt));
    const tpsTarget = this.tokensPerSecond + this.stimulus.surge * 140;
    const activityTarget = Math.max(ACTIVITY[this.phase], Math.min(1, this.stimulus.surge * 1.2));

    o.tokensPerSecond = ease(o.tokensPerSecond, tpsTarget, 4, dt);
    o.confidence = ease(o.confidence, confTarget, 3, dt);
    o.activity = ease(o.activity, activityTarget, 3, dt);
    o.error = this.error;
    o.success = this.success;
    o.speak = ease(o.speak, this.speak, 18, dt);
    return o;
  }
}

export const signal = new EntitySignal();
