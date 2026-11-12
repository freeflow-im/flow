// The assistant in Calendar: in the suite's dock (packages/suite-bar, AssistantDock.tsx), floating over the calendar or,
// anchored, a panel on the right as Mail's is (beside the calendar; over it on narrow screens). The chat's replies and tool labels are Docs' own (lib/docsAgent.ts); an event the assistant made or changed has "Open event",
// links to events in Calendar open their card here, and a delete the assistant asks for waits for Delete or Keep.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, CalendarDays, Check, Loader2, Sparkles } from 'lucide-react';
import { AssistantDockControls, useAssistantDock, useIdleMinimize } from '@flow/suite-bar/assistant-dock';
import { useSuggestedPrompts } from '@flow/suite-bar';
import { eventOfLink, madeEventOf } from '../lib/assistant';
import { ChatMarkdown, toolLabel, ToolPictures, type ChatItem } from '../lib/docsAgent';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import type { useCalendarAssistant } from '../hooks/assistant';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** Calendar's own default for an open event, offered while the organization has not changed Calendar's prompts. */
const EVENT_SUGGESTIONS = ['Who is coming to this?', 'Move this to tomorrow at the same time', 'Find a time next week for a follow-up'];

export interface AssistantPanelProps {
  chat: ReturnType<typeof useCalendarAssistant>;
  /** The organization whose suggested prompts it offers (Admin → Prompts). */
  organizationId: string | null;
  /** Whether an event's card is open (the suggestions are about it). */
  onEvent: boolean;
  /** Over the calendar, the whole width of a narrow screen, rather than beside it. */
  overlay: boolean;
  width: number;
  onClose(): void;
  onOpenEvent(id: string, start?: string): void;
}

export function AssistantPanel({ chat, organizationId, onEvent, overlay, width, onClose, onOpenEvent }: AssistantPanelProps) {
  const suggestions = useSuggestedPrompts(organizationId, 'calendar', onEvent ? EVENT_SUGGESTIONS : undefined);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const docked = useAssistantDock().placement === 'docked';
  // Floating and idle (no new text from either side), the panel minimizes to the pill; not while a turn runs or a question waits.
  useIdleMinimize([chat.items, draft], chat.running || !!chat.question);

  useEffect(() => inputRef.current?.focus(), []);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items, chat.error, chat.running, chat.question]);
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
  const thinking = chat.running && last?.kind !== 'assistant' && !chat.question;

  return (
    <aside aria-label="Assistant" data-testid="calendar-assistant" style={docked && !overlay ? { width } : undefined}
      className={cn('flex min-h-0 flex-col bg-white', !docked ? 'relative' : overlay ? 'absolute inset-0 z-30 shadow-xl' : 'relative shrink-0 border-l border-hairline')}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <Sparkles className="size-4 text-primary" />
        <span className="text-[16px] font-semibold">Assistant</span>
        <span className="flex-1" />
        <Button variant="link" size="sm" className="h-7 px-1.5" onClick={() => void chat.reset()} disabled={chat.running || !chat.items.length} title="Start a new conversation">New chat</Button>
        <AssistantDockControls />
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-sm"
        onClickCapture={(e) => {
          // A link to an event in Calendar opens its card here.
          const a = (e.target as HTMLElement).closest('a');
          const id = a?.href ? eventOfLink(a.href) : null;
          if (!id) return;
          e.preventDefault();
          onOpenEvent(id);
        }}>
        {chat.items.length === 0 && (
          <div className="flex flex-col gap-2 text-muted">
            <p className="mb-1">Ask me about your calendar: what is coming up, when people are free, or to add, move or answer events. I say what I changed, and I ask before deleting anything.</p>
            {suggestions.map((s) => (
              <button key={s} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-ink hover:bg-hover" onClick={() => submit(s)}>{s}</button>
            ))}
          </div>
        )}
        {chat.items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-primary-tint px-3 py-2 text-ink">{it.text}</div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="text-ink"><ChatMarkdown text={it.text.trim()} /></div>
          ) : (
            <ToolRow key={it.id} item={it} onOpenEvent={onOpenEvent} />
          ),
        )}
        {chat.question && (
          <div role="alertdialog" aria-label="Confirm" className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-3">
            <p className="text-ink">{chat.question.text}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" autoFocus onClick={() => chat.question?.answer(true)}>Delete</Button>
              <Button size="sm" variant="outline" onClick={() => chat.question?.answer(false)}>Keep it</Button>
            </div>
          </div>
        )}
        {thinking && <div className="flex items-center gap-2 text-muted" aria-live="polite"><Loader2 className="size-4 animate-spin" /> Working…</div>}
        {chat.error && <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-danger">{chat.error}</div>}
      </div>

      <form className="flex shrink-0 items-end gap-2 border-t border-hairline p-3" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
        <textarea ref={inputRef} rows={1} value={draft} aria-label="Message the assistant" placeholder={onEvent ? 'Ask about this event…' : 'Ask about your calendar…'}
          className="min-h-9 flex-1 resize-none rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(draft); }
            if (e.key === 'Escape') onClose();
          }} />
        {chat.running ? <Button type="button" variant="outline" onClick={chat.stop}>Stop</Button> : <Button type="submit" disabled={!draft.trim()}>Send</Button>}
      </form>
    </aside>
  );
}

/** A tool call: its label (Docs' describe.ts), and for an event made or changed, the way to it. */
function ToolRow({ item, onOpenEvent }: { item: ToolItem; onOpenEvent(id: string, start?: string): void }) {
  const made = madeEventOf(item);
  return (
    <div className="flex flex-col gap-1.5" title={item.error}>
      <div className={cn('flex items-center gap-2 text-[14px]', item.status === 'error' ? 'text-danger' : 'text-muted')}>
        {item.status === 'running' ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : item.status === 'ok' ? <Check className="size-3.5 shrink-0" /> : <AlertCircle className="size-3.5 shrink-0" />}
        <span>{toolLabel(item.name, item.input)}</span>
        {item.status === 'error' && <span className="text-[13px]">{item.error === 'Stopped' ? '· Stopped' : '· Failed'}</span>}
      </div>
      <ToolPictures images={item.images} />
      {made && (
        <Button size="sm" variant="secondary" className="self-start" onClick={() => onOpenEvent(made.id, made.start)}>
          <CalendarDays className="size-3.5" /> Open event
        </Button>
      )}
    </div>
  );
}
