export interface CaretEdit {
  value: string;
  caret: number;
}

export function applyEdit(value: string, start: number, end: number, insert: string): CaretEdit {
  const from = clamp(start, value.length);
  const to = clamp(Math.max(from, end), value.length);
  return { value: value.slice(0, from) + insert + value.slice(to), caret: from + insert.length };
}

export function applyBackspace(value: string, start: number, end: number): CaretEdit {
  const from = clamp(start, value.length);
  const to = clamp(Math.max(from, end), value.length);
  if (from !== to) return applyEdit(value, from, to, "");
  if (from === 0) return { value, caret: 0 };
  return { value: value.slice(0, from - 1) + value.slice(to), caret: from - 1 };
}

function clamp(index: number, length: number): number {
  if (Number.isNaN(index) || index < 0) return 0;
  return Math.min(index, length);
}

export function writeField(el: HTMLInputElement | HTMLTextAreaElement, next: CaretEdit) {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(el, next.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  try {
    el.setSelectionRange(next.caret, next.caret);
  } catch {
    /* A field that refuses a caret still received the text. */
  }
}
