// Mail's assistant chat: the same assistant as Docs' (POST /api/agent/turn, streamed), in the Docs object of the
// organization selected in the suite bar (`?workspace=`), in a chat of its own (MAIL_CHAT), so it is kept across reloads
// and apart from Docs' chats. A turn pauses for browser tools; Mail runs open_mail_message and refuses Docs' own
// (lib/assistant.ts). It never sends email: the assistant has no tool that does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGES_MAIL, runMailClientCalls, type MessageRef } from '../lib/assistant';
import { browserExtensionPresent, checkBrowserExtension, MAIL_CHAT, MAX_IMAGES_PER_MESSAGE, readAgentEvents, webPicturesNote, type AgentEvent, type AgentImage, type AgentTurnRequest, type ChatItem, type ClientToolCall, type MailContext } from '../lib/docsAgent';

/** The context, saying whether the FreeFlow browser extension can run the web tools here (prototype). */
const withBrowser = (context: MailContext): AgentTurnRequest['context'] => (browserExtensionPresent() ? { ...context, browser: true } : context);

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
    // The asker's time zone: the turn is told the date and time there.
    headers: { 'Content-Type': 'application/json', 'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone },
    body: JSON.stringify(org ? { ...body, workspace: org } : body),
    signal,
  });
  if (!res.ok || !res.body) throw await failure(res);
  if (!(await readAgentEvents(res.body, onEvent))) throw new TurnError(0, 'The connection to the server was interrupted. Send your message again.');
}

export interface MailAssistantOptions {
  /** The organization selected in the suite bar, whose Docs holds the chat. */
  org: string | null;
  /** What the user is looking at now, sent with every request of a turn. */
  context(): MailContext;
  /** Shows a message (open_mail_message); false when it is in an account the user does not have. */
  show(ref: MessageRef): boolean;
  /** A mail tool changed something (a draft was made): the lists refresh. */
  onMailChanged(): void;
}

export function useMailAssistant({ org, context, show, onMailChanged }: MailAssistantOptions) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The latest callbacks, for a turn that outlives the render it started in.
  const latest = useRef({ context, show, onMailChanged });
  latest.current = { context, show, onMailChanged };

  // The chat, loaded again when the organization changes.
  useEffect(() => {
    setItems([]);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(withOrg(`/api/agent?scope=${MAIL_CHAT}`, org), { credentials: 'same-origin' });
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
          if (e.ok && CHANGES_MAIL.has(names.get(e.id) ?? '')) latest.current.onMailChanged();
        } else if (e.type === 'client_tools') calls.value = e.calls;
        else if (e.type === 'error') setError(e.message);
      };

      void (async () => {
        // Whether the browser extension is there now (it may have been added or turned off since the page loaded).
        await checkBrowserExtension(true);
        let req: AgentTurnRequest = { message, context: withBrowser(latest.current.context()), scope: MAIL_CHAT };
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
            const pictures: AgentImage[] = [];
            const attach = (img: AgentImage) => pictures.length < MAX_IMAGES_PER_MESSAGE && pictures.push(img) > 0;
            const toolResults = await runMailClientCalls(pending, (ref) => latest.current.show(ref), attach);
            for (const r of toolResults) updateTool(r.id, { status: r.isError ? 'error' : 'ok', ...(r.isError ? { error: r.content } : {}) });
            if (abort.signal.aborted) break;
            // Screenshots follow the results in the same message (the API takes only text in tool results).
            req = { context: withBrowser(latest.current.context()), scope: MAIL_CHAT, toolResults, ...(pictures.length ? { images: pictures, message: webPicturesNote(pictures.length) } : {}) };
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
    [org],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(async () => {
    if (abortRef.current) return;
    try {
      const res = await fetch(withOrg('/api/agent/reset', org), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: MAIL_CHAT }) });
      if (!res.ok) throw await failure(res);
      setItems([]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [org]);

  return { items, running, error, send, stop, reset };
}
