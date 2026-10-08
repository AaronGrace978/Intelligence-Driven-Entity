import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../lib/types";

const SUGGESTIONS = [
  "Who are you, and what are you made of?",
  "Write a Rust function that streams NDJSON lines.",
  "Make a guess about something you are unsure of.",
  "Simulate a failing build.",
];

const Message = memo(function Message({ m }: { m: ChatMessage }) {
  const [showTrace, setShowTrace] = useState(false);
  const isUser = m.role === "user";
  return (
    <article className={`msg ${m.role} ${m.status ?? ""}`}>
      <header className="msg-head">
        <span className="msg-who">{isUser ? "> OPERATOR" : "◆ ENTITY"}</span>
        {!isUser && m.model && <span className="msg-model">{m.model}</span>}
      </header>
      {m.reasoning && (
        <div className={`trace ${showTrace ? "open" : ""}`}>
          <button className="trace-toggle" onClick={() => setShowTrace((s) => !s)}>
            {showTrace ? "▾" : "▸"} reasoning trace · {m.reasoning.length} chars
          </button>
          {showTrace && <pre className="trace-body">{m.reasoning}</pre>}
        </div>
      )}
      <div className="msg-body">
        {isUser ? (
          <p className="plain">{m.content}</p>
        ) : m.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
        ) : m.status === "streaming" ? (
          <p className="awaiting">
            <span className="cursor-block" /> {m.reasoning ? "reasoning…" : "establishing signal…"}
          </p>
        ) : null}
        {m.status === "streaming" && m.content && <span className="cursor-block" />}
      </div>
      {m.error && <div className="msg-error">!! {m.error}</div>}
      {m.status === "cancelled" && <div className="msg-note">— transmission severed —</div>}
      {m.stats && (
        <footer className="msg-stats">
          <span>{m.stats.tokens} tok</span>
          <span>{m.stats.tps.toFixed(1)} tok/s</span>
          <span>{(m.stats.elapsedMs / 1000).toFixed(2)}s</span>
          <span>conf {m.stats.confidence === null ? "n/a" : m.stats.confidence.toFixed(3)}</span>
        </footer>
      )}
    </article>
  );
});

export default function ChatPanel({
  messages,
  streaming,
  canSend,
  hint,
  onSend,
  onStop,
  onClear,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  canSend: boolean;
  hint: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const autoTop = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
      autoTop.current = el.scrollTop;
    }
  }, [messages]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [draft]);

  const submit = (text = draft) => {
    const t = text.trim();
    if (!t || streaming || !canSend) return;
    onSend(t);
    setDraft("");
    stick.current = true;
  };

  return (
    <section className="chat">
      <header className="chat-head">
        <div>
          <div className="hud-kicker">TRANSMISSION LOG</div>
          <div className="chat-count">{messages.length} packets</div>
        </div>
        <button className="ghost" onClick={onClear} disabled={streaming || messages.length === 0}>
          PURGE
        </button>
      </header>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          // Content can grow between our own scrollTop write and this event, so only a move
          // above the last auto-scroll position counts as the user scrolling away.
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) stick.current = true;
          else if (el.scrollTop < autoTop.current - 4) stick.current = false;
        }}
      >
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-title">AWAITING INPUT</div>
            <p>Every token reshapes the entity. Pick a link and a model, then speak.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)} disabled={!canSend}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} />)
        )}
      </div>

      <footer className="composer">
        {hint && <div className="composer-hint">{hint}</div>}
        <div className="composer-row">
          <span className="prompt-sigil">&gt;_</span>
          <textarea
            ref={area}
            rows={1}
            value={draft}
            placeholder={canSend ? "transmit to the entity…  (Enter to send · Shift+Enter newline)" : "link a model to begin"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {streaming ? (
            <button className="send stop" onClick={onStop}>
              SEVER
            </button>
          ) : (
            <button className="send" onClick={() => submit()} disabled={!canSend || !draft.trim()}>
              SEND
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
