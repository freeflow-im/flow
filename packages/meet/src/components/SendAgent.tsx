// "Send an agent" in the room's People panel (Meet phase 5, docs/specs/meetings.md §1.6): the person picks one of their
// own agents or one of the organization's shared ones. It joins the room, turns recording on, and after the meeting
// writes Notes into the meeting's Docs folder. It cannot hear the meeting; it answers @mentions in the meeting's chat.
import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { MeetingDTO } from '@flow/shared';
import { api, type SendableAgent } from '../api';

export function SendAgent({ meeting, present, onError }: { meeting: MeetingDTO; present: Set<string>; onError: (message: string) => void }) {
  const [agents, setAgents] = useState<SendableAgent[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.sendableAgents(meeting.workspaceId).then((a) => live && setAgents(a), () => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [meeting.workspaceId]);
  const choices = (agents ?? []).filter((a) => !present.has(a.id));
  if (!agents || (!choices.length && !sending)) return null;
  const send = (a: SendableAgent) => {
    setSending(a.id);
    api
      .sendAgent(meeting.code, a.id)
      .catch((e: unknown) => onError(`Could not send ${a.displayName}: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSending(null));
  };
  return (
    <section className="border-t border-hairline px-4 py-3" aria-label="Send an agent">
      <h2 className="m-0 mb-1 text-sm font-semibold">Send an agent</h2>
      <p className="m-0 mb-2.5 text-xs text-muted">It records the meeting and writes notes in Docs when it ends. It cannot hear the call, but you can @mention it in the chat.</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {choices.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              disabled={!!sending}
              onClick={() => send(a)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-hairline bg-transparent px-2.5 py-1.5 text-left text-sm hover:bg-black/5 disabled:cursor-default disabled:opacity-60"
            >
              <Bot size={16} className="flex-none text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{a.displayName}{a.self ? ' (your assistant)' : ''}</span>
              <span className="text-xs text-primary">{sending === a.id ? 'Joining…' : 'Send'}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
