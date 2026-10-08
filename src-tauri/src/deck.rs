use std::collections::HashMap;
use std::process::Command;

/// Valve board names. Jupiter is the LCD Deck, Galileo is the OLED Deck.
const DECK_BOARDS: &[&str] = &["jupiter", "galileo"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeckProfile {
    pub deck: bool,
    pub game_mode: bool,
}

pub struct DeckProbe {
    pub env: HashMap<String, String>,
    pub board_name: Option<String>,
    pub os_release: Option<String>,
}

impl DeckProbe {
    pub fn from_host() -> Self {
        Self {
            env: std::env::vars().collect(),
            board_name: std::fs::read_to_string("/sys/devices/virtual/dmi/id/board_name")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            os_release: std::fs::read_to_string("/etc/os-release").ok(),
        }
    }
}

pub fn detect_deck(probe: &DeckProbe) -> DeckProfile {
    let env = &probe.env;
    let game_mode = env.get("SteamGamepadUI").map(|v| v == "1").unwrap_or(false)
        || env
            .get("XDG_CURRENT_DESKTOP")
            .map(|v| v.eq_ignore_ascii_case("gamescope"))
            .unwrap_or(false)
        || env.contains_key("GAMESCOPE_WAYLAND_DISPLAY");

    if let Some(forced) = env.get("ENTITY_DECK") {
        let deck = forced == "1";
        return DeckProfile {
            deck,
            game_mode: deck && game_mode,
        };
    }

    let deck = env.get("SteamDeck").map(|v| v == "1").unwrap_or(false)
        || env.get("STEAM_DECK").map(|v| v == "1").unwrap_or(false)
        || env.get("SteamOS").map(|v| v == "1").unwrap_or(false)
        || probe
            .board_name
            .as_deref()
            .map(|name| DECK_BOARDS.iter().any(|board| name.eq_ignore_ascii_case(board)))
            .unwrap_or(false)
        || probe
            .os_release
            .as_deref()
            .map(|release| release.lines().any(|line| line == "ID=steamos" || line == "ID=\"steamos\""))
            .unwrap_or(false);

    DeckProfile { deck, game_mode: deck && game_mode }
}

/// Steam Deck panel, LCD and OLED. Game Mode shortcuts are often given a larger
/// gamescope resolution than this, and rendering that is what makes the face stutter.
const PANEL_WIDTH: f64 = 1280.0;
const PANEL_HEIGHT: f64 = 800.0;

/// What to ask of WebKit before GTK starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebKitPrep {
    /// `GDK_SCALE` / `GDK_DPI_SCALE`. `None` leaves the desktop session's scale alone.
    pub gdk_scale: Option<&'static str>,
}

/// Game Mode used to set `WEBKIT_DISABLE_DMABUF_RENDERER=1` so taps lined up under
/// gamescope. That flag copies every composited frame through the CPU, which is why
/// the face runs smoothly in Desktop Mode (DMABUF left on, KWin) and stutters in
/// Game Mode. Keep the GPU path. Pinning the scale to 1 makes the DMABUF the same
/// size as the surface, so taps still land.
pub fn webkit_prep(profile: DeckProfile) -> WebKitPrep {
    if profile.game_mode {
        WebKitPrep { gdk_scale: Some("1") }
    } else {
        WebKitPrep { gdk_scale: None }
    }
}

pub fn prepare_webkit(profile: DeckProfile) {
    if let Some(scale) = webkit_prep(profile).gdk_scale {
        std::env::set_var("GDK_SCALE", scale);
        std::env::set_var("GDK_DPI_SCALE", scale);
    }
}

/// Scale used to turn the monitor's physical pixels into a window size.
/// Game Mode always uses 1, matching `webkit_prep`, even if gamescope reports 2.
pub fn ui_scale(profile: DeckProfile, monitor_scale: f64) -> f64 {
    if profile.game_mode { 1.0 } else { monitor_scale }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionWindow {
    pub width: f64,
    pub height: f64,
    pub borderless: bool,
    /// Gamescope is already the fullscreen session. Requesting fullscreen again
    /// changes the surface size out from under WebKit's DMABUF.
    pub fullscreen: bool,
}

/// `width` and `height` are the monitor size in the pixels `ui_scale` selected.
pub fn session_window(profile: DeckProfile, width: f64, height: f64) -> SessionWindow {
    if profile.game_mode {
        SessionWindow {
            width: width.min(PANEL_WIDTH).max(320.0),
            height: height.min(PANEL_HEIGHT).max(240.0),
            borderless: true,
            fullscreen: false,
        }
    } else if profile.deck {
        let (width, height) = fitted_window(width, height);
        SessionWindow { width, height, borderless: false, fullscreen: false }
    } else {
        SessionWindow { width, height, borderless: false, fullscreen: false }
    }
}

/// Desktop Mode maps the Deck controller to mouse and keys through Steam's desktop layout, so
/// reading the pad there too would act on every press twice.
pub fn controller_enabled(profile: DeckProfile) -> bool {
    !profile.deck || profile.game_mode
}

/// Logical window size that fits the Deck panel instead of the 1440×900 desktop default.
pub fn fitted_window(screen_width: f64, screen_height: f64) -> (f64, f64) {
    (screen_width.max(320.0), screen_height.max(240.0))
}

/// Ask the desktop session for its on-screen keyboard. Failures are ignored:
/// Game Mode has no KWin keyboard, and the in-app keyboard covers that case.
pub fn request_system_keyboard() {
    let attempts: &[(&str, &[&str])] = &[
        (
            "busctl",
            &[
                "--user",
                "call",
                "org.kde.KWin",
                "/VirtualKeyboard",
                "org.kde.kwin.VirtualKeyboard",
                "forceShow",
            ],
        ),
        (
            "qdbus6",
            &["org.kde.KWin", "/VirtualKeyboard", "org.kde.kwin.VirtualKeyboard.forceShow"],
        ),
        (
            "qdbus",
            &["org.kde.KWin", "/VirtualKeyboard", "org.kde.kwin.VirtualKeyboard.forceShow"],
        ),
    ];
    for (program, args) in attempts {
        if Command::new(program).args(*args).spawn().is_ok() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(pairs: &[(&str, &str)], board: Option<&str>, release: Option<&str>) -> DeckProbe {
        DeckProbe {
            env: pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect(),
            board_name: board.map(|s| s.to_string()),
            os_release: release.map(|s| s.to_string()),
        }
    }

    #[test]
    fn a_desktop_pc_is_not_a_deck() {
        let profile = detect_deck(&probe(&[], None, Some("ID=ubuntu\n")));
        assert!(!profile.deck);
        assert!(!profile.game_mode);
    }

    #[test]
    fn steamdeck_env_and_jupiter_board_count() {
        assert!(detect_deck(&probe(&[("SteamDeck", "1")], None, None)).deck);
        assert!(detect_deck(&probe(&[], Some("Jupiter"), None)).deck);
        assert!(detect_deck(&probe(&[], Some("galileo"), None)).deck);
    }

    #[test]
    fn steamos_release_counts_even_without_the_env_flag() {
        let profile = detect_deck(&probe(&[], None, Some("NAME=SteamOS\nID=steamos\n")));
        assert!(profile.deck);
        assert!(!profile.game_mode);
    }

    #[test]
    fn gamescope_is_game_mode_only_when_it_is_also_a_deck() {
        let profile = detect_deck(&probe(
            &[("SteamDeck", "1"), ("SteamGamepadUI", "1")],
            None,
            None,
        ));
        assert!(profile.deck);
        assert!(profile.game_mode);
        let desktop = detect_deck(&probe(&[("GAMESCOPE_WAYLAND_DISPLAY", "gamescope-0")], None, None));
        assert!(!desktop.deck);
    }

    #[test]
    fn entity_deck_override_wins() {
        assert!(!detect_deck(&probe(&[("SteamDeck", "1"), ("ENTITY_DECK", "0")], None, None)).deck);
        assert!(detect_deck(&probe(&[("ENTITY_DECK", "1")], None, None)).deck);
    }

    #[test]
    fn the_controller_is_read_everywhere_except_deck_desktop_mode() {
        assert!(controller_enabled(DeckProfile { deck: false, game_mode: false }));
        assert!(controller_enabled(DeckProfile { deck: true, game_mode: true }));
        assert!(!controller_enabled(DeckProfile { deck: true, game_mode: false }));
    }

    #[test]
    fn the_fitted_window_uses_the_panel_size() {
        assert_eq!(fitted_window(1280.0, 800.0), (1280.0, 800.0));
    }

    #[test]
    fn game_mode_keeps_the_gpu_path_and_pins_scale() {
        let game = webkit_prep(DeckProfile { deck: true, game_mode: true });
        assert_eq!(game.gdk_scale, Some("1"));
        assert_eq!(webkit_prep(DeckProfile { deck: true, game_mode: false }).gdk_scale, None);
        assert_eq!(webkit_prep(DeckProfile { deck: false, game_mode: false }).gdk_scale, None);
        assert_eq!(ui_scale(DeckProfile { deck: true, game_mode: true }, 2.0), 1.0);
        assert_eq!(ui_scale(DeckProfile { deck: true, game_mode: false }, 1.25), 1.25);
    }

    #[test]
    fn game_mode_fills_the_panel_without_a_second_fullscreen() {
        let game = session_window(DeckProfile { deck: true, game_mode: true }, 1920.0, 1080.0);
        assert_eq!((game.width, game.height), (1280.0, 800.0));
        assert!(game.borderless);
        assert!(!game.fullscreen);

        let native = session_window(DeckProfile { deck: true, game_mode: true }, 1280.0, 800.0);
        assert_eq!((native.width, native.height), (1280.0, 800.0));

        let small = session_window(DeckProfile { deck: true, game_mode: true }, 800.0, 600.0);
        assert_eq!((small.width, small.height), (800.0, 600.0));

        let desktop = session_window(DeckProfile { deck: true, game_mode: false }, 1280.0, 800.0);
        assert_eq!((desktop.width, desktop.height), (1280.0, 800.0));
        assert!(!desktop.borderless);
        assert!(!desktop.fullscreen);
    }
}
