use serde::Serialize;
use serde_json::Value;

use crate::{
    chat::{describe_reqwest_error, extract_error},
    providers::{self, ProviderSpec, Wire},
    settings::Resolved,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: Option<String>,
    pub created: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<ModelInfo>,
    /// True when the list came from the provider's API rather than the built-in fallback.
    pub live: bool,
    pub error: Option<String>,
}

pub async fn list(client: &reqwest::Client, spec: &ProviderSpec, resolved: &Resolved) -> ModelList {
    let fallback = |error: String| ModelList {
        models: spec
            .fallback_models
            .iter()
            .map(|id| ModelInfo {
                id: (*id).into(),
                label: None,
                created: None,
            })
            .collect(),
        live: false,
        error: Some(error),
    };

    if spec.requires_key && resolved.api_key.is_none() {
        return fallback(format!("No API key configured for {}.", spec.label));
    }

    match fetch(client, spec, resolved).await {
        Ok(mut models) => {
            models.retain(|m| providers::is_chat_model(&m.id));
            models.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
            ModelList {
                models,
                live: true,
                error: None,
            }
        }
        Err(e) => fallback(e),
    }
}

async fn fetch(
    client: &reqwest::Client,
    spec: &ProviderSpec,
    resolved: &Resolved,
) -> Result<Vec<ModelInfo>, String> {
    let base = &resolved.base_url;
    let key = resolved.api_key.as_deref();
    let req = match spec.wire {
        Wire::Ollama => {
            let b = client.get(format!("{base}/api/tags"));
            match key {
                Some(k) => b.bearer_auth(k),
                None => b,
            }
        }
        Wire::OpenAi => {
            let b = client.get(format!("{base}/models"));
            match key {
                Some(k) => b.bearer_auth(k),
                None => b,
            }
        }
        Wire::Anthropic => client
            .get(format!("{base}/models?limit=1000"))
            .header("x-api-key", key.unwrap_or_default())
            .header("anthropic-version", "2023-06-01"),
    };

    let res = req
        .send()
        .await
        .map_err(|e| describe_reqwest_error(&e, base))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(extract_error(&body, status));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("Unexpected model list: {e}"))?;

    let models = match spec.wire {
        Wire::Ollama => v["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m.get("name").or_else(|| m.get("model"))?.as_str()?.to_string();
                let created = m
                    .get("modified_at")
                    .and_then(Value::as_str)
                    .and_then(parse_year_month_day);
                Some(ModelInfo {
                    id,
                    label: None,
                    created,
                })
            })
            .collect(),
        Wire::OpenAi | Wire::Anthropic => v["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let raw = m.get("id")?.as_str()?;
                let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
                let label = m
                    .get("display_name")
                    .or_else(|| m.get("name"))
                    .and_then(Value::as_str)
                    .filter(|l| *l != id)
                    .map(String::from);
                let created = m.get("created").and_then(Value::as_i64).or_else(|| {
                    m.get("created_at")
                        .and_then(Value::as_str)
                        .and_then(parse_year_month_day)
                });
                Some(ModelInfo { id, label, created })
            })
            .collect(),
    };
    Ok(models)
}

/// Turns an RFC 3339 date into a sortable number without pulling in a date crate.
fn parse_year_month_day(s: &str) -> Option<i64> {
    let digits: String = s.chars().take(10).filter(char::is_ascii_digit).collect();
    digits.parse().ok()
}
