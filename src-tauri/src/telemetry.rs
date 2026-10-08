use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use serde::Serialize;

const RATE_WINDOW: Duration = Duration::from_millis(1500);
const CONFIDENCE_WINDOW: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Waiting,
    Reasoning,
    Generating,
}

/// Every event the backend pushes to the webview for a single generation.
/// `Telemetry` is what drives the entity's shader uniforms.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Start {
        provider: String,
        model: String,
    },
    Delta {
        content: String,
    },
    Reasoning {
        content: String,
    },
    Telemetry {
        tokens_per_second: f32,
        confidence: Option<f32>,
        tokens: u32,
        phase: Phase,
        elapsed_ms: u64,
    },
    Done {
        tokens: u32,
        elapsed_ms: u64,
        avg_tokens_per_second: f32,
        confidence: Option<f32>,
        finish_reason: Option<String>,
    },
    Error {
        message: String,
        status: Option<u16>,
    },
    Cancelled,
}

pub struct Meter {
    started: Instant,
    first_token: Option<Instant>,
    window: VecDeque<(Instant, f32)>,
    tokens: f32,
    logprobs: VecDeque<f32>,
    phase: Phase,
    /// Exact generation rate reported by the server (Ollama's eval_count / eval_duration).
    reported_tps: Option<f32>,
}

impl Meter {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            first_token: None,
            window: VecDeque::new(),
            tokens: 0.0,
            logprobs: VecDeque::new(),
            phase: Phase::Waiting,
            reported_tps: None,
        }
    }

    /// Records a chunk of output. `exact_tokens` comes from logprob entries when available;
    /// otherwise it is estimated (~5 characters per token, at least one per chunk).
    pub fn record(&mut self, text: &str, exact_tokens: Option<usize>, phase: Phase) {
        let n = match exact_tokens {
            Some(n) if n > 0 => n as f32,
            _ => (text.chars().count() as f32 / 5.0).round().max(1.0),
        };
        let now = Instant::now();
        self.first_token.get_or_insert(now);
        self.window.push_back((now, n));
        self.tokens += n;
        self.phase = phase;
    }

    pub fn record_logprob(&mut self, logprob: f32) {
        if !logprob.is_finite() {
            return;
        }
        self.logprobs.push_back(logprob);
        while self.logprobs.len() > CONFIDENCE_WINDOW {
            self.logprobs.pop_front();
        }
    }

    pub fn set_reported_tps(&mut self, tps: f32) {
        if tps.is_finite() && tps > 0.0 {
            self.reported_tps = Some(tps);
        }
    }

    pub fn tokens_per_second(&mut self) -> f32 {
        let now = Instant::now();
        while self
            .window
            .front()
            .is_some_and(|(t, _)| now.duration_since(*t) > RATE_WINDOW)
        {
            self.window.pop_front();
        }
        let Some(first) = self.first_token else {
            return 0.0;
        };
        let span = now
            .duration_since(first)
            .min(RATE_WINDOW)
            .as_secs_f32()
            .max(0.25);
        self.window.iter().map(|(_, n)| n).sum::<f32>() / span
    }

    /// Geometric-mean token probability over the recent window.
    pub fn confidence(&self) -> Option<f32> {
        if self.logprobs.is_empty() {
            return None;
        }
        let mean = self.logprobs.iter().sum::<f32>() / self.logprobs.len() as f32;
        Some(mean.exp().clamp(0.0, 1.0))
    }

    pub fn telemetry(&mut self) -> StreamEvent {
        StreamEvent::Telemetry {
            tokens_per_second: self.tokens_per_second(),
            confidence: self.confidence(),
            tokens: self.tokens as u32,
            phase: self.phase,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        }
    }

    pub fn done(&self, finish_reason: Option<String>) -> StreamEvent {
        let avg = self.reported_tps.unwrap_or_else(|| match self.first_token {
            Some(first) => {
                let secs = first.elapsed().as_secs_f32().max(0.001);
                self.tokens / secs
            }
            None => 0.0,
        });
        StreamEvent::Done {
            tokens: self.tokens as u32,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
            avg_tokens_per_second: avg,
            confidence: self.confidence(),
            finish_reason,
        }
    }
}
