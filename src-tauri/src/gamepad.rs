use std::time::Duration;

use gilrs::{Axis, Button, EventType, Gilrs};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// What the webview receives on the `gamepad` event. Names follow the Xbox layout that Steam Input
/// presents in Game Mode, so the frontend never sees evdev codes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PadEvent {
    Button { button: &'static str, pressed: bool },
    Axis { axis: &'static str, value: f32 },
    Connected { name: String },
    Disconnected,
}

fn button_name(button: Button) -> Option<&'static str> {
    Some(match button {
        Button::South => "south",
        Button::East => "east",
        Button::North => "north",
        Button::West => "west",
        Button::LeftTrigger => "lb",
        Button::RightTrigger => "rb",
        Button::LeftTrigger2 => "lt",
        Button::RightTrigger2 => "rt",
        Button::Select => "select",
        Button::Start => "start",
        Button::Mode => "mode",
        Button::LeftThumb => "ls",
        Button::RightThumb => "rs",
        Button::DPadUp => "up",
        Button::DPadDown => "down",
        Button::DPadLeft => "left",
        Button::DPadRight => "right",
        _ => return None,
    })
}

fn axis_name(axis: Axis) -> Option<&'static str> {
    Some(match axis {
        Axis::LeftStickX => "leftX",
        Axis::LeftStickY => "leftY",
        Axis::RightStickX => "rightX",
        Axis::RightStickY => "rightY",
        _ => return None,
    })
}

/// Sticks report every tiny wobble; 1/50 steps keep the IPC traffic to what the UI can see.
fn quantize(value: f32) -> f32 {
    (value.clamp(-1.0, 1.0) * 50.0).round() / 50.0
}

/// The parts of a gilrs event this app reacts to, without the evdev `Code` gilrs cannot construct.
#[derive(Debug, Clone, Copy)]
pub enum Raw {
    Pressed(Button),
    Released(Button),
    Changed(Button, f32),
    Moved(Axis, f32),
    Disconnected,
}

impl Raw {
    fn from_gilrs(event: &EventType) -> Option<Self> {
        Some(match *event {
            EventType::ButtonPressed(b, _) => Raw::Pressed(b),
            EventType::ButtonReleased(b, _) => Raw::Released(b),
            EventType::ButtonChanged(b, v, _) => Raw::Changed(b, v),
            EventType::AxisChanged(a, v, _) => Raw::Moved(a, v),
            EventType::Disconnected => Raw::Disconnected,
            _ => return None,
        })
    }
}

pub fn translate(raw: Raw) -> Option<PadEvent> {
    match raw {
        Raw::Pressed(button) => Some(PadEvent::Button { button: button_name(button)?, pressed: true }),
        Raw::Released(button) => Some(PadEvent::Button { button: button_name(button)?, pressed: false }),
        Raw::Changed(Button::LeftTrigger2, value) => Some(PadEvent::Axis { axis: "leftTrigger", value: quantize(value) }),
        Raw::Changed(Button::RightTrigger2, value) => Some(PadEvent::Axis { axis: "rightTrigger", value: quantize(value) }),
        Raw::Changed(..) => None,
        Raw::Moved(axis, value) => Some(PadEvent::Axis { axis: axis_name(axis)?, value: quantize(value) }),
        Raw::Disconnected => Some(PadEvent::Disconnected),
    }
}

/// Reads controllers on a background thread for the life of the app. Without a usable input
/// backend (no udev, a sandbox) the thread logs once and exits; the mouse and touch UI still work.
pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("gamepad".into()).spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("the-entity: controller input unavailable: {e}");
                return;
            }
        };
        for (_, pad) in gilrs.gamepads() {
            let _ = app.emit("gamepad", PadEvent::Connected { name: pad.name().to_string() });
        }
        let mut last = PadEvent::Disconnected;
        loop {
            let Some(ev) = gilrs.next_event_blocking(Some(Duration::from_millis(500))) else {
                continue;
            };
            let out = match ev.event {
                EventType::Connected => PadEvent::Connected { name: gilrs.gamepad(ev.id).name().to_string() },
                ref other => match Raw::from_gilrs(other).and_then(translate) {
                    Some(out) => out,
                    None => continue,
                },
            };
            if matches!(out, PadEvent::Axis { .. }) && out == last {
                continue;
            }
            last = out.clone();
            let _ = app.emit("gamepad", out);
        }
    });
    if let Err(e) = spawned {
        eprintln!("the-entity: could not start controller thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn face_buttons_use_xbox_positions() {
        assert_eq!(
            translate(Raw::Pressed(Button::South)),
            Some(PadEvent::Button { button: "south", pressed: true })
        );
        assert_eq!(
            translate(Raw::Released(Button::DPadLeft)),
            Some(PadEvent::Button { button: "left", pressed: false })
        );
    }

    #[test]
    fn analog_triggers_become_axes() {
        assert_eq!(
            translate(Raw::Changed(Button::RightTrigger2, 0.731)),
            Some(PadEvent::Axis { axis: "rightTrigger", value: 0.74 })
        );
        assert_eq!(translate(Raw::Changed(Button::South, 1.0)), None);
    }

    #[test]
    fn stick_values_are_quantized_and_clamped() {
        assert_eq!(
            translate(Raw::Moved(Axis::LeftStickY, -1.4)),
            Some(PadEvent::Axis { axis: "leftY", value: -1.0 })
        );
        assert_eq!(translate(Raw::Moved(Axis::LeftZ, 0.5)), None);
    }

    #[test]
    fn events_serialize_with_a_kind_tag() {
        let json = serde_json::to_string(&PadEvent::Button { button: "start", pressed: true }).unwrap();
        assert_eq!(json, r#"{"kind":"button","button":"start","pressed":true}"#);
    }
}
