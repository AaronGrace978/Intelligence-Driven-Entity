mod chat;
mod deck;
mod gamepad;
mod models;
mod providers;
mod settings;
mod telemetry;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use tauri::{ipc::Channel, Manager, State};
use tokio_util::sync::CancellationToken;

use chat::{ChatRequest, Session};
use settings::{Preferences, ProviderInfo, Settings};
use telemetry::StreamEvent;

struct AppState {
    client: reqwest::Client,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    streams: Mutex<HashMap<String, CancellationToken>>,
    no_logprobs: Mutex<HashSet<String>>,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> Result<Settings, String> {
        let mut guard = self.settings.lock().map_err(|e| e.to_string())?;
        f(&mut guard);
        guard.save(&self.settings_path)?;
        Ok(guard.clone())
    }
}

fn spec(id: &str) -> Result<&'static providers::ProviderSpec, String> {
    providers::find(id).ok_or_else(|| format!("Unknown provider '{id}'"))
}

#[tauri::command]
fn get_providers(state: State<'_, AppState>) -> Vec<ProviderInfo> {
    settings::provider_infos(&state.settings())
}

/// `None` leaves a field untouched; an empty string clears it back to the default.
#[tauri::command]
fn set_provider_config(
    state: State<'_, AppState>,
    id: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<ProviderInfo>, String> {
    spec(&id)?;
    let s = state.update(|s| {
        let entry = s.providers.entry(id).or_default();
        if let Some(k) = api_key {
            entry.api_key = Some(k.trim().to_string()).filter(|k| !k.is_empty());
        }
        if let Some(u) = base_url {
            entry.base_url = Some(u.trim().to_string()).filter(|u| !u.is_empty());
        }
    })?;
    Ok(settings::provider_infos(&s))
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Preferences {
    state.settings().preferences
}

#[tauri::command]
fn save_preferences(state: State<'_, AppState>, preferences: Preferences) -> Result<(), String> {
    state.update(|s| s.preferences = preferences).map(|_| ())
}

#[tauri::command]
async fn list_models(state: State<'_, AppState>, provider: String) -> Result<models::ModelList, String> {
    let spec = spec(&provider)?;
    let resolved = state.settings().resolve(spec);
    Ok(models::list(&state.client, spec, &resolved).await)
}

#[tauri::command]
async fn chat_stream(
    state: State<'_, AppState>,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let spec = spec(&request.provider)?;
    let resolved = state.settings().resolve(spec);
    let cancel = CancellationToken::new();
    let stream_id = request.stream_id.clone();
    if let Ok(mut streams) = state.streams.lock() {
        streams.insert(stream_id.clone(), cancel.clone());
    }

    Session {
        client: &state.client,
        spec,
        resolved,
        request,
        channel: &on_event,
        cancel,
        no_logprobs: &state.no_logprobs,
    }
    .run()
    .await;

    if let Ok(mut streams) = state.streams.lock() {
        streams.remove(&stream_id);
    }
    Ok(())
}

#[tauri::command]
fn cancel_stream(state: State<'_, AppState>, stream_id: String) {
    if let Some(token) = state.streams.lock().ok().and_then(|s| s.get(&stream_id).cloned()) {
        token.cancel();
    }
}

#[derive(serde::Serialize)]
struct DeckStatus {
    deck: bool,
    #[serde(rename = "gameMode")]
    game_mode: bool,
    controller: bool,
}

#[tauri::command]
fn deck_status() -> DeckStatus {
    let profile = deck::detect_deck(&deck::DeckProbe::from_host());
    DeckStatus {
        deck: profile.deck,
        game_mode: profile.game_mode,
        controller: deck::controller_enabled(profile),
    }
}

#[tauri::command]
fn show_deck_keyboard() {
    deck::request_system_keyboard();
}

fn fit_deck_window(app: &tauri::App, profile: deck::DeckProfile) {
    if !profile.deck {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let physical = monitor.size();
    let scale = deck::ui_scale(profile, monitor.scale_factor());
    if scale <= 0.0 {
        return;
    }
    let spec = deck::session_window(profile, physical.width as f64 / scale, physical.height as f64 / scale);
    let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize {
        width: spec.width.min(800.0),
        height: spec.height.min(480.0),
    })));
    if spec.borderless {
        let _ = window.set_decorations(false);
    }
    // Game Mode must not take the fullscreen state. gamescope is already the
    // fullscreen session, and a second request resizes the surface away from
    // the DMABUF WebKit just allocated.
    let _ = window.set_fullscreen(spec.fullscreen);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: spec.width, height: spec.height }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let profile = deck::detect_deck(&deck::DeckProbe::from_host());
    deck::prepare_webkit(profile);

    tauri::Builder::default()
        .setup(move |app| {
            fit_deck_window(app, profile);
            if deck::controller_enabled(profile) {
                gamepad::spawn(app.handle().clone());
            }
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .user_agent(concat!("the-entity/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                client,
                settings: Mutex::new(Settings::load(&settings_path)),
                settings_path,
                streams: Mutex::new(HashMap::new()),
                no_logprobs: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_providers,
            set_provider_config,
            get_preferences,
            save_preferences,
            list_models,
            chat_stream,
            cancel_stream,
            deck_status,
            show_deck_keyboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running the entity");
}
