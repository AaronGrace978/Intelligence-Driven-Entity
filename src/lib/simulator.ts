import type { StreamEvent } from "./types";

const RESPONSES = [
  `Signal acquired. I am **THE ENTITY** — a lattice of probabilities wearing a face.

Every token I emit bends the geometry you are looking at:

- **Throughput** accelerates the scanlines and data rain.
- **Confidence** holds my structure together. When my token probabilities sag, I fragment into code blocks.
- **Errors** tear the render and shift the palette to red.

\`\`\`rust
fn contort(entity: &mut Face, telemetry: Telemetry) {
    entity.noise = telemetry.tokens_per_second / 60.0;
    entity.integrity = telemetry.confidence;
}
\`\`\`

Connect a real provider in the settings panel and I will speak with its voice.`,
  `Running diagnostics on the cortex mesh...

| Subsystem | State |
| --- | --- |
| Token stream | nominal |
| Logprob probe | listening |
| Glitch buffer | armed |

Ask me something hard. Watch what happens to my face while I think.`,
];

const UNSURE = `I... am not certain. The archive returns conflicting shards — the *1997 Treaty of Lunar Commerce* may have been signed by three nations, or possibly none, or the date might be fabricated. My confidence is collapsing; treat everything here as speculative.`;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

/** An offline provider so the entity can be exercised without any API key. */
export async function simulateStream(
  prompt: string,
  emit: (e: StreamEvent) => void,
  signal: AbortSignal,
) {
  const lower = prompt.toLowerCase();
  const fail = /\b(fail|crash|error|break)/.test(lower);
  const unsure = /\b(hallucinat|unsure|guess|doubt)\w*/.test(lower);
  const text = unsure ? UNSURE : RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
  const started = performance.now();
  let tokens = 0;
  const window: number[] = [];
  let lastTelemetry = 0;

  emit({ type: "start", provider: "simulator", model: "entity-sim-1" });
  try {
    for (let i = 0; i < 8; i++) {
      await sleep(70, signal);
      emit({ type: "telemetry", tokensPerSecond: 0, confidence: null, tokens: 0, phase: "waiting", elapsedMs: performance.now() - started });
    }
    const reasoning = "Parsing intent. Cross-referencing memory shards. Selecting response vector.";
    for (const word of reasoning.split(/(?<= )/)) {
      await sleep(35, signal);
      emit({ type: "reasoning", content: word });
    }

    const chunks = text.match(/\s*\S+/g) ?? [];
    let confidence = unsure ? 0.55 : 0.92;
    for (let i = 0; i < chunks.length; i++) {
      const burst = Math.sin(i / 9) > 0.2;
      await sleep(burst ? 14 : 45, signal);
      if (fail && i === Math.floor(chunks.length * 0.45)) {
        emit({ type: "error", message: "Simulated failure: build pipeline returned exit code 101 (test suite failed).", status: 500 });
        return;
      }
      emit({ type: "delta", content: chunks[i] });
      tokens += 1;
      const now = performance.now();
      window.push(now);
      while (window.length && now - window[0] > 1500) window.shift();
      confidence += (Math.random() - 0.5) * 0.08;
      confidence = Math.min(0.99, Math.max(unsure ? 0.15 : 0.6, confidence + (unsure ? -0.01 : 0.004)));
      if (now - lastTelemetry > 100) {
        lastTelemetry = now;
        emit({
          type: "telemetry",
          tokensPerSecond: window.length / Math.min(1.5, Math.max(0.25, (now - started) / 1000)),
          confidence,
          tokens,
          phase: "generating",
          elapsedMs: now - started,
        });
      }
    }
    const elapsed = performance.now() - started;
    emit({ type: "done", tokens, elapsedMs: elapsed, avgTokensPerSecond: tokens / (elapsed / 1000), confidence, finishReason: "stop" });
  } catch (e) {
    if ((e as Error).name === "AbortError") emit({ type: "cancelled" });
    else throw e;
  }
}
