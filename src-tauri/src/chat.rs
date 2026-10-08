use std::{collections::HashSet, sync::Mutex, time::Duration};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::{
    providers::{ProviderSpec, Wire},
    settings::Resolved,
    telemetry::{Meter, Phase, StreamEvent},
};

const TELEMETRY_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub stream_id: String,
    pub provider: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub system: Option<String>,
    pub temperature: Option<f32>,
}

struct Attempt {
    logprobs: bool,
    max_tokens: u32,
}

enum LineOutcome {
    Continue,
    Finished,
}

pub struct Session<'a> {
    pub client: &'a reqwest::Client,
    pub spec: &'static ProviderSpec,
    pub resolved: Resolved,
    pub request: ChatRequest,
    pub channel: &'a Channel<StreamEvent>,
    pub cancel: CancellationToken,
    pub no_logprobs: &'a Mutex<HashSet<String>>,
}

impl Session<'_> {
    fn emit(&self, event: StreamEvent) {
        let _ = self.channel.send(event);
    }

    fn error(&self, message: impl Into<String>, status: Option<u16>) {
        self.emit(StreamEvent::Error {
            message: message.into(),
            status,
        });
    }

    fn logprob_key(&self) -> String {
        format!("{}::{}", self.spec.id, self.request.model)
    }

    pub async fn run(self) {
        if self.spec.requires_key && self.resolved.api_key.is_none() {
            let hint = self
                .spec
                .env_key
                .map(|k| format!(" or set {k}"))
                .unwrap_or_default();
            self.error(
                format!(
                    "No API key for {}. Add one in the settings panel{hint}.",
                    self.spec.label
                ),
                None,
            );
            return;
        }

        self.emit(StreamEvent::Start {
            provider: self.spec.id.into(),
            model: self.request.model.clone(),
        });

        let skip_logprobs = self
            .no_logprobs
            .lock()
            .map(|s| s.contains(&self.logprob_key()))
            .unwrap_or(false);
        let mut attempt = Attempt {
            logprobs: self.spec.logprobs && !skip_logprobs,
            max_tokens: 8192,
        };

        let response = loop {
            let builder = self.build(&attempt);
            let sent = tokio::select! {
                _ = self.cancel.cancelled() => { self.emit(StreamEvent::Cancelled); return; }
                r = builder.send() => r,
            };
            let response = match sent {
                Ok(r) => r,
                Err(e) => {
                    self.error(describe_reqwest_error(&e, &self.resolved.base_url), None);
                    return;
                }
            };
            let status = response.status();
            if status.is_success() {
                break response;
            }
            let body = response.text().await.unwrap_or_default();
            let lower = body.to_ascii_lowercase();
            if attempt.logprobs && (status.as_u16() == 400 || status.as_u16() == 422) && lower.contains("logprob") {
                if let Ok(mut set) = self.no_logprobs.lock() {
                    set.insert(self.logprob_key());
                }
                attempt.logprobs = false;
                continue;
            }
            if self.spec.wire == Wire::Anthropic && attempt.max_tokens > 4096 && lower.contains("max_tokens") {
                attempt.max_tokens = 4096;
                continue;
            }
            self.error(extract_error(&body, status), Some(status.as_u16()));
            return;
        };

        self.consume(response).await;
    }

    fn build(&self, attempt: &Attempt) -> reqwest::RequestBuilder {
        let req = &self.request;
        let system = req.system.as_deref().filter(|s| !s.trim().is_empty());
        let key = self.resolved.api_key.as_deref();
        let base = &self.resolved.base_url;

        let mut messages: Vec<Value> = Vec::new();
        if self.spec.wire != Wire::Anthropic {
            if let Some(system) = system {
                messages.push(json!({ "role": "system", "content": system }));
            }
        }
        for m in &req.messages {
            if m.content.is_empty() {
                continue;
            }
            if self.spec.wire == Wire::Anthropic && m.role == "system" {
                continue;
            }
            messages.push(json!({ "role": m.role, "content": m.content }));
        }

        match self.spec.wire {
            Wire::Ollama => {
                let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
                if let Some(t) = req.temperature {
                    body["options"] = json!({ "temperature": t });
                }
                if attempt.logprobs {
                    body["logprobs"] = json!(true);
                }
                let mut b = self.client.post(format!("{base}/api/chat")).json(&body);
                if let Some(key) = key {
                    b = b.bearer_auth(key);
                }
                b
            }
            Wire::OpenAi => {
                let mut body = json!({ "model": req.model, "messages": messages, "stream": true });
                if let Some(t) = req.temperature {
                    body["temperature"] = json!(t);
                }
                if attempt.logprobs {
                    body["logprobs"] = json!(true);
                }
                let mut b = self
                    .client
                    .post(format!("{base}/chat/completions"))
                    .header("Accept", "text/event-stream")
                    .json(&body);
                if let Some(key) = key {
                    b = b.bearer_auth(key);
                }
                if self.spec.id == "openrouter" {
                    b = b
                        .header("HTTP-Referer", "https://github.com/the-entity")
                        .header("X-Title", "The Entity");
                }
                b
            }
            Wire::Anthropic => {
                let mut body = json!({
                    "model": req.model,
                    "messages": messages,
                    "max_tokens": attempt.max_tokens,
                    "stream": true,
                });
                if let Some(system) = system {
                    body["system"] = json!(system);
                }
                if let Some(t) = req.temperature {
                    body["temperature"] = json!(t);
                }
                self.client
                    .post(format!("{base}/messages"))
                    .header("x-api-key", key.unwrap_or_default())
                    .header("anthropic-version", "2023-06-01")
                    .json(&body)
            }
        }
    }

    async fn consume(&self, response: reqwest::Response) {
        let mut meter = Meter::new();
        let mut finish_reason: Option<String> = None;
        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::new();
        let mut ticker = tokio::time::interval(TELEMETRY_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    self.emit(meter.telemetry());
                    self.emit(StreamEvent::Cancelled);
                    return;
                }
                _ = ticker.tick() => {
                    self.emit(meter.telemetry());
                }
                chunk = stream.next() => {
                    let Some(chunk) = chunk else { break };
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(e) => {
                            self.error(format!("Stream interrupted: {e}"), None);
                            return;
                        }
                    };
                    buffer.extend_from_slice(&bytes);
                    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&line);
                        match self.handle_line(line.trim(), &mut meter, &mut finish_reason) {
                            Ok(LineOutcome::Continue) => {}
                            Ok(LineOutcome::Finished) => {
                                self.finish(&mut meter, finish_reason);
                                return;
                            }
                            Err(message) => {
                                self.emit(meter.telemetry());
                                self.error(message, None);
                                return;
                            }
                        }
                    }
                }
            }
        }

        let rest = String::from_utf8_lossy(&buffer).to_string();
        if let Err(message) = self.handle_line(rest.trim(), &mut meter, &mut finish_reason) {
            self.error(message, None);
            return;
        }
        self.finish(&mut meter, finish_reason);
    }

    fn finish(&self, meter: &mut Meter, finish_reason: Option<String>) {
        self.emit(meter.telemetry());
        self.emit(meter.done(finish_reason));
    }

    fn handle_line(
        &self,
        line: &str,
        meter: &mut Meter,
        finish_reason: &mut Option<String>,
    ) -> Result<LineOutcome, String> {
        if line.is_empty() {
            return Ok(LineOutcome::Continue);
        }
        match self.spec.wire {
            Wire::Ollama => self.ollama_line(line, meter, finish_reason),
            Wire::OpenAi | Wire::Anthropic => {
                // SSE: only `data:` lines carry payloads; `event:`, `id:` and `:` comments are noise.
                let Some(data) = line.strip_prefix("data:") else {
                    return Ok(LineOutcome::Continue);
                };
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(LineOutcome::Finished);
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else {
                    return Ok(LineOutcome::Continue);
                };
                if self.spec.wire == Wire::OpenAi {
                    self.openai_event(&v, meter, finish_reason)
                } else {
                    self.anthropic_event(&v, meter, finish_reason)
                }
            }
        }
    }

    fn ollama_line(
        &self,
        line: &str,
        meter: &mut Meter,
        finish_reason: &mut Option<String>,
    ) -> Result<LineOutcome, String> {
        let v: Value = serde_json::from_str(line).map_err(|e| format!("Bad response line: {e}"))?;
        if let Some(err) = v.get("error") {
            return Err(value_message(err));
        }
        let logprobs = v.get("logprobs").and_then(Value::as_array);
        let exact = logprobs.map(|a| a.len());
        for lp in logprobs.into_iter().flatten() {
            if let Some(x) = lp.get("logprob").and_then(Value::as_f64) {
                meter.record_logprob(x as f32);
            }
        }
        if let Some(msg) = v.get("message") {
            if let Some(t) = msg.get("thinking").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                meter.record(t, None, Phase::Reasoning);
                self.emit(StreamEvent::Reasoning { content: t.into() });
            }
            if let Some(c) = msg.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                meter.record(c, exact, Phase::Generating);
                self.emit(StreamEvent::Delta { content: c.into() });
            }
        }
        if v.get("done").and_then(Value::as_bool) == Some(true) {
            *finish_reason = v.get("done_reason").and_then(Value::as_str).map(String::from);
            let count = v.get("eval_count").and_then(Value::as_f64);
            let dur = v.get("eval_duration").and_then(Value::as_f64);
            if let (Some(count), Some(dur)) = (count, dur) {
                if dur > 0.0 {
                    meter.set_reported_tps((count / (dur / 1e9)) as f32);
                }
            }
            return Ok(LineOutcome::Finished);
        }
        Ok(LineOutcome::Continue)
    }

    fn openai_event(
        &self,
        v: &Value,
        meter: &mut Meter,
        finish_reason: &mut Option<String>,
    ) -> Result<LineOutcome, String> {
        if let Some(err) = v.get("error") {
            return Err(value_message(err));
        }
        let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
            return Ok(LineOutcome::Continue);
        };
        let logprobs = choice
            .get("logprobs")
            .and_then(|l| l.get("content"))
            .and_then(Value::as_array);
        let exact = logprobs.map(|a| a.len());
        for lp in logprobs.into_iter().flatten() {
            if let Some(x) = lp.get("logprob").and_then(Value::as_f64) {
                meter.record_logprob(x as f32);
            }
        }
        if let Some(delta) = choice.get("delta") {
            let reasoning = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if let Some(r) = reasoning {
                meter.record(r, None, Phase::Reasoning);
                self.emit(StreamEvent::Reasoning { content: r.into() });
            }
            if let Some(c) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                meter.record(c, exact, Phase::Generating);
                self.emit(StreamEvent::Delta { content: c.into() });
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            *finish_reason = Some(reason.into());
        }
        Ok(LineOutcome::Continue)
    }

    fn anthropic_event(
        &self,
        v: &Value,
        meter: &mut Meter,
        finish_reason: &mut Option<String>,
    ) -> Result<LineOutcome, String> {
        match v.get("type").and_then(Value::as_str).unwrap_or_default() {
            "content_block_delta" => {
                let delta = &v["delta"];
                match delta.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text_delta" => {
                        if let Some(t) = delta.get("text").and_then(Value::as_str) {
                            meter.record(t, None, Phase::Generating);
                            self.emit(StreamEvent::Delta { content: t.into() });
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta.get("thinking").and_then(Value::as_str) {
                            meter.record(t, None, Phase::Reasoning);
                            self.emit(StreamEvent::Reasoning { content: t.into() });
                        }
                    }
                    _ => {}
                }
                Ok(LineOutcome::Continue)
            }
            "message_delta" => {
                if let Some(r) = v["delta"].get("stop_reason").and_then(Value::as_str) {
                    *finish_reason = Some(r.into());
                }
                Ok(LineOutcome::Continue)
            }
            "message_stop" => Ok(LineOutcome::Finished),
            "error" => Err(value_message(v.get("error").unwrap_or(v))),
            _ => Ok(LineOutcome::Continue),
        }
    }
}

fn value_message(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    for key in ["message", "error", "detail"] {
        if let Some(inner) = v.get(key) {
            return value_message(inner);
        }
    }
    let s = v.to_string();
    s.chars().take(400).collect()
}

pub fn extract_error(body: &str, status: reqwest::StatusCode) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .map(|v| value_message(&v))
        .unwrap_or_else(|_| body.trim().chars().take(400).collect());
    let reason = status.canonical_reason().unwrap_or("error");
    if detail.is_empty() {
        format!("HTTP {} {reason}", status.as_u16())
    } else {
        format!("HTTP {} {reason}: {detail}", status.as_u16())
    }
}

pub fn describe_reqwest_error(e: &reqwest::Error, base_url: &str) -> String {
    if e.is_connect() {
        format!("Could not connect to {base_url}. Is the server running and reachable?")
    } else if e.is_timeout() {
        format!("Timed out talking to {base_url}.")
    } else {
        format!("Request failed: {e}")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tauri::ipc::InvokeResponseBody;

    use super::*;
    use crate::providers;

    type Captured = Arc<Mutex<Vec<Value>>>;

    fn session_for(provider: &str) -> (Session<'static>, Captured) {
        let captured: Captured = Arc::default();
        let sink = captured.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
            }
            Ok(())
        });
        let session = Session {
            client: Box::leak(Box::new(reqwest::Client::new())),
            spec: providers::find(provider).unwrap(),
            resolved: Resolved { base_url: "http://x".into(), api_key: None },
            request: ChatRequest {
                stream_id: "s".into(),
                provider: provider.into(),
                model: "m".into(),
                messages: vec![],
                system: None,
                temperature: None,
            },
            channel: Box::leak(Box::new(channel)),
            cancel: CancellationToken::new(),
            no_logprobs: Box::leak(Box::default()),
        };
        (session, captured)
    }

    fn feed(s: &Session, lines: &[&str]) -> (Vec<Result<bool, String>>, Meter, Option<String>) {
        let mut meter = Meter::new();
        let mut finish = None;
        let outcomes = lines
            .iter()
            .map(|l| {
                s.handle_line(l, &mut meter, &mut finish)
                    .map(|o| matches!(o, LineOutcome::Finished))
            })
            .collect();
        (outcomes, meter, finish)
    }

    fn texts(c: &Captured, kind: &str) -> String {
        c.lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == kind)
            .map(|e| e["content"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn openai_sse_with_reasoning_and_logprobs() {
        let (s, c) = session_for("openai");
        let (out, meter, finish) = feed(
            &s,
            &[
                ": keep-alive",
                r#"data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#,
                r#"data: {"choices":[{"delta":{"content":"Hel"},"logprobs":{"content":[{"logprob":-0.1}]}}]}"#,
                r#"data: {"choices":[{"delta":{"content":"lo"},"logprobs":{"content":[{"logprob":-0.3}]},"finish_reason":"stop"}]}"#,
                "data: [DONE]",
            ],
        );
        assert_eq!(out.last(), Some(&Ok(true)));
        assert_eq!(texts(&c, "delta"), "Hello");
        assert_eq!(texts(&c, "reasoning"), "hmm");
        assert_eq!(finish.as_deref(), Some("stop"));
        let conf = meter.confidence().unwrap();
        assert!((conf - (-0.2f32).exp()).abs() < 1e-4, "{conf}");
    }

    #[test]
    fn openai_inline_error_is_surfaced() {
        let (s, _) = session_for("openrouter");
        let (out, _, _) = feed(&s, &[r#"data: {"error":{"message":"rate limited"}}"#]);
        assert_eq!(out[0], Err("rate limited".into()));
    }

    #[test]
    fn anthropic_events() {
        let (s, c) = session_for("anthropic");
        let (out, _, finish) = feed(
            &s,
            &[
                "event: content_block_delta",
                r#"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}"#,
                r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#,
                r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
                r#"data: {"type":"message_stop"}"#,
            ],
        );
        assert_eq!(out.last(), Some(&Ok(true)));
        assert_eq!(texts(&c, "delta"), "Hi");
        assert_eq!(texts(&c, "reasoning"), "plan");
        assert_eq!(finish.as_deref(), Some("end_turn"));
    }

    #[test]
    fn ollama_ndjson_reports_exact_rate() {
        let (s, c) = session_for("ollama_cloud");
        let (out, meter, finish) = feed(
            &s,
            &[
                r#"{"message":{"content":"","thinking":"..."},"done":false}"#,
                r#"{"message":{"content":"Yo"},"done":false,"logprobs":[{"token":"Yo","logprob":-0.5}]}"#,
                r#"{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":50,"eval_duration":2000000000}"#,
            ],
        );
        assert_eq!(out.last(), Some(&Ok(true)));
        assert_eq!(texts(&c, "delta"), "Yo");
        assert_eq!(finish.as_deref(), Some("stop"));
        match meter.done(finish) {
            StreamEvent::Done { avg_tokens_per_second, confidence, .. } => {
                assert!((avg_tokens_per_second - 25.0).abs() < 1e-3);
                assert!((confidence.unwrap() - (-0.5f32).exp()).abs() < 1e-4);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn ollama_error_line() {
        let (s, _) = session_for("ollama_local");
        let (out, _, _) = feed(&s, &[r#"{"error":"model 'x' not found"}"#]);
        assert_eq!(out[0], Err("model 'x' not found".into()));
    }

    #[test]
    fn error_bodies_are_condensed() {
        let status = reqwest::StatusCode::UNAUTHORIZED;
        assert_eq!(
            extract_error(r#"{"error":{"type":"auth","message":"invalid x-api-key"}}"#, status),
            "HTTP 401 Unauthorized: invalid x-api-key"
        );
        assert_eq!(extract_error("", status), "HTTP 401 Unauthorized");
    }
}
