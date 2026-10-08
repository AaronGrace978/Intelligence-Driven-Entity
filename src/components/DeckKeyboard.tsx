import { useEffect, useState, type PointerEvent } from "react";
import { showDeckKeyboard } from "../lib/api";
import { claimPad, onPadActive, rememberFocus, type PadAction } from "../lib/pad";
import { applyBackspace, applyEdit, writeField } from "../lib/text-edit";

const ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m", ".", "?"],
];
const ACTIONS = ["SHIFT", "SPACE", "DEL", "ENTER"] as const;
type ActionKey = (typeof ACTIONS)[number];
const LAYOUT: string[][] = [...ROWS, [...ACTIONS]];

type Cursor = [number, number];

/** Moves the controller highlight, keeping the column roughly above or below on rows of other lengths. */
export function moveCursor([r, c]: Cursor, dir: "up" | "down" | "left" | "right"): Cursor {
  if (dir === "left" || dir === "right") {
    const len = LAYOUT[r].length;
    return [r, (c + (dir === "right" ? 1 : -1) + len) % len];
  }
  const nr = Math.max(0, Math.min(LAYOUT.length - 1, r + (dir === "down" ? 1 : -1)));
  if (nr === r) return [r, c];
  const from = LAYOUT[r].length - 1;
  const to = LAYOUT[nr].length - 1;
  return [nr, from ? Math.round((c * to) / from) : 0];
}

function field(node: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (node instanceof HTMLTextAreaElement) return node;
  if (node instanceof HTMLInputElement && node.type !== "checkbox" && node.type !== "button" && !node.readOnly && !node.disabled) {
    return node;
  }
  return null;
}

export default function DeckKeyboard() {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(false);
  const [padMode, setPadMode] = useState(false);
  const [cursor, setCursor] = useState<Cursor>([1, 0]);

  useEffect(() => {
    const sync = () => setOpen(field(document.activeElement) !== null);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);

  useEffect(() => onPadActive(setPadMode), []);

  useEffect(() => {
    document.documentElement.classList.toggle("deck-keyboard", open);
    return () => document.documentElement.classList.remove("deck-keyboard");
  }, [open]);

  const holdFocus = (event: PointerEvent) => {
    event.preventDefault();
  };

  const typeInto = (insert: string) => {
    const el = field(document.activeElement);
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const text = shift && insert.length === 1 && /[a-z]/.test(insert) ? insert.toUpperCase() : insert;
    writeField(el, applyEdit(el.value, start, end, text));
    if (shift && text !== insert) setShift(false);
  };

  const backspace = () => {
    const el = field(document.activeElement);
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    writeField(el, applyBackspace(el.value, start, end));
  };

  const enter = () => {
    const el = field(document.activeElement);
    if (!el) return;
    const send = el.closest(".composer")?.querySelector<HTMLButtonElement>("button.send:not(.stop)");
    if (send && !send.disabled) {
      send.click();
      return;
    }
    if (el instanceof HTMLTextAreaElement) typeInto("\n");
  };

  const runAction = (key: ActionKey) => {
    if (key === "SHIFT") setShift((s) => !s);
    else if (key === "SPACE") typeInto(" ");
    else if (key === "DEL") backspace();
    else enter();
  };

  const pressKey = (key: string) => {
    if ((ACTIONS as readonly string[]).includes(key)) runAction(key as ActionKey);
    else typeInto(key);
  };

  useEffect(() => {
    if (!open) return;
    return claimPad((action: PadAction) => {
      switch (action) {
        case "up":
        case "down":
        case "left":
        case "right":
          setCursor((c) => moveCursor(c, action));
          return true;
        case "a":
          pressKey(LAYOUT[cursor[0]][cursor[1]]);
          return true;
        case "x":
          backspace();
          return true;
        case "y":
          typeInto(" ");
          return true;
        case "lb":
          setShift((s) => !s);
          return true;
        case "start":
          enter();
          return true;
        case "b": {
          const el = document.activeElement;
          rememberFocus(el);
          if (el instanceof HTMLElement) el.blur();
          return true;
        }
        default:
          return false;
      }
    });
  });

  if (!open) return null;

  const keyClass = (r: number, c: number, extra = "") => {
    const lit = padMode && cursor[0] === r && cursor[1] === c ? "pad" : "";
    return [extra, lit].filter(Boolean).join(" ") || undefined;
  };

  return (
    <div className="deck-keys" onPointerDown={holdFocus}>
      {ROWS.map((row, r) => (
        <div className="deck-row" key={row.join("")}>
          {row.map((key, c) => (
            <button key={key} type="button" className={keyClass(r, c)} onPointerDown={holdFocus} onClick={() => typeInto(key)}>
              {shift ? key.toUpperCase() : key}
            </button>
          ))}
        </div>
      ))}
      <div className="deck-row">
        {ACTIONS.map((key, c) => {
          const extra = key === "SHIFT" ? (shift ? "on" : "") : key === "SPACE" ? "space" : key === "ENTER" ? "enter" : "";
          return (
            <button key={key} type="button" className={keyClass(ROWS.length, c, extra)} onPointerDown={holdFocus} onClick={() => runAction(key)}>
              {key}
            </button>
          );
        })}
      </div>
      {padMode && (
        <div className="deck-keys-legend">
          <span>
            <b>A</b> key
          </span>
          <span>
            <b>X</b> delete
          </span>
          <span>
            <b>Y</b> space
          </span>
          <span>
            <b>LB</b> shift
          </span>
          <span>
            <b>☰</b> send
          </span>
          <span>
            <b>B</b> close
          </span>
        </div>
      )}
    </div>
  );
}

export function watchDeckField() {
  const open = () => {
    if (field(document.activeElement)) showDeckKeyboard();
  };
  document.addEventListener("focusin", open);
  return () => document.removeEventListener("focusin", open);
}
