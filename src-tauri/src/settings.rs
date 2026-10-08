use std::{collections::HashMap, fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::providers::{self, ProviderSpec};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderOverride {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub renderer: String,
    pub system_prompt: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            provider: None,
            model: None,
            renderer: "shader".into(),
            system_prompt: "You are THE ENTITY: a sharp, concise, slightly uncanny AI living inside a terminal. Answer precisely. Use markdown and fenced code blocks when useful.".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub providers: HashMap<String, ProviderOverride>,
    pub preferences: Preferences,
}

pub struct Resolved {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// Stored key wins over the environment variable; stored base URL wins over the default.
    pub fn resolve(&self, spec: &ProviderSpec) -> Resolved {
        let o = self.providers.get(spec.id);
        let base_url = o
            .and_then(|o| o.base_url.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| spec.default_base_url.to_string());
        let api_key = o
            .and_then(|o| o.api_key.clone())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| spec.env_key.and_then(|k| std::env::var(k).ok()))
            .filter(|s| !s.trim().is_empty());
        Resolved {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }

    pub fn key_source(&self, spec: &ProviderSpec) -> Option<&'static str> {
        let stored = self
            .providers
            .get(spec.id)
            .and_then(|o| o.api_key.as_ref())
            .is_some_and(|k| !k.trim().is_empty());
        if stored {
            return Some("settings");
        }
        let env = spec
            .env_key
            .and_then(|k| std::env::var(k).ok())
            .is_some_and(|k| !k.trim().is_empty());
        env.then_some("env")
    }
}

/// What the webview gets to see about a provider. Never includes the key itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub wire: providers::Wire,
    pub base_url: String,
    pub default_base_url: &'static str,
    pub env_key: Option<&'static str>,
    pub requires_key: bool,
    pub key_source: Option<&'static str>,
    pub ready: bool,
}

pub fn provider_infos(settings: &Settings) -> Vec<ProviderInfo> {
    providers::PROVIDERS
        .iter()
        .map(|spec| {
            let resolved = settings.resolve(spec);
            let key_source = settings.key_source(spec);
            ProviderInfo {
                id: spec.id,
                label: spec.label,
                wire: spec.wire,
                base_url: resolved.base_url,
                default_base_url: spec.default_base_url,
                env_key: spec.env_key,
                requires_key: spec.requires_key,
                key_source,
                ready: !spec.requires_key || key_source.is_some(),
            }
        })
        .collect()
}
