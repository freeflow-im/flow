// Calendar's assistant chat, as Mail's (packages/mail/src/hooks/assistant.ts): the same assistant as Docs' (POST
// /api/agent/turn, streamed), in the Docs object of the organization selected in the suite bar (`?workspace=`), in a chat
// of its own (CALENDAR_CHAT), kept across reloads and apart from Docs' and Mail's. A turn pauses for browser tools;
// Calendar runs open_calendar_event, show_calendar_range and delete_event (after asking) and refuses Docs' own.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGES_CALENDAR, runCalendarClientCalls, type CalendarClientHandlers } from '../lib/assistant';
import { CALENDAR_CHAT, readAgentEvents, type AgentEvent, type AgentTurnRequest, type CalendarContext, type ChatItem, type ClientToolCall } from '../lib/docsAgent';

class TurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const withOrg = (path: string, org: string | null) => (org ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(org)}` : path);

async function failure(res: Response): Promise<TurnError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return new TurnError(res.status, res.status === 401 ? 'You are signed out. Reload the page to sign in again.' : (data.error ?? `Request failed (${res.status})`));
}

async function streamTurn(org: string | null, body: AgentTurnRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void): Promise<void> {
  const res = await fetch(withOrg('/api/agent/turn', org), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(org ? { ...body, workspace: org } : body),
    signal,
  });
  if (!res.ok || !res.body) throw await failure(res);
  if (!(await readAgentEvents(res.body, onEvent))) throw new TurnError(0, 'The connection to the server was interrupted. Send your message again.');
}

export interface CalendarAssistantOptions {
  /** The organization selected in the suite bar, whose Docs holds the chat. */
  org: string | null;
  /** What the user is looking at now, sent with every request of a turn. */
  context(): CalendarContext;
  /** What the browser tools do here (open an event, move the view, delete after asking). */
  handlers: Omit<CalendarClientHandlers, 'confirm'>;
  /** A Calendar tool changed something: the ranges are read again. */
  onCalendarChanged(): void;
}

export function useCalendarAssistant({ org, context, handlers, onCalendarChanged }: CalendarAssistantOptions) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The latest callbacks, for a turn that outlives the render it started in.
  const latest = useRef({ context, handlers, onCalendarChanged });
  latest.current = { context, handlers, onCalendarChanged };
  // A delete_event waiting for the user's answer in the panel.
  const [question, setQuestion] = useState<{ text: string; answer(yes: boolean): void } | null>(null);
  const confirm = useCallback((text: string) => new Promise<boolean>((resolve) => setQuestion({ text, answer: (yes) => { setQuestion(null); resolve(yes); } })), []);

  // The chat, loaded again when the organization changes.
  useEffect(() => {
    setItems([]);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(withOrg(`/api/agent?scope=${CALENDAR_CHAT}`, org), { credentials: 'same-origin' });
        if (!res.ok) throw await failure(res);
        const r = (await res.json()) as { items: ChatItem[] };
        // A message sent before the saved chat arrived goes after it.
        if (!cancelled) setItems((prev) => (prev.length ? [...r.items, ...prev] : r.items));
      } catch {
        // Signed out, or the server is busy: the panel starts empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  const send = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || abortRef.current) return;
      const abort = new AbortController();
      abortRef.current = abort;
      setItems((prev) => [...prev, { kind: 'user', text: message }]);
      setError(null);
      setRunning(true);
      const names = new Map<string, string>();
      const appendText = (t: string) =>
        setItems((prev) => {
          const last = prev[prev.length - 1];
          return last?.kind === 'assistant' ? [...prev.slice(0, -1), { ...last, text: last.text + t }] : [...prev, { kind: 'assistant', text: t }];
        });
      const updateTool = (id: string, patch: Partial<Extract<ChatItem, { kind: 'tool' }>>) => setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, ...patch } : it)));
      const onEvent = (e: AgentEvent, calls: { value: ClientToolCall[] | null }) => {
        if (e.type === 'text') appendText(e.text);
        else if (e.type === 'tool_start') {
          names.set(e.id, e.name);
          setItems((prev) => [...prev, { kind: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' }]);
        } else if (e.type === 'tool_end') {
          updateTool(e.id, { status: e.ok ? 'ok' : 'error', ...(e.result ? { result: e.result } : {}) });
          if (e.ok && CHANGES_CALENDAR.has(names.get(e.id) ?? '')) latest.current.onCalendarChanged();
        } else if (e.type === 'client_tools') calls.value = e.calls;
        else if (e.type === 'error') setError(e.message);
      };

      void (async () => {
        let req: AgentTurnRequest = { message, context: latest.current.context(), scope: CALENDAR_CHAT };
        try {
          for (;;) {
            const calls: { value: ClientToolCall[] | null } = { value: null };
            const turn = () => streamTurn(org, req, abort.signal, (e) => onEvent(e, calls));
            try {
              await turn();
            } catch (e) {
              // Right after Stop the server may still be winding down the previous turn; retry once.
              if (!(e instanceof TurnError && e.status === 409)) throw e;
              await new Promise((r) => setTimeout(r, 1000));
              await turn();
            }
            if (!calls.value || abort.signal.aborted) break;
            const pending = calls.value;
            setItems((prev) => [...prev, ...pending.map((c): ChatItem => ({ kind: 'tool', id: c.id, name: c.name, input: c.input, status: 'running' }))]);
            const toolResults = await runCalendarClientCalls(pending, { ...latest.current.handlers, confirm });
            for (const r of toolResults) updateTool(r.id, { status: r.isError ? 'error' : 'ok', ...(r.isError ? { error: r.content } : {}) });
            if (toolResults.some((r, n) => !r.isError && CHANGES_CALENDAR.has(pending[n]?.name ?? ''))) latest.current.onCalendarChanged();
            if (abort.signal.aborted) break;
            req = { context: latest.current.context(), scope: CALENDAR_CHAT, toolResults };
          }
        } catch (e) {
          if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (abortRef.current === abort) {
            abortRef.current = null;
            setRunning(false);
            // Calls cut off by Stop never finish.
            setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'error', error: 'Stopped' } : it)));
          }
        }
      })();
    },
    [org, confirm],
  );

  const stop = useCallback(() => {
    question?.answer(false);
    abortRef.current?.abort();
  }, [question]);

  const reset = useCallback(async () => {
    if (abortRef.current) return;
    try {
      const res = await fetch(withOrg('/api/agent/reset', org), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: CALENDAR_CHAT }) });
      if (!res.ok) throw await failure(res);
      setItems([]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [org]);

  return { items, running, error, send, stop, reset, question };
}
