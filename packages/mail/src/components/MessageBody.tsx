// A message's body. HTML goes through sanitize.ts and into a sandboxed iframe: no allow-scripts (nothing in it can
// run), allow-same-origin only so this page can measure its height, allow-popups so its links open in a new tab, and a
// Content Security Policy in the document itself. A click in the frame puts the keyboard focus in its document, so the
// frame relays its key presses to this window (relayKey) and the app's shortcuts keep working. Remote images wait for
// "Show images" until the user has chosen it once (lib/imagePref.ts); after that they load. Plain text is rendered by
// React (so escaped), with its links made links. The earlier messages quoted at the end (lib/quote.ts) are folded away
// behind "⋯" until clicked, as Gmail does, so a reply reads as what was written.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { attachmentUrl, type MessageDetail } from '../api';
import { setImagePref, useImagePref } from '../lib/imagePref';
import { markQuote, splitQuotedText } from '../lib/quote';
import { QUOTE_HIDDEN_CLASS, buildSrcdoc, linkify, sanitizeEmailHtml, type TextSegment } from '../lib/sanitize';
import { QuoteToggle } from './QuoteToggle';

export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-same-origin';

export function MessageBody({ accountId, message }: { accountId: string; message: MessageDetail }) {
  const pref = useImagePref();
  const showImages = pref === 'always';

  const [showQuote, setShowQuote] = useState(false);

  const clean = useMemo(() => {
    if (!message.html) return null;
    const byCid = new Map(message.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.replace(/^<|>$/g, ''), a.index]));
    const out = sanitizeEmailHtml(message.html, {
      allowRemote: showImages,
      cidUrl: (cid) => {
        const index = byCid.get(cid);
        return index === undefined ? null : attachmentUrl(accountId, message.folder, message.uid, index, true);
      },
    });
    return { ...out, ...markQuote(out.html) };
  }, [message, accountId, showImages]);

  if (!clean) {
    const text = message.text ?? '';
    const split = splitQuotedText(text);
    return (
      <div className="px-1 pb-4 text-sm leading-relaxed text-ink">
        <div className="whitespace-pre-wrap break-words">{renderText(split ? split.head : text)}</div>
        {split && <QuoteToggle open={showQuote} onClick={() => setShowQuote((v) => !v)} className="my-2" />}
        {split && showQuote && <div className="whitespace-pre-wrap break-words border-l-[3px] border-border pl-3 text-muted">{renderText(split.quote)}</div>}
      </div>
    );
  }
  return (
    <>
      {clean.hasRemote && !showImages && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px] text-ink">
          <ImageOff className="size-4 shrink-0 text-muted" />
          <span className="flex-1">Images from the web are hidden to protect your privacy. Show them, and they load in every message from now on.</span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setImagePref('always')}>
            Show images
          </button>
        </div>
      )}
      <HtmlFrame html={clean.html} allowRemote={showImages} quoteHidden={clean.quoted && !showQuote} title={message.subject || 'Message'} />
      {clean.quoted && <QuoteToggle open={showQuote} onClick={() => setShowQuote((v) => !v)} className="mb-3 ml-0.5" />}
    </>
  );
}

function renderText(text: string) {
  return linkify(text).map((s: TextSegment, i) =>
    s.kind === 'text' ? (
      s.text
    ) : (
      <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        {s.text}
      </a>
    ),
  );
}

/**
 * A key pressed in a message's frame, replayed on the app's window so the shortcuts (j/k, e, r, …) see it as they would a
 * key pressed anywhere else. Not while typing in a field the message contains. When the app acts on the replay (it
 * cancels it), the key is cancelled in the frame too, so it does not also scroll the message.
 */
export function relayKey(e: KeyboardEvent): void {
  if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
  const copy = new KeyboardEvent(e.type, { key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, bubbles: true, cancelable: true });
  if (!window.dispatchEvent(copy)) e.preventDefault();
}

function HtmlFrame({ html, allowRemote, quoteHidden, title }: { html: string; allowRemote: boolean; quoteHidden: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(120);
  // The quote's state is read when the document is built and applied to it live after (allow-same-origin lets this
  // page reach its body), so a toggle does not reload the frame.
  const quote = useRef(quoteHidden);
  quote.current = quoteHidden;
  const srcDoc = useMemo(() => buildSrcdoc(html, allowRemote, window.location.origin, quote.current), [html, allowRemote]);
  const applyQuote = useCallback(() => {
    ref.current?.contentDocument?.body?.classList.toggle(QUOTE_HIDDEN_CLASS, quote.current);
  }, []);

  // Sizes the frame to its document, and keeps it sized as the document's body and pictures change: on the iframe's
  // `load` (a prop, so it is there before the document can load), and before that every 250 ms while the document is
  // still loading (a message's remote pictures and tracking pixels can keep `load` from firing for a long time, and
  // some never let it), from the moment its body exists.
  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc?.documentElement) return;
    setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 2);
  }, []);
  const watch = useCallback(() => {
    applyQuote();
    measure();
    observer.current?.disconnect();
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(doc.body);
    }
    doc?.addEventListener('keydown', relayKey);
    // Images arriving late change the height without resizing the body's box in every browser.
    doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
  }, [measure, applyQuote]);
  const onLoad = useCallback(() => watch(), [watch]);
  useEffect(() => {
    applyQuote();
    measure();
  }, [quoteHidden, applyQuote, measure]);

  useEffect(() => {
    let watched = false;
    const tick = () => {
      const doc = ref.current?.contentDocument;
      if (!doc?.body?.childNodes.length) return;
      if (!watched) { watched = true; watch(); } else measure();
      if (doc.readyState === 'complete') clearInterval(timer);
    };
    const timer = setInterval(tick, 250);
    tick();
    return () => { clearInterval(timer); observer.current?.disconnect(); };
  }, [srcDoc, watch, measure]);

  return <iframe ref={ref} title={title} sandbox={IFRAME_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer" onLoad={onLoad} className="block w-full border-0" style={{ height }} />;
}
