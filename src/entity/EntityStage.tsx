import { Component, lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { budget } from "../lib/budget";
import { signal } from "../lib/signal";
import type { RendererKind } from "../lib/types";

const ShaderEntity = lazy(() => import("./ShaderEntity"));
const AsciiEntity = lazy(() => import("./AsciiEntity"));
const VectorEntity = lazy(() => import("./VectorEntity"));

const RENDERERS: Record<RendererKind, { label: string; tag: string }> = {
  shader: { label: "MATRIX", tag: "GLSL // voxel lattice" },
  ascii: { label: "ASCII", tag: "THREE // perlin mesh → glyph ramp" },
  vector: { label: "VECTOR", tag: "SVG // spring-anchored wireframe" },
};

/**
 * MATRIX and ASCII need WebGL. When the GPU stack cannot give WebKit a context (a missing Mesa
 * driver, a broken gamescope session), fall back to the SVG renderer instead of a blank window.
 */
class WebGLFallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("entity renderer failed, falling back to VECTOR:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <VectorEntity />
        <div className="renderer-fallback">WEBGL UNAVAILABLE — VECTOR FALLBACK</div>
      </>
    );
  }
}

interface HudState {
  tps: number;
  conf: number;
  confKnown: boolean;
  err: number;
  act: number;
  tokens: number;
  phase: string;
  error: string | null;
}

function readHud(): HudState {
  const o = signal.out;
  return {
    tps: o.tokensPerSecond,
    conf: o.confidence,
    confKnown: signal.confidence !== null,
    err: o.error,
    act: o.activity,
    tokens: signal.tokens,
    phase: signal.phase,
    error: o.error > 0.05 ? signal.lastError : null,
  };
}

const PHASE_LABEL: Record<string, string> = {
  idle: "DORMANT",
  waiting: "AWAITING FIRST TOKEN",
  reasoning: "REASONING",
  generating: "GENERATING",
};

function Gauge({ name, value, display, tone, tag }: { name: string; value: number; display: string; tone?: string; tag?: string }) {
  return (
    <div className={`gauge ${tone ?? ""}`}>
      <div className="gauge-head">
        <span className="gauge-name">{name}</span>
        <span className="gauge-value">
          {display}
          {tag && <em>{tag}</em>}
        </span>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
    </div>
  );
}

export default function EntityStage({
  renderer,
  onRenderer,
  providerLabel,
  model,
  lightGraphics,
  onToggleGraphics,
}: {
  renderer: RendererKind;
  onRenderer: (r: RendererKind) => void;
  providerLabel: string;
  model: string | null;
  /** Set only on a Deck. Switches the cheaper shader without affecting a desktop session. */
  lightGraphics?: boolean;
  onToggleGraphics?: () => void;
}) {
  const [hud, setHud] = useState<HudState>(readHud);

  useEffect(() => {
    const id = setInterval(() => setHud(readHud()), budget.deck ? 200 : 90);
    return () => clearInterval(id);
  }, []);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    signal.look.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    signal.look.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
  };
  const onLeave = () => {
    signal.look.x = 0;
    signal.look.y = 0;
  };

  const faulted = hud.err > 0.08;
  const phase = faulted ? "FAULT" : PHASE_LABEL[hud.phase] ?? hud.phase;
  const Renderer = renderer === "shader" ? ShaderEntity : renderer === "ascii" ? AsciiEntity : VectorEntity;

  return (
    <section className={`stage ${faulted ? "is-fault" : ""}`} onMouseMove={onMove} onMouseLeave={onLeave}>
      <Suspense fallback={<div className="entity-canvas" />}>
        <WebGLFallback key={`${renderer}-${lightGraphics ? "lite" : "full"}`}>
          <Renderer />
        </WebGLFallback>
      </Suspense>

      <div className="stage-overlay">
        <span className="bracket tl" />
        <span className="bracket tr" />
        <span className="bracket bl" />
        <span className="bracket br" />

        <div className="hud-top">
          <div className="hud-block">
            <div className="hud-kicker">ENTITY // CORE</div>
            <div className={`hud-phase phase-${faulted ? "fault" : hud.phase}`}>
              <i className="pulse-dot" />
              {phase}
            </div>
          </div>
          <div className="renderer-switch" role="tablist">
            {(Object.keys(RENDERERS) as RendererKind[]).map((k) => (
              <button key={k} role="tab" aria-selected={renderer === k} className={renderer === k ? "on" : ""} onClick={() => onRenderer(k)}>
                {RENDERERS[k].label}
              </button>
            ))}
            {onToggleGraphics && (
              <button className={lightGraphics ? "on" : ""} onClick={onToggleGraphics} title="GPU FULL is the 1.0 face. GPU LITE is the small buffer.">
                {lightGraphics ? "GPU LITE" : "GPU FULL"}
              </button>
            )}
          </div>
          <div className="hud-block right">
            <div className="hud-kicker">{providerLabel.toUpperCase()}</div>
            <div className="hud-model">{model ?? "NO MODEL LINKED"}</div>
          </div>
        </div>

        {hud.error && (
          <div className="fault-banner">
            <strong>!! SIGNAL FAULT</strong>
            <span>{hud.error}</span>
          </div>
        )}

        <div className="hud-bottom">
          <div className="gauges">
            <Gauge name="u_tokens_per_second" value={hud.tps / 120} display={hud.tps.toFixed(1)} />
            <Gauge
              name="u_model_confidence"
              value={hud.conf}
              display={hud.conf.toFixed(3)}
              tag={hud.confKnown ? "LOGPROB" : "EST"}
              tone={hud.conf < 0.6 ? "warn" : ""}
            />
            <Gauge name="u_error_state" value={hud.err} display={hud.err.toFixed(3)} tone={hud.err > 0.05 ? "danger" : ""} />
            <div className="hud-meta">
              <span>TOKENS {String(hud.tokens).padStart(5, "0")}</span>
              <span>ACT {(hud.act * 100).toFixed(0)}%</span>
              <span>{RENDERERS[renderer].tag}</span>
            </div>
          </div>
          <div className="stimulus">
            <div className="hud-kicker">STIMULUS</div>
            <div className="stimulus-buttons">
              <button onClick={() => (signal.stimulus.surge = 1)}>SURGE</button>
              <button onClick={() => (signal.stimulus.doubt = 0.85)}>DOUBT</button>
              <button className="danger" onClick={() => signal.fail("Manual stimulus: simulated build failure (exit 101).")}>
                GLITCH
              </button>
              <button className="calm" onClick={() => signal.celebrate()}>
                STABILIZE
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
