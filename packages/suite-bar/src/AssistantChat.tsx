// The assistant's panel for Home and Admin (suiteChat.ts): the person's assistant by name and picture, the chat with
// Markdown replies and tool lines, a box to write in, Stop and New chat; inside the suite bar's dock (AssistantDock).
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AssistantDock, AssistantDockControls, ChatHistoryNav, orgChatHistory, SparkIcon, useAssistantDockState, useMyAssistant } from './AssistantDock';
import { HOME_CHAT, useSuiteAssistant } from './suiteChat';
import { useSuggestedPrompts, type PromptPage } from './lib/prompts';
import './assistant-chat.css';

/** The pill and, opened, the panel: the person's assistant in the organization the bar selected. */
export function SuiteAssistant({ organizationId, page }: { organizationId: string | null; /** Whose suggested prompts it offers (Admin → Prompts). */ page: PromptPage }) {
  const [open, setOpen] = useState(false);
  const dock = useAssistantDockState('suite-assistant', open, setOpen);
  const mine = useMyAssistant(organizationId);
  return (
    <AssistantDock state={dock} label={mine?.displayName} avatarUrl={mine?.avatarUrl ?? null}>
      <SuiteAssistantPanel organizationId={organizationId} page={page} name={mine?.displayName ?? 'Assistant'} avatarUrl={mine?.avatarUrl ?? null} />
    </AssistantDock>
  );
}

function SuiteAssistantPanel({ organizationId, page, name, avatarUrl }: { organizationId: string | null; page: PromptPage; name: string; avatarUrl: string | null }) {
  const chat = useSuiteAssistant(organizationId);
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
        <span className="suite-chat-title">{name}</span>
        <ChatHistoryNav history={orgChatHistory(organizationId, HOME_CHAT)} busy={chat.running} refreshKey={`${organizationId}:${chat.items.length}:${chat.running}`} onReopened={chat.reload} />
        <button type="button" className="suite-chat-link" onClick={() => void chat.reset()} disabled={chat.running || !chat.items.length}>New chat</button>
        <AssistantDockControls />
      </div>
      <div className="suite-chat-list" ref={list}>
        {!chat.items.length && <p className="suite-chat-empty">Ask {name} anything: your mail, calendar, chats and files.</p>}
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
