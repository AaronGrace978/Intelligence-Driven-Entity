use serde::Serialize;

/// The HTTP dialect a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Wire {
    Ollama,
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub wire: Wire,
    pub default_base_url: &'static str,
    pub env_key: Option<&'static str>,
    pub requires_key: bool,
    /// Whether to ask for token logprobs (drives the entity's confidence signal).
    /// Requests that get rejected for it are retried without and remembered per model.
    pub logprobs: bool,
    /// Shown when live model discovery fails, so the picker is never empty.
    pub fallback_models: &'static [&'static str],
}

pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "ollama_cloud",
        label: "Ollama Cloud",
        wire: Wire::Ollama,
        default_base_url: "https://ollama.com",
        env_key: Some("OLLAMA_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &[
            "mistral-large-4",
            "deepseek-v4.1-flash",
            "glm-5.3",
            "deepseek-v4-pro:0813",
            "kimi-k3",
            "minimax-m3",
            "gpt-oss:120b",
        ],
    },
    ProviderSpec {
        id: "ollama_local",
        label: "Ollama (local)",
        wire: Wire::Ollama,
        default_base_url: "http://localhost:11434",
        env_key: None,
        requires_key: false,
        logprobs: true,
        fallback_models: &[],
    },
    ProviderSpec {
        id: "openai",
        label: "OpenAI",
        wire: Wire::OpenAi,
        default_base_url: "https://api.openai.com/v1",
        env_key: Some("OPENAI_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &["gpt-5", "gpt-5-mini", "gpt-4.1"],
    },
    ProviderSpec {
        id: "anthropic",
        label: "Anthropic",
        wire: Wire::Anthropic,
        default_base_url: "https://api.anthropic.com/v1",
        env_key: Some("ANTHROPIC_API_KEY"),
        requires_key: true,
        logprobs: false,
        fallback_models: &["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
    },
    ProviderSpec {
        id: "gemini",
        label: "Google Gemini",
        wire: Wire::OpenAi,
        default_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        env_key: Some("GEMINI_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    ProviderSpec {
        id: "xai",
        label: "xAI Grok",
        wire: Wire::OpenAi,
        default_base_url: "https://api.x.ai/v1",
        env_key: Some("XAI_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &["grok-4", "grok-code-fast-1"],
    },
    ProviderSpec {
        id: "groq",
        label: "Groq",
        wire: Wire::OpenAi,
        default_base_url: "https://api.groq.com/openai/v1",
        env_key: Some("GROQ_API_KEY"),
        requires_key: true,
        logprobs: false,
        fallback_models: &["openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct"],
    },
    ProviderSpec {
        id: "openrouter",
        label: "OpenRouter",
        wire: Wire::OpenAi,
        default_base_url: "https://openrouter.ai/api/v1",
        env_key: Some("OPENROUTER_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &[],
    },
    ProviderSpec {
        id: "deepseek",
        label: "DeepSeek",
        wire: Wire::OpenAi,
        default_base_url: "https://api.deepseek.com/v1",
        env_key: Some("DEEPSEEK_API_KEY"),
        requires_key: true,
        logprobs: true,
        fallback_models: &["deepseek-chat", "deepseek-reasoner"],
    },
    ProviderSpec {
        id: "mistral",
        label: "Mistral",
        wire: Wire::OpenAi,
        default_base_url: "https://api.mistral.ai/v1",
        env_key: Some("MISTRAL_API_KEY"),
        requires_key: true,
        logprobs: false,
        fallback_models: &["mistral-large-latest", "codestral-latest"],
    },
    ProviderSpec {
        id: "custom",
        label: "Custom (OpenAI-compatible)",
        wire: Wire::OpenAi,
        default_base_url: "http://localhost:1234/v1",
        env_key: None,
        requires_key: false,
        logprobs: true,
        fallback_models: &[],
    },
];

pub fn find(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Model ids that are clearly not chat models (embeddings, audio, images, ...).
pub fn is_chat_model(id: &str) -> bool {
    const SKIP: &[&str] = &[
        "embed", "tts", "whisper", "dall-e", "moderation", "transcribe", "realtime", "audio",
        "imagen", "image", "veo", "aqa", "search-preview", "omni-moderation", "babbage", "davinci",
    ];
    let lower = id.to_ascii_lowercase();
    !SKIP.iter().any(|s| lower.contains(s))
}
