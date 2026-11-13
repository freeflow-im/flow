// The assistant's chat for apps with no panel of their own (Home and Admin, docs/specs/agents.md §1.1): the person's
// assistant in Docs' home chat (the same conversation and memory as Docs' panel on its home page), over the assistant's
// API (GET /api/agent, POST /api/agent/turn streamed, POST /api/agent/reset). Server tools run as usual; a browser tool
// belongs to the app whose page it acts on, so it is answered "open that app". The platform's layer: no app's code.
import { useCallback, useEffect, useRef, useState } from 'react';

/** Docs' home chat (packages/docs/shared/agent/protocol.ts HOME_CHAT). */
export const HOME_CHAT = 'home';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'ok' | 'error'; error?: string };

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; ok: boolean }
  | { type: 'client_tools'; calls: { id: string; name: string }[] }
  | { type: 'permission'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** The events in a chunk of the stream (`data:` lines), and what is left over. */
export function parseEvents(buf: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let end;
  while ((end = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, end);
    buf = buf.slice(end + 2);
    for (const line of chunk.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as AgentEvent);
  }
  return { events, rest: buf };
}

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};
const withOrg = (path: string, org: string | null) => (org ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(org)}` : path);
const errorOf = async (res: Response) => ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`;

/** The chat: its transcript, a turn running, and send, stop and new chat. `org` is the organization the bar selected. */
export function useSuiteAssistant(org: string | null) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped to read the chat again, after ‹ › made an earlier conversation the active one (ChatHistoryNav).
  const [loads, setLoads] = useState(0);
  const reload = useCallback(() => setLoads((n) => n + 1), []);

  useEffect(() => {
    setItems([]);
    setError(null);
    let live = true;
    fetch(withOrg(`/api/agent?scope=${HOME_CHAT}`, org), { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: (ChatItem & { kind: string })[] }>) : null))
      .then((r) => {
        const kept = (r?.items ?? []).filter((i): i is ChatItem => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'tool');
        if (live) setItems((prev) => (prev.length ? [...kept, ...prev] : kept));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [org, loads]);

  const send = useCallback((text: string) => {
    const message = text.trim();
    if (!message || abortRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setItems((prev) => [...prev, { kind: 'user', text: message }]);
    setError(null);
    setRunning(true);
    const appendText = (t: string) => setItems((prev) => {
      const last = prev[prev.length - 1];
      return last?.kind === 'assistant' ? [...prev.slice(0, -1), { ...last, text: last.text + t }] : [...prev, { kind: 'assistant', text: t }];
    });
    const setTool = (id: string, status: 'ok' | 'error', err?: string) => setItems((prev) => prev.map((i) => (i.kind === 'tool' && i.id === id ? { ...i, status, ...(err ? { error: err } : {}) } : i)));
    void (async () => {
      let body: Record<string, unknown> = { message, context: { page: 'home' }, scope: HOME_CHAT, ...(org ? { workspace: org } : {}) };
      try {
        for (;;) {
          const res = await fetch(withOrg('/api/agent/turn', org), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Timezone': zone() }, body: JSON.stringify(body), signal: abort.signal });
          if (!res.ok || !res.body) throw new Error(res.status === 401 ? 'You are signed out. Reload the page to sign in again.' : await errorOf(res));
          let calls: { id: string; name: string }[] | null = null;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const { events, rest } = parseEvents(buf + value);
            buf = rest;
            for (const e of events) {
              if (e.type === 'text') appendText(e.text);
              else if (e.type === 'tool_start') setItems((prev) => [...prev, { kind: 'tool', id: e.id, name: e.name, status: 'running' }]);
              else if (e.type === 'tool_end') setTool(e.id, e.ok ? 'ok' : 'error');
              else if (e.type === 'client_tools') calls = e.calls;
              else if (e.type === 'error') setError(e.message);
            }
          }
          if (!calls || abort.signal.aborted) break;
          // A browser tool acts on an app's open page, which this one is not: the model is told so, and goes on.
          const pending: { id: string; name: string }[] = calls;
          setItems((prev) => [...prev, ...pending.map((c): ChatItem => ({ kind: 'tool', id: c.id, name: c.name, status: 'error', error: 'Works in its own app' }))]);
          body = { context: { page: 'home' }, scope: HOME_CHAT, ...(org ? { workspace: org } : {}), toolResults: pending.map((c) => ({ id: c.id, isError: true, content: `${c.name} works only on its app's open page (Docs, Mail or Calendar), not here. Tell the person to open that app and ask there, or use a server tool.` })) };
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (abortRef.current === abort) {
          abortRef.current = null;
          setRunning(false);
          setItems((prev) => prev.map((i) => (i.kind === 'tool' && i.status === 'running' ? { ...i, status: 'error', error: 'Stopped' } : i)));
        }
      }
    })();
  }, [org]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(async () => {
    if (abortRef.current) return;
    const res = await fetch(withOrg('/api/agent/reset', org), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: HOME_CHAT }) }).catch(() => null);
    if (res?.ok) { setItems([]); setError(null); } else setError(res ? await errorOf(res) : 'The server could not be reached.');
  }, [org]);

  return { items, running, error, send, stop, reset, reload };
}
