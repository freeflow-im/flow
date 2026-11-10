// The assistant in Mail: in the suite's dock (packages/suite-bar, AssistantDock.tsx), floating over the mail or,
// anchored, a panel on the right as Docs' is (beside the list and the message; over them on narrow screens). The chat's replies and tool labels are Docs' own (lib/docsAgent.ts); a draft the assistant made has
// "Open draft", which opens it in Compose, and links to messages in Mail open them here rather than in a new tab.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Loader2, Pencil, Sparkles } from 'lucide-react';
import { AssistantDockControls, useAssistantDock, useIdleMinimize } from '@flow/suite-bar/assistant-dock';
import { draftOf, refOfLink, savedFileOf, type MessageRef } from '../lib/assistant';
import { ChatMarkdown, picturesOf, toolLabel, type ChatItem } from '../lib/docsAgent';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import type { useMailAssistant } from '../hooks/assistant';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const MESSAGE_SUGGESTIONS = ['Summarize this email', 'Draft a reply to this', 'Save the attachments to Docs'];
const LIST_SUGGESTIONS = ['What needs an answer from me today?', 'What did I get last week about invoices?', 'Draft an email to the team about Friday'];

export interface AssistantPanelProps {
  chat: ReturnType<typeof useMailAssistant>;
  /** Whether a message is open (the suggestions are about it). */
  onMessage: boolean;
  /** Over the mail, the whole width of a narrow screen, rather than beside it. */
  overlay: boolean;
  width: number;
  onClose(): void;
  onShow(ref: MessageRef): void;
  onOpenDraft(ref: MessageRef): void;
}

export function AssistantPanel({ chat, onMessage, overlay, width, onClose, onShow, onOpenDraft }: AssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const docked = useAssistantDock().placement === 'docked';
  // Floating and idle (no new text from either side), the panel minimizes to the pill; not while a turn runs.
  useIdleMinimize([chat.items, draft], chat.running);

  useEffect(() => inputRef.current?.focus(), []);
  // The newest message stays in view while the reply streams in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.error, chat.running]);
  // The input grows with its text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = (text: string) => {
    if (!text.trim() || chat.running) return;
    chat.send(text);
    setDraft('');
  };
  const last = chat.items[chat.items.length - 1];
  const thinking = chat.running && last?.kind !== 'assistant';
  const pictures = useMemo(() => picturesOf(chat.items), [chat.items]);

  return (
    <aside
      aria-label="Assistant"
      data-testid="mail-assistant"
      style={docked && !overlay ? { width } : undefined}
      className={cn('flex min-h-0 flex-col bg-white', !docked ? 'relative' : overlay ? 'absolute inset-0 z-30 shadow-xl' : 'relative shrink-0 border-l border-hairline')}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <Sparkles className="size-4 text-primary" />
        <span className="text-[16px] font-semibold">Assistant</span>
        <span className="flex-1" />
        <Button variant="link" size="sm" className="h-7 px-1.5" onClick={() => void chat.reset()} disabled={chat.running || !chat.items.length} title="Start a new conversation">
          New chat
        </Button>
        <AssistantDockControls />
      </div>

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-sm"
        onClickCapture={(e) => {
          // A link to a message in Mail opens it here.
          const a = (e.target as HTMLElement).closest('a');
          const ref = a?.href ? refOfLink(a.href) : null;
          if (!ref) return;
          e.preventDefault();
          onShow(ref);
        }}
      >
        {chat.items.length === 0 && (
          <div className="flex flex-col gap-2 text-muted">
            <p className="mb-1">Ask me to find, summarize or answer your email. I write drafts for you to check and send; I never send email myself.</p>
            {(onMessage ? MESSAGE_SUGGESTIONS : LIST_SUGGESTIONS).map((s) => (
              <button key={s} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-ink hover:bg-hover" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {chat.items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-primary-tint px-3 py-2 text-ink">
              {it.text}
            </div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="mail-agent-md text-ink">
              <ChatMarkdown text={it.text.trim()} pictures={pictures} />
            </div>
          ) : (
            <ToolRow key={it.id} item={it} onOpenDraft={onOpenDraft} />
          ),
        )}
        {thinking && (
          <div className="flex items-center gap-2 text-muted" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> Working…
          </div>
        )}
        {chat.error && <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-danger">{chat.error}</div>}
      </div>

      <form
        className="flex shrink-0 items-end gap-2 border-t border-hairline p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          aria-label="Message the assistant"
          placeholder={onMessage ? 'Ask about this email…' : 'Ask about your mail…'}
          className="min-h-9 flex-1 resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(draft);
            }
            if (e.key === 'Escape') onClose();
          }}
        />
        {chat.running ? (
          <Button type="button" variant="outline" onClick={chat.stop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!draft.trim()}>
            Send
          </Button>
        )}
      </form>
    </aside>
  );
}

/** A tool call: its label (Docs' describe.ts), and for a draft or a saved file, the way to it. */
function ToolRow({ item, onOpenDraft }: { item: ToolItem; onOpenDraft(ref: MessageRef): void }) {
  const draft = draftOf(item);
  const saved = savedFileOf(item);
  return (
    <div className="flex flex-col gap-1.5" title={item.error}>
      <div className={cn('flex items-center gap-2 text-[14px]', item.status === 'error' ? 'text-danger' : 'text-muted')}>
        {item.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : item.status === 'ok' ? <Check className="size-3.5" /> : <AlertCircle className="size-3.5" />}
        <span>{toolLabel(item.name, item.input)}</span>
        {item.status === 'error' && <span className="text-[13px]">{item.error === 'Stopped' ? '· Stopped' : '· Failed'}</span>}
      </div>
      {draft && (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => onOpenDraft(draft)}>
          <Pencil className="size-3.5" /> Open draft
        </Button>
      )}
      {saved && (
        <Button size="sm" variant="outline" className="self-start" asChild>
          <a href={saved.href} target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" /> Open {saved.name} in Docs
          </a>
        </Button>
      )}
    </div>
  );
}
