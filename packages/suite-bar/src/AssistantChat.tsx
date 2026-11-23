// The assistant's panel for Home and Admin (suiteChat.ts): the person's assistant by name and picture, the chat with
// Markdown replies and tool lines, a box to write in, Stop and New chat; inside the suite bar's dock (AssistantDock).
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AssistantDock, AssistantDockControls, ChatHistoryNav, orgChatHistory, SparkIcon, useAssistantDockState, useAssistantModel, useModelTooltip, useUsableAgents, type UsableAgent } from './AssistantDock';
import { adminAddress } from '@flow/shared/addresses';
import { HOME_CHAT, useSuiteAssistant } from './suiteChat';
import { useSuggestedPrompts, type PromptPage } from './lib/prompts';
import { CHAT_IMAGE_TYPES, imageFiles, MAX_CHAT_IMAGES, prepareChatImage, type ChatImage } from './lib/chatImages';
import { EmailApprovalCard, WaitingEmails, emailApprovalOf } from './EmailApproval';
import './assistant-chat.css';

// The chat itself, for a page that shows the assistant's answer in its own place (Home's setup, docs/specs/onboarding.md §4).
export { useSuiteAssistant, type ChatItem } from './suiteChat';

/**
 * The pill and, opened, the panel, in the organization the bar selected: any agent the person may talk to (agents.md §6),
 * picked in the panel's header. It starts with `prefer` when the person may use such an agent (Admin passes `admin`: the
 * admin agent, agents.md §1.4), else with their own assistant.
 */
export function SuiteAssistant({ organizationId, page, prefer, context, app }: {
  organizationId: string | null;
  /**
   * The installed app whose screen the page shows (user-apps.md §6): the picker offers only the agents that may use it,
   * and each turn says it is open.
   */
  app?: { name: string; label: string };
  /** What the page shows, sent with each turn (the Build app page's draft and file, user-apps.md §9.6). */
  context?: Record<string, unknown>;
  /** Whose suggested prompts it offers (Admin → Prompts). */
  page: PromptPage;
  /** The agent to start with, by role, when there is one. */
  prefer?: 'admin';
}) {
  const [open, setOpen] = useState(false);
  const dock = useAssistantDockState('suite-assistant', open, setOpen);
  const agents = useUsableAgents(organizationId, app?.name);
  const [picked, setPicked] = useState<string | null>(null);
  // A pick from another organization is dropped when the bar switches.
  useEffect(() => setPicked(null), [organizationId]);
  const turnContext = app ? { ...context, installedApp: { app: app.name, label: app.label } } : context;
  const chosen = (picked ? agents?.find((a) => a.id === picked) : undefined)
    ?? (prefer ? agents?.find((a) => a.role === prefer) : undefined)
    ?? agents?.find((a) => a.self) ?? null;
  return (
    <AssistantDock state={dock} label={chosen?.displayName} avatarUrl={chosen?.avatarUrl ?? null}>
      {app && agents && !agents.length ? (
        <NoAgentForApp label={app.label} />
      ) : (
        <SuiteAssistantPanel
          organizationId={organizationId}
          page={page}
          agents={agents ?? []}
          chosen={chosen}
          onPick={setPicked}
          context={turnContext}
          {...(app && chosen ? { intro: `Ask ${chosen.displayName} to work in ${app.label}. It reads and changes it through the app's tools, and can still use your mail, calendar, chats and files.`, prompts: [`What can you do in ${app.label}?`] } : {})}
        />
      )}
    </AssistantDock>
  );
}

/**
 * The same panel as a column of a page's own layout, always open and with no dock: the Build app page's (user-apps.md
 * §9.6), where the assistant is the main way to build. The page sizes it; there is no float, anchor or minimize.
 */
export function SuiteAssistantColumn({ organizationId, page, context, intro, prompts }: {
  organizationId: string | null;
  page: PromptPage;
  context?: Record<string, unknown>;
  /** What the empty chat says, and the prompts it offers, in place of the organization's (the page's own work). */
  intro?: string;
  prompts?: string[];
}) {
  const agents = useUsableAgents(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [organizationId]);
  const chosen = (picked ? agents?.find((a) => a.id === picked) : undefined) ?? agents?.find((a) => a.self) ?? null;
  return <SuiteAssistantPanel organizationId={organizationId} page={page} agents={agents ?? []} chosen={chosen} onPick={setPicked} context={context} bare {...(intro ? { intro } : {})} {...(prompts ? { prompts } : {})} />;
}

function SuiteAssistantPanel({ organizationId, page, agents, chosen, onPick, context, bare = false, intro, prompts }: { organizationId: string | null; page: PromptPage; agents: UsableAgent[]; chosen: UsableAgent | null; onPick: (id: string) => void; context?: Record<string, unknown>; bare?: boolean; intro?: string; prompts?: string[] }) {
  const name = chosen?.displayName ?? 'Assistant';
  // The person's own assistant goes by no id (the routes' default); any other agent by its own.
  const agentId = chosen && !chosen.self ? chosen.id : null;
  // What the chosen agent runs on (its pin, else the organization's default): on hovering (or focusing) the name.
  const modelTip = useModelTooltip(useAssistantModel(organizationId, agentId));
  const avatarUrl = chosen?.avatarUrl ?? null;
  const chat = useSuiteAssistant(organizationId, agentId, context);
  const orgPrompts = useSuggestedPrompts(organizationId, page);
  const suggestions = prompts ?? orgPrompts;
  const [draft, setDraft] = useState('');
  // Images for the next message: pasted (⌘V), dropped or picked, shown as thumbnails until sent.
  const [attachments, setAttachments] = useState<ChatImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  const submit = () => {
    if ((!draft.trim() && !attachments.length) || chat.running) return;
    chat.send(draft, attachments.map(({ mediaType, data }) => ({ mediaType, data })));
    setDraft('');
    setAttachments([]);
    setAttachError(null);
  };
  /** Adds images to the next message, at most MAX_CHAT_IMAGES; the rest are left out, and the panel says so. */
  const attach = async (files: File[]) => {
    if (!files.length) return;
    setAttachError(null);
    const room = MAX_CHAT_IMAGES - attachments.length;
    if (room <= 0) return setAttachError(`At most ${MAX_CHAT_IMAGES} images per message.`);
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareChatImage));
      setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_CHAT_IMAGES));
      if (files.length > room) setAttachError(`Only ${MAX_CHAT_IMAGES} images fit in one message; the rest were left out.`);
    } catch {
      setAttachError('That image could not be read.');
    }
    input.current?.focus();
  };
  return (
    <div
      className={`suite-chat${dragging ? ' dragging' : ''}`}
      data-testid="suite-assistant-panel"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setDragging(true); }
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        setDragging(false);
        const files = imageFiles(e.dataTransfer);
        if (!files.length) return;
        e.preventDefault();
        void attach(files);
      }}
    >
      <div className="suite-chat-head">
        {avatarUrl ? <img className="suite-chat-avatar" src={avatarUrl} alt="" /> : <SparkIcon />}
        {agents.length > 1 ? (
          <select
            className="suite-chat-title suite-chat-picker"
            {...modelTip.trigger}
            value={chosen?.id ?? ''}
            disabled={chat.running}
            onChange={(e) => onPick(e.target.value)}
            aria-label="Talk to"
            data-testid="suite-assistant-picker"
          >
            {agents.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
          </select>
        ) : (
          <span className="suite-chat-title" tabIndex={0} data-testid="suite-assistant-name" {...modelTip.trigger}>{name}</span>
        )}
        {modelTip.tooltip}
        <ChatHistoryNav history={orgChatHistory(organizationId, HOME_CHAT, agentId)} busy={chat.running} refreshKey={`${organizationId}:${agentId}:${chat.items.length}:${chat.running}`} onReopened={chat.reload} />
        <button type="button" className="suite-chat-link" onClick={() => void chat.reset()} disabled={chat.running || !chat.items.length}>New chat</button>
        {!bare && <AssistantDockControls />}
      </div>
      <div className="suite-chat-list" ref={list}>
        <WaitingEmails organizationId={organizationId} refreshKey={chat.running} hide={chat.items.flatMap((i) => (i.kind === 'tool' ? [emailApprovalOf(i.name, i.result)].filter((x): x is string => !!x) : []))} />
        {!chat.items.length && <p className="suite-chat-empty">{intro ?? emptyLine(chosen, name)}</p>}
        {!chat.items.length &&
          suggestions.map((s) => (
            <button key={s} type="button" className="suite-chat-suggestion" disabled={chat.running} onClick={() => chat.send(s)}>
              {s}
            </button>
          ))}
        {chat.items.map((item, i) =>
          item.kind === 'user' ? (
            <div key={i} className="suite-chat-user">
              {item.images?.length ? (
                <div className="suite-chat-user-images">
                  {item.images.map((src, j) => <a key={j} href={src} target="_blank" rel="noreferrer" title="Open the image"><img src={src} alt={`Attached image ${j + 1}`} /></a>)}
                </div>
              ) : null}
              {item.text}
            </div>
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
      {(attachments.length > 0 || attachError) && (
        <div className="suite-chat-attachments" data-testid="suite-assistant-attachments">
          {attachments.map((img, i) => (
            <span key={i} className="suite-chat-thumb">
              <img src={img.dataUrl} alt={`Attached image ${i + 1}`} />
              <button type="button" aria-label="Remove image" title="Remove" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          {attachError && <span className="suite-chat-attach-error">{attachError}</span>}
        </div>
      )}
      <form className="suite-chat-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          ref={picker}
          type="file"
          accept={[...CHAT_IMAGE_TYPES].join(',')}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void attach(files);
          }}
          data-testid="suite-assistant-file"
        />
        <button type="button" className="suite-chat-attach" onClick={() => picker.current?.click()} disabled={chat.running || attachments.length >= MAX_CHAT_IMAGES} title="Attach an image (or paste a screenshot)" aria-label="Attach an image">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
        </button>
        <textarea
          ref={input}
          value={draft}
          rows={2}
          placeholder={`Message ${name}, or paste a screenshot`}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void attach(files);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          data-testid="suite-assistant-input"
        />
        {chat.running ? (
          <button type="button" className="suite-chat-send" onClick={chat.stop}>Stop</button>
        ) : (
          <button type="submit" className="suite-chat-send" disabled={!draft.trim() && !attachments.length} data-testid="suite-assistant-send">Send</button>
        )}
      </form>
    </div>
  );
}

/**
 * The panel over an installed app when none of the person's agents may use it: where to turn it on. A personal agent may
 * once the person turns the app on for their agents (Organization settings → Apps); a shared agent once an admin grants it.
 */
function NoAgentForApp({ label }: { label: string }) {
  return (
    <div className="suite-chat" data-testid="suite-assistant-panel">
      <div className="suite-chat-head">
        <SparkIcon />
        <span className="suite-chat-title">Assistant</span>
        <AssistantDockControls />
      </div>
      <div className="suite-chat-list">
        <p className="suite-chat-empty" data-testid="suite-assistant-no-agent">
          None of your agents can use {label} yet. Turn on “My agents may use it” for {label} in{' '}
          <a href={adminAddress('apps')}>Organization settings → Apps</a>, or ask an admin to give it to a shared agent.
        </p>
      </div>
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
