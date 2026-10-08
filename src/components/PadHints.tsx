import { useEffect, useState } from "react";
import { onPadActive } from "../lib/pad";

const HINTS: [string, string][] = [
  ["✥", "move"],
  ["A", "select"],
  ["B", "back"],
  ["X", "type"],
  ["Y", "renderer"],
  ["☰", "config"],
  ["⧉", "models"],
  ["LT/RT", "scroll"],
  ["R-stick", "gaze"],
];

/** Button legend along the bottom edge while the controller is driving the UI. */
export default function PadHints() {
  const [active, setActive] = useState(false);
  useEffect(() => onPadActive(setActive), []);
  if (!active) return null;
  return (
    <div className="pad-hints" aria-hidden>
      {HINTS.map(([glyph, label]) => (
        <span key={label}>
          <b>{glyph}</b> {label}
        </span>
      ))}
    </div>
  );
}
