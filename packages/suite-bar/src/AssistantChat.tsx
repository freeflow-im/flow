// The assistant's panel for Home and Admin (suiteChat.ts): the person's assistant by name and picture, the chat with
// Markdown replies and tool lines, a box to write in, Stop and New chat; inside the suite bar's dock (AssistantDock).
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AssistantDock, AssistantDockControls, ChatHistoryNav, orgChatHistory, SparkIcon, useAssistantDockState, useUsableAgents, type UsableAgent } from './AssistantDock';
import { HOME_CHAT, useSuiteAssistant } from './suiteChat';
import { useSuggestedPrompts, type PromptPage } from './lib/prompts';
import { EmailApprovalCard, WaitingEmails, emailApprovalOf } from './EmailApproval';
import './assistant-chat.css';

/**
 * The pill and, opened, the panel, in the organization the bar selected: any agent the person may talk to (agents.md §6),
 * picked in the panel's header. It starts with `prefer` when the person may use such an agent (Admin passes `admin`: the
 * admin agent, agents.md §1.4), else with their own assistant.
 */
export function SuiteAssistant({ organizationId, page, prefer }: {
  organizationId: string | null;
  /** Whose suggested prompts it offers (Admin → Prompts). */
  page: PromptPage;
  /** The agent to start with, by role, when there is one. */
  prefer?: 'admin';
}) {
  const [open, setOpen] = useState(false);
  const dock = useAssistantDockState('suite-assistant', open, setOpen);
  const agents = useUsableAgents(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  // A pick from another organization is dropped when the bar switches.
  useEffect(() => setPicked(null), [organizationId]);
  const chosen = (picked ? agents?.find((a) => a.id === picked) : undefined)
    ?? (prefer ? agents?.find((a) => a.role === prefer) : undefined)
    ?? agents?.find((a) => a.self) ?? null;
  return (
    <AssistantDock state={dock} label={chosen?.displayName} avatarUrl={chosen?.avatarUrl ?? null}>
      <SuiteAssistantPanel organizationId={organizationId} page={page} agents={agents ?? []} chosen={chosen} onPick={setPicked} />
    </AssistantDock>
  );
}

function SuiteAssistantPanel({ organizationId, page, agents, chosen, onPick }: { organizationId: string | null; page: PromptPage; agents: UsableAgent[]; chosen: UsableAgent | null; onPick: (id: string) => void }) {
  const name = chosen?.displayName ?? 'Assistant';
  const avatarUrl = chosen?.avatarUrl ?? null;
  // The person's own assistant goes by no id (the routes' default); any other agent by its own.
  const agentId = chosen && !chosen.self ? chosen.id : null;
  const chat = useSuiteAssistant(organizationId, agentId);
  const suggestions = useSuggestedPrompts(organizationId, page);
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  const submit = () => {
    if (!draft.trim() || chat.running) return;
    chat.send(draft);
    setDraft('');
  };
  return (
    <div className="suite-chat" data-testid="suite-assistant-panel">
      <div className="suite-chat-head">
        {avatarUrl ? <img className="suite-chat-avatar" src={avatarUrl} alt="" /> : <SparkIcon />}
        {agents.length > 1 ? (
          <select
            className="suite-chat-title suite-chat-picker"
            value={chosen?.id ?? ''}
            disabled={chat.running}
            onChange={(e) => onPick(e.target.value)}
            aria-label="Talk to"
            data-testid="suite-assistant-picker"
          >
            {agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
          </select>
        ) : (
          <span className="suite-chat-title">{name}</span>
        )}
        <ChatHistoryNav history={orgChatHistory(organizationId, HOME_CHAT, agentId)} busy={chat.running} refreshKey={`${organizationId}:${agentId}:${chat.items.length}:${chat.running}`} onReopened={chat.reload} />
        <button type="button" className="suite-chat-link" onClick={() => void chat.reset()} disabled={chat.running || !chat.items.length}>New chat</button>
        <AssistantDockControls />
      </div>
      <div className="suite-chat-list" ref={list}>
        <WaitingEmails organizationId={organizationId} refreshKey={chat.running} hide={chat.items.flatMap((i) => (i.kind === 'tool' ? [emailApprovalOf(i.name, i.result)].filter((x): x is string => !!x) : []))} />
        {!chat.items.length && <p className="suite-chat-empty">{emptyLine(chosen, name)}</p>}
        {!chat.items.length &&
          suggestions.map((s) => (
            <button key={s} type="button" className="suite-chat-suggestion" disabled={chat.running} onClick={() => chat.send(s)}>
              {s}
            </button>
          ))}
        {chat.items.map((item, i) =>
          item.kind === 'user' ? (
            <div key={i} className="suite-chat-user">{item.text}</div>
          ) : item.kind === 'assistant' ? (
            <div key={i} className="suite-chat-assistant"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown></div>
          ) : emailApprovalOf(item.name, item.result) ? (
            <EmailApprovalCard key={item.id} id={emailApprovalOf(item.name, item.result)!} organizationId={organizationId} />
          ) : (
            <div key={item.id} className={`suite-chat-tool ${item.status}`}>{item.name.replace(/_/g, ' ')}{item.status === 'running' ? '…' : item.error ? ` · ${item.error}` : ''}</div>
          ),
        )}
        {chat.running && chat.items[chat.items.length - 1]?.kind !== 'assistant' && <div className="suite-chat-thinking">Thinking…</div>}
        {chat.error && <div className="suite-chat-error">{chat.error}</div>}
      </div>
      <form className="suite-chat-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea
          value={draft}
          rows={2}
          placeholder={`Message ${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          data-testid="suite-assistant-input"
        />
        {chat.running ? (
          <button type="button" className="suite-chat-send" onClick={chat.stop}>Stop</button>
        ) : (
          <button type="submit" className="suite-chat-send" disabled={!draft.trim()} data-testid="suite-assistant-send">Send</button>
        )}
      </form>
    </div>
  );
}

/** An agent in the picker: its name, and who else may ask it (agents.md §6: a shared agent's audience is shown). */
function agentLabel(a: UsableAgent): string {
  if (a.self) return a.displayName;
  if (a.role === 'admin') return `${a.displayName} · admin agent`;
  return a.mode === 'shared' ? `${a.displayName} · shared` : `${a.displayName} · private`;
}

/** What the empty chat says the agent is for. */
function emptyLine(a: UsableAgent | null, name: string): string {
  if (a?.role === 'admin') return `Ask ${name} to manage the organization: members, invitations, domains, agents, automations and settings. ${name} acts as you, and asks before removing anything.`;
  if (a && a.mode === 'shared') return `${name} is shared: anyone in the organization can ask ${name}, and ${name} sees only what is shared with it.`;
  return `Ask ${name} anything: your mail, calendar, chats and files.`;
}
