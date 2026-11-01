import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { HOME_CHAT, JOB_ACTIVE_STATUSES, type AgentJob, type ChatItem } from '../../../shared/agent/protocol.ts';
import { MOD } from '../commands.ts';
import { FileChip, fileOfResult } from '../components/FileChip.tsx';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { ASSISTANT_PANEL } from '../panelSize.ts';
import { useAgent } from './AgentProvider.tsx';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { targetOf } from './clientTools.ts';
import { toolLabel } from './describe.ts';
import { imageFiles, prepareImage, type PreparedImage } from './images.ts';
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/agent/protocol.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const SHEET_SUGGESTIONS = ['Summarize what’s in this spreadsheet', 'Add a totals row under the data', 'Make the header row bold and freeze it', 'Turn this data into a short presentation'];
const DECK_SUGGESTIONS = ['Summarize this presentation', 'Add a closing slide with next steps', 'Tighten the bullets on every slide'];
const HOME_SUGGESTIONS = ['Which spreadsheets did I edit most recently?', 'Create a spreadsheet to track monthly expenses', 'Create a 5-slide presentation about our quarterly goals'];

export function AgentButton() {
  const { open, setOpen } = useAgent();
  return (
    <button className={`btn agent-toggle${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title={`Assistant (${MOD}K)`}>
      <SparkIcon />
      Assistant
    </button>
  );
}

export function AgentPanel() {
  const agent = useAgent();
  // The panel and the page beside it share the window; the panel takes at most half of it.
  const panel = usePanelWidth(ASSISTANT_PANEL, () => ({ available: window.innerWidth, viewport: window.innerWidth, maxFraction: 0.5 }));
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onSheet = !!agent.sheet;
  const onDeck = !!agent.deck;
  const here = onSheet ? 'this spreadsheet' : onDeck ? 'this presentation' : 'your spreadsheets and presentations';

  useEffect(() => inputRef.current?.focus(), []);

  // Keep the newest message in view while the reply streams in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.items, agent.confirm, agent.error, agent.running, agent.job]);

  // Grow the input with its text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const [attachments, setAttachments] = useState<PreparedImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const submit = (text: string) => {
    if ((!text.trim() && !attachments.length) || agent.running) return;
    agent.send(text, attachments.map(({ mediaType, data }) => ({ mediaType, data })));
    setDraft('');
    setAttachments([]);
  };

  /** Add pasted or dropped images to the next message. */
  const attach = async (files: File[]) => {
    if (!files.length) return;
    setAttachError(null);
    const room = MAX_IMAGES_PER_MESSAGE - attachments.length;
    if (room <= 0) return setAttachError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`);
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareImage));
      setAttachments((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES_PER_MESSAGE));
      if (files.length > room) setAttachError(`Only ${MAX_IMAGES_PER_MESSAGE} images fit in one message; the rest were left out.`);
    } catch {
      setAttachError('That image could not be read.');
    }
    inputRef.current?.focus();
  };

  const last = agent.items[agent.items.length - 1];
  const thinking = agent.running && !agent.confirm && last?.kind !== 'assistant';

  return (
    <aside className="agent-panel" aria-label="Assistant" style={{ width: panel.width }}>
      <ResizeHandle panel={panel} side="right" label="Resize assistant panel" className="agent-panel-resize" />
      <div className="agent-head">
        <SparkIcon />
        <span className="agent-title">Assistant</span>
        <Link className="link agent-changes" to="/changes" title="Changes the assistant made to the app">
          Changes
        </Link>
        <button className="link agent-new" onClick={() => void agent.reset()} disabled={agent.running || !agent.items.length} title="Start a new conversation">
          New chat
        </button>
        <button className="agent-close" onClick={() => agent.setOpen(false)} aria-label="Close assistant" title={`Close (${MOD}K)`}>
          ×
        </button>
      </div>
      {/* Each file has its own chat, and the home page one: which this is, and the way back to the open page's. */}
      <div className="agent-chat">
        <span className="agent-chat-name" title={agent.chatTitle ?? undefined}>
          {agent.chatScope === HOME_CHAT ? 'Home chat' : (agent.chatTitle ?? 'This file’s chat')}
        </span>
        {agent.chatScope !== agent.pageScope && !agent.running && (
          <button className="link" onClick={agent.showPageChat}>
            {agent.pageScope === HOME_CHAT ? 'Go to the home chat' : 'Go to this file’s chat'}
          </button>
        )}
      </div>

      <div className="agent-list" ref={listRef}>
        {agent.items.length === 0 && (
          <div className="agent-empty">
            <p>Ask me to read, edit or format {here}, or to find and open another one.</p>
            {(onSheet ? SHEET_SUGGESTIONS : onDeck ? DECK_SUGGESTIONS : HOME_SUGGESTIONS).map((s) => (
              <button key={s} className="agent-suggestion" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {agent.items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="agent-msg user">
              {it.images && it.images.length > 0 && (
                <div className="agent-msg-images">
                  {it.images.map((src, j) => (
                    <a key={j} href={src} target="_blank" rel="noreferrer" title="Open the image">
                      <img src={src} alt={`Attached image ${j + 1}`} />
                    </a>
                  ))}
                </div>
              )}
              {it.text}
            </div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="agent-msg assistant">
              <ChatMarkdown text={it.text.trim()} />
            </div>
          ) : (
            <ToolRow key={it.id} item={it} />
          ),
        )}
        {agent.job && (JOB_ACTIVE_STATUSES.has(agent.job.status) || !agent.job.acknowledged) && <JobCard job={agent.job} onDismiss={agent.dismissJob} />}
        {agent.confirm && (
          <div className="agent-confirm" role="alertdialog">
            <div>{agent.confirm.question}</div>
            <div className="agent-confirm-actions">
              <button className="btn" onClick={() => agent.confirm?.answer(false)}>
                Don’t allow
              </button>
              <button className="btn danger" onClick={() => agent.confirm?.answer(true)}>
                Allow
              </button>
            </div>
          </div>
        )}
        {thinking && (
          <div className="agent-working" aria-live="polite">
            <span />
            <span />
            <span />
          </div>
        )}
        {agent.error && <div className="agent-error">{agent.error}</div>}
      </div>

      <form
        className="agent-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        onDragOver={(e) => {
          if (imageFiles(e.dataTransfer).length || Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer);
          if (!files.length) return;
          e.preventDefault();
          void attach(files);
        }}
      >
        {attachments.length > 0 && (
          <div className="agent-attachments">
            {attachments.map((img, i) => (
              <div key={i} className="agent-attachment">
                <img src={img.dataUrl} alt={`Attached image ${i + 1}`} />
                <button type="button" aria-label="Remove image" title="Remove" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {attachError && <div className="agent-error">{attachError}</div>}
        <div className="agent-compose-row">
          <input
            id="agent-attach-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn agent-attach"
            title="Attach an image (or paste a screenshot)"
            aria-label="Attach an image"
            onClick={() => document.getElementById('agent-attach-input')?.click()}
            disabled={agent.running}
          >
            <PaperclipIcon />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={`Ask about ${here}, or paste a screenshot…`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData);
              if (!files.length) return;
              e.preventDefault();
              void attach(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(draft);
              }
              if (e.key === 'Escape') agent.setOpen(false);
            }}
          />
          {agent.running ? (
            <button type="button" className="btn agent-send" onClick={agent.stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary agent-send" disabled={!draft.trim() && !attachments.length}>
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

export function ToolRow({ item }: { item: ToolItem }) {
  const agent = useAgent();
  const sheet = agent.sheet;
  const deck = agent.deck;
  // The slide a deck tool worked on, so clicking the label goes there.
  const slideNo = deck && item.status === 'ok' && typeof item.input.slide === 'number' && item.input.slide <= deck.ctl.deck.slides.length ? item.input.slide : null;
  const target = sheet && item.status === 'ok' ? targetOf(item, sheet.ctl) : slideNo ? { slide: slideNo } : null;
  const label = toolLabel(item.name, item.input);
  const reveal = () => {
    if (!target) return;
    if ('slide' in target) {
      deck?.ctl.goTo(target.slide - 1);
      return;
    }
    if (!sheet) return;
    if (sheet.ctl.activeTabId !== target.tabId) sheet.ctl.switchTab(target.tabId);
    sheet.ctl.selectRange(target.range);
  };
  const file = item.status === 'ok' ? fileOfResult(item.result) : null;
  if (file) return <FileChip file={file} />;
  return (
    <div className={`agent-tool ${item.status}`} title={item.error}>
      <span className="agent-tool-icon" aria-hidden="true">
        {item.status === 'running' ? <span className="agent-spinner" /> : item.status === 'ok' ? '✓' : '!'}
      </span>
      {target ? (
        <button className="link agent-tool-label" onClick={reveal} title={'slide' in target ? 'Go to the slide' : 'Show in the spreadsheet'}>
          {label}
        </button>
      ) : (
        <span className="agent-tool-label">{label}</span>
      )}
      {item.status === 'error' && <span className="agent-tool-error">{failureLabel(item.error)}</span>}
    </div>
  );
}

const JOB_STATUS: Record<AgentJob['status'], string> = {
  queued: 'Waiting to start',
  starting: 'Starting the coding agent',
  coding: 'Changing the code',
  verifying: 'Running the checks',
  building: 'Building the app',
  restarting: 'Restarting the app',
  publishing: 'Live. Publishing to GitHub…',
  done: 'Live',
  failed: 'Failed',
};

function jobStatusLabel(job: AgentJob): string {
  if (job.kind === 'research') {
    if (job.status === 'coding') return 'Researching';
    if (job.status === 'done') return 'Finished';
  }
  return JOB_STATUS[job.status];
}

/** Progress of a change to the app's own code, or of a research task. */
function JobCard({ job, onDismiss }: { job: AgentJob; onDismiss(): void }) {
  const active = JOB_ACTIVE_STATUSES.has(job.status);
  const recent = job.log.slice(-3);
  return (
    <div className={`agent-job ${job.status}`} aria-live="polite">
      <div className="agent-job-head">
        <span className="agent-tool-icon" aria-hidden="true">
          {active || job.status === 'done' ? <span className="agent-spinner" /> : '!'}
        </span>
        <span className="agent-job-title">
          {job.kind === 'research' ? 'Researching' : 'Changing the app'}: {job.title}
        </span>
      </div>
      <div className="agent-job-status">
        {jobStatusLabel(job)}
        {job.status === 'done' && !job.acknowledged ? (job.kind === 'research' ? ' Handing the report to the assistant…' : ' Reloading…') : ''}
        {job.prUrl ? (
          <>
            {' · '}
            <a href={job.prUrl} target="_blank" rel="noreferrer">
              PR #{job.prNumber}
            </a>
          </>
        ) : null}
      </div>
      {active && job.status !== 'publishing' && recent.length > 0 && (
        <ul className="agent-job-log">
          {recent.map((line, i) => (
            <li key={`${job.log.length - recent.length + i}`}>{line}</li>
          ))}
        </ul>
      )}
      {job.status === 'failed' && (
        <>
          <pre className="agent-job-error">{job.error}</pre>
          {job.files && job.files.length > 0 && <div className="agent-job-files">Files left changed: {job.files.join(', ')}</div>}
          <div className="agent-confirm-actions">
            <button className="btn" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Short reason for a tool call that didn't succeed (the full message is in the tooltip). */
function failureLabel(error: string | undefined): string {
  if (error?.startsWith('The user declined')) return 'Declined';
  if (error === 'Stopped' || error?.includes('interrupted')) return 'Stopped';
  return 'Failed';
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5.3 5.3a4.5 4.5 0 0 0 6.4 6.4L13.5 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5l1.6 4.2 4.4 1.6-4.4 1.6L8 13.1 6.4 8.9 2 7.3l4.4-1.6z" fill="currentColor" />
      <path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z" fill="currentColor" opacity=".7" />
    </svg>
  );
}
