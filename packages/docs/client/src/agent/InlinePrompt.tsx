// The assistant summoned in place: a small prompt at the cursor of an editor. It sends through the same
// conversation as the chat panel (so the panel shows the exchange too) and shows the replies to its own
// latest message in a few scrolling lines. The editor decides where it sits and what closing it does.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isMac, MOD } from '../commands.ts';
import { SparkIcon, ToolRow } from './AgentPanel.tsx';
import { useAgent } from './AgentProvider.tsx';
import { ChatMarkdown } from './ChatMarkdown.tsx';

const WIDTH = 440;
const GAP = 8;

export function InlinePrompt({ anchor, placeholder, onClose }: { /** The cursor on screen; the prompt sits just under it (or above, near the bottom of the window). */ anchor: { left: number; top: number; bottom: number } | null; placeholder: string; onClose(): void }) {
  const agent = useAgent();
  const [draft, setDraft] = useState('');
  // Until this prompt sends something, the conversation's latest reply belongs to the chat panel.
  const [sent, setSent] = useState(false);
  const [height, setHeight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  let lastUser = agent.items.length - 1;
  while (lastUser >= 0 && agent.items[lastUser].kind !== 'user') lastUser--;
  const shown = sent ? agent.items.slice(lastUser + 1) : [];
  const busy = agent.running && sent;
  const thinking = busy && !agent.confirm && shown[shown.length - 1]?.kind !== 'assistant';
  const confirm = sent ? agent.confirm : null;
  const error = sent ? agent.error : null;
  const hasReply = shown.length > 0 || thinking || !!confirm || !!error;

  // Keep the newest line in view while the reply streams in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.items, confirm, error, thinking]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [draft]);

  // The box grows with the reply; its height decides whether it fits under the cursor.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const submit = () => {
    if (!draft.trim() || agent.running) return;
    agent.send(draft, [], { inline: true });
    setSent(true);
    setDraft('');
  };

  const close = () => {
    if (busy) agent.stop();
    onClose();
  };

  const at = anchor ?? { left: (window.innerWidth - WIDTH) / 2, top: 80, bottom: 80 };
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(at.left - 24, window.innerWidth - width - 8));
  const below = at.bottom + GAP;
  const fitsBelow = below + height <= window.innerHeight - 8;
  const top = Math.max(8, Math.min(fitsBelow || at.top - GAP - height < 8 ? below : at.top - GAP - height, window.innerHeight - height - 8));

  return (
    <div
      className="inline-prompt"
      ref={boxRef}
      role="dialog"
      aria-label="Ask the assistant"
      style={{ left, top, width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // The first Escape stops a reply in progress; the next one closes.
          if (busy) agent.stop();
          else close();
        } else if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
          e.preventDefault();
          close();
        }
      }}
    >
      {hasReply && (
        <div className="inline-prompt-reply" ref={listRef} aria-live="polite">
          {shown.map((it, i) =>
            it.kind === 'assistant' ? (
              <div key={i} className="agent-msg assistant">
                <ChatMarkdown text={it.text.trim()} />
              </div>
            ) : it.kind === 'tool' ? (
              <ToolRow key={it.id} item={it} />
            ) : null,
          )}
          {confirm && (
            <div className="agent-confirm" role="alertdialog">
              <div>{confirm.question}</div>
              <div className="agent-confirm-actions">
                <button className="btn" onClick={() => confirm.answer(false)}>
                  Don’t allow
                </button>
                <button className="btn danger" onClick={() => confirm.answer(true)}>
                  Allow
                </button>
              </div>
            </div>
          )}
          {thinking && (
            <div className="agent-working">
              <span />
              <span />
              <span />
            </div>
          )}
          {error && <div className="agent-error">{error}</div>}
        </div>
      )}
      <form
        className="inline-prompt-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="inline-prompt-icon">
          <SparkIcon />
        </span>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={agent.running && !sent ? 'The assistant is busy in the chat panel…' : sent && !busy ? 'Ask for something else…' : placeholder}
          aria-label="Message to the assistant"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn inline-prompt-send" onClick={agent.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary inline-prompt-send" disabled={!draft.trim() || agent.running} title="Send (Enter)">
            Send
          </button>
        )}
        <button type="button" className="inline-prompt-close" onClick={close} aria-label="Close" title={`Close (Esc or ${MOD}J)`}>
          ×
        </button>
      </form>
    </div>
  );
}
