// An attachment opened full-window over the app, as Gmail does: the name, size and type, Download, Save to Docs (then
// Open in Docs) and Close at the top, ← / → between the message's attachments (the buttons and the keys), Esc to close.
// What is shown depends on the file (lib/preview.ts): the browser shows pictures, video and audio; Docs shows PDFs and
// Office, CSV and Markdown files read-only, from a preview it makes of the bytes (/workspace/preview/<id>, framed here);
// text and HTML are shown as text, an HTML page also in a frame where nothing runs.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Code, Download, ExternalLink, FileText, Globe, Loader2, Save, X } from 'lucide-react';
import { attachmentUrl, previewApi, previewPageUrl, type AttachmentSummary, type DocsPreview, type SavedToDocs } from '../api';
import { fileSize } from '../lib/format';
import { inertHtml, isSvg, MAX_PREVIEW_BYTES, previewLimit, typeLabel, viewerFor } from '../lib/preview';
import { readActiveOrganization } from '../suite';
import { cn } from '../lib/utils';
import { FileIcon } from './FileIcon';

/** What Docs' preview page sends up when a key is pressed in its frame (packages/docs/client/src/pages/PreviewPage.tsx). */
const KEY_MESSAGE = 'freeflow-preview-key';

type Made = { preview: DocsPreview; workspace: string };

/** Docs' previews made in this page, by attachment: opening one again (or going back to it) does not ask again. */
const made = new Map<string, Promise<Made>>();
/** The message an attachment is in: the opened one, or a list row's (its chips open the preview without opening it). */
export type PreviewMessage = { folder: string; uid: number };
type Attachment = AttachmentSummary;

const keyOf = (accountId: string, m: PreviewMessage, a: Attachment) => `${accountId}\u0000${m.folder}\u0000${m.uid}\u0000${a.index}`;

function docsPreview(accountId: string, m: PreviewMessage, a: Attachment): Promise<Made> {
  const key = keyOf(accountId, m, a);
  let p = made.get(key);
  if (!p) {
    p = previewApi.create(accountId, m.folder, m.uid, a.index, readActiveOrganization());
    made.set(key, p);
    // A failure is not kept: the next try asks again. A preview lasts an hour on the server, so the page forgets it sooner.
    p.then(
      () => setTimeout(() => made.delete(key), 50 * 60 * 1000),
      () => made.delete(key),
    );
  }
  return p;
}

export interface AttachmentPreviewProps {
  accountId: string;
  message: PreviewMessage;
  /** The attachments that can be stepped through (not the pictures already shown in the body). */
  files: Attachment[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
}

export function AttachmentPreview({ accountId, message, files, index, onIndex, onClose }: AttachmentPreviewProps) {
  const a = files[index]!;
  const viewer = viewerFor(a);
  const download = attachmentUrl(accountId, message.folder, message.uid, a.index);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState<Record<string, 'saving' | SavedToDocs | { error: string }>>({});
  const saveState = saving[keyOf(accountId, message, a)];

  const prev = index > 0 ? () => onIndex(index - 1) : null;
  const next = index < files.length - 1 ? () => onIndex(index + 1) : null;
  const keys = useRef({ prev, next, onClose });
  keys.current = { prev, next, onClose };

  // Focus comes here, and goes back to what had it (the chip) on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    const act = (key: string) => {
      if (key === 'Escape') keys.current.onClose();
      else if (key === 'ArrowLeft') keys.current.prev?.();
      else if (key === 'ArrowRight') keys.current.next?.();
      else return false;
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // A playing video or audio, and the text of a field, keep their arrows.
      if (e.key !== 'Escape' && t && (/^(VIDEO|AUDIO|INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (act(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; key?: unknown } | null;
      if (e.origin !== window.location.origin || e.source !== frameRef.current?.contentWindow || d?.type !== KEY_MESSAGE || typeof d.key !== 'string') return;
      act(d.key);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const save = async () => {
    const key = keyOf(accountId, message, a);
    setSaving((s) => ({ ...s, [key]: 'saving' }));
    try {
      const { preview, workspace } = await docsPreview(accountId, message, a);
      const saved = preview.saved ?? (await previewApi.save(preview.id, workspace)).saved;
      setSaving((s) => ({ ...s, [key]: saved }));
    } catch (e) {
      setSaving((s) => ({ ...s, [key]: { error: (e as Error).message } }));
    }
  };
  const saved = saveState && typeof saveState === 'object' && 'url' in saveState ? saveState : null;
  const saveError = saveState && typeof saveState === 'object' && 'error' in saveState ? saveState.error : null;
  const tooLargeToSave = a.size > MAX_PREVIEW_BYTES;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Preview of ${a.filename || 'attachment'}`} className="fixed inset-0 z-50 flex flex-col bg-[#202124] text-white">
      <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:gap-2 sm:px-3">
        <BarButton ref={closeRef} label="Close (Esc)" onClick={onClose}>
          <X />
        </BarButton>
        <FileIcon file={a} className="ml-1 hidden size-5 sm:inline-flex" />
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium" title={a.filename}>
            {a.filename || 'attachment'}
          </div>
          <div className="truncate text-xs text-white/60">
            {fileSize(a.size)} · {typeLabel(a)}
            {files.length > 1 && (
              <span>
                {' '}
                · {index + 1} of {files.length}
              </span>
            )}
          </div>
        </div>
        <BarButton label="Download" href={download} download={a.filename || true}>
          <Download />
        </BarButton>
        {saved ? (
          <a
            href={saved.url}
            target="_blank"
            rel="noopener"
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[#8ab4f8] px-3 text-sm font-medium text-[#202124] hover:bg-[#aecbfa] sm:px-4"
            title={`Open “${saved.title}” in Docs`}
          >
            <ExternalLink className="size-4" />
            <span className="hidden sm:inline">Open in Docs</span>
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saveState === 'saving' || tooLargeToSave}
            title={tooLargeToSave ? 'Too large to save to Docs (25 MB maximum)' : 'Save a copy in My files in Docs'}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/30 px-3 text-sm font-medium hover:bg-white/10 disabled:opacity-50 sm:px-4"
          >
            {saveState === 'saving' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            <span className="hidden sm:inline">{saveState === 'saving' ? 'Saving…' : 'Save to Docs'}</span>
          </button>
        )}
      </header>
      {saveError && (
        <div role="alert" className="mx-auto mb-2 max-w-xl rounded-lg bg-[#5c2b29] px-3 py-2 text-[13px] text-white">
          {saveError}
        </div>
      )}
      <div className="relative min-h-0 flex-1" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="absolute inset-0 flex items-center justify-center px-2 pb-2 sm:px-16 sm:pb-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <Shown key={keyOf(accountId, message, a)} accountId={accountId} message={message} a={a} viewer={viewer} download={download} frameRef={frameRef} />
        </div>
        {prev && <NavButton side="left" label="Previous attachment (←)" onClick={prev} />}
        {next && <NavButton side="right" label="Next attachment (→)" onClick={next} />}
      </div>
    </div>,
    document.body,
  );
}

function Shown({ accountId, message, a, viewer, download, frameRef }: { accountId: string; message: PreviewMessage; a: Attachment; viewer: ReturnType<typeof viewerFor>; download: string; frameRef: React.RefObject<HTMLIFrameElement | null> }) {
  const limit = previewLimit(viewer, a.size);
  if (limit) return <NoPreview a={a} download={download} why={limit} />;
  switch (viewer) {
    case 'image':
      return <Picture a={a} url={attachmentUrl(accountId, message.folder, message.uid, a.index, true)} />;
    case 'video':
      return <video className="max-h-full max-w-full rounded bg-black" src={download} controls autoPlay playsInline aria-label={a.filename} />;
    case 'audio':
      return (
        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl bg-white/10 p-6">
          <div className="truncate text-sm">{a.filename}</div>
          <audio className="w-full" src={download} controls autoPlay aria-label={a.filename} />
        </div>
      );
    case 'docs':
      return <DocsFrame accountId={accountId} message={message} a={a} download={download} frameRef={frameRef} />;
    case 'text':
    case 'html':
      return <TextView a={a} url={download} html={viewer === 'html'} />;
    default:
      return <NoPreview a={a} download={download} why="No preview available" />;
  }
}

/** A picture: an SVG from a blob of its own type (as an <img>, which runs nothing in it), others from the server inline. */
function Picture({ a, url }: { a: Attachment; url: string }) {
  const svg = isSvg(a);
  const [src, setSrc] = useState<string | null>(svg ? null : url);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!svg) return;
    let objectUrl: string | null = null;
    let gone = false;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((bytes) => {
        if (gone) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        setSrc(objectUrl);
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [svg, url]);
  if (failed) return <Message>This picture could not be shown.</Message>;
  if (!src) return <Spinner />;
  return <img src={src} alt={a.filename} className="max-h-full max-w-full bg-[repeating-conic-gradient(#3c4043_0_25%,#2d2e30_0_50%)] bg-[length:16px_16px] object-contain shadow-2xl" onError={() => setFailed(true)} />;
}

/** Docs' read-only view of the file, from the preview Docs makes of it. */
function DocsFrame({ accountId, message, a, download, frameRef }: { accountId: string; message: PreviewMessage; a: Attachment; download: string; frameRef: React.RefObject<HTMLIFrameElement | null> }) {
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let gone = false;
    docsPreview(accountId, message, a).then(
      ({ preview, workspace }) => !gone && setState(preview.kind === 'file' ? { error: 'No preview available' } : { url: previewPageUrl(preview.id, workspace) }),
      (e: Error) => !gone && setState({ error: e.message }),
    );
    return () => {
      gone = true;
    };
  }, [accountId, message, a]);
  if (state && 'error' in state) return <NoPreview a={a} download={download} why={state.error} />;
  return (
    <div className="relative h-full w-full max-w-[1200px] overflow-hidden rounded-lg bg-white shadow-2xl">
      {state && (
        <iframe
          ref={frameRef}
          src={state.url}
          title={`Preview of ${a.filename}`}
          className={cn('h-full w-full border-0', !loaded && 'invisible')}
          onLoad={() => setLoaded(true)}
        />
      )}
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-[#5f6368]">
          <Loader2 className="size-6 animate-spin text-[#1a73e8]" />
          {state ? 'Opening…' : 'Preparing the preview…'}
        </div>
      )}
    </div>
  );
}

/** A text file, or an HTML file's source (or, on request, the page in a frame where nothing runs and nothing loads). */
function TextView({ a, url, html }: { a: Attachment; url: string; html: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asPage, setAsPage] = useState(false);
  useEffect(() => {
    let gone = false;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`The file could not be read (${r.status}).`))))
      .then((bytes) => {
        if (gone) return;
        const t = new TextDecoder('utf-8').decode(bytes);
        if (t.includes('\u0000')) setError('This file is not text.');
        else setText(t.replace(/^﻿/, ''));
      })
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, [url]);
  if (error) return <NoPreview a={a} download={url} why={error} />;
  if (text === null) return <Spinner />;
  return (
    <div className="flex h-full w-full max-w-[1000px] flex-col overflow-hidden rounded-lg bg-white text-ink shadow-2xl">
      {html && (
        <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1.5 text-[13px]">
          <ToggleButton on={!asPage} onClick={() => setAsPage(false)}>
            <Code className="size-4" /> Source
          </ToggleButton>
          <ToggleButton on={asPage} onClick={() => setAsPage(true)}>
            <Globe className="size-4" /> Page
          </ToggleButton>
          {asPage && <span className="ml-2 truncate text-xs text-muted">Shown without scripts or anything from the web.</span>}
        </div>
      )}
      {html && asPage ? (
        <iframe sandbox="" srcDoc={inertHtml(text)} title={a.filename} className="min-h-0 flex-1 border-0 bg-white" />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">{text}</pre>
      )}
    </div>
  );
}

function ToggleButton({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium', on ? 'bg-primary-tint text-primary-deep' : 'text-muted hover:bg-hover')}>
      {children}
    </button>
  );
}

function NoPreview({ a, download, why }: { a: Attachment; download: string; why: string }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl bg-[#3c4043] px-8 py-8 text-center shadow-2xl">
      <FileText className="size-12 text-[#8ab4f8]" strokeWidth={1.25} />
      <div className="max-w-full truncate text-sm font-medium">{a.filename || 'attachment'}</div>
      <div className="text-sm text-white/70">{why}</div>
      <a href={download} download={a.filename || true} className="mt-1 inline-flex h-9 items-center gap-2 rounded-full bg-[#8ab4f8] px-5 text-sm font-medium text-[#202124] hover:bg-[#aecbfa]">
        <Download className="size-4" /> Download
      </a>
    </div>
  );
}

const Message = ({ children }: { children: ReactNode }) => <div className="text-sm text-white/70">{children}</div>;
const Spinner = () => <Loader2 className="size-8 animate-spin text-white/70" aria-label="Loading" />;

function BarButton({ label, onClick, href, download, children, ref }: { label: string; onClick?(): void; href?: string; download?: string | boolean; children: ReactNode; ref?: React.Ref<HTMLButtonElement> }) {
  const cls = 'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[#8ab4f8] [&_svg]:size-5';
  if (href)
    return (
      <a href={href} download={download === true ? '' : download} title={label} aria-label={label} className={cls}>
        {children}
      </a>
    );
  return (
    <button ref={ref} type="button" title={label} aria-label={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

function NavButton({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'absolute top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-[#3c4043]/90 text-white shadow-lg hover:bg-[#5f6368] sm:size-12 [&_svg]:size-6',
        side === 'left' ? 'left-1 sm:left-3' : 'right-1 sm:right-3',
      )}
    >
      {side === 'left' ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}
