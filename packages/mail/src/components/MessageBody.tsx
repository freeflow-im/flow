// A message's body. HTML goes through sanitize.ts and into a sandboxed iframe: no allow-scripts (nothing in it can
// run), allow-same-origin only so this page can measure its height, allow-popups so its links open in a new tab, and a
// Content Security Policy in the document itself. Remote images wait for "Show images" until the user has chosen it once
// (lib/imagePref.ts); after that they load. Plain text is rendered by
// React (so escaped), with its links made links.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { attachmentUrl, type MessageDetail } from '../api';
import { setImagePref, useImagePref } from '../lib/imagePref';
import { buildSrcdoc, linkify, sanitizeEmailHtml } from '../lib/sanitize';

export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-same-origin';

export function MessageBody({ accountId, message }: { accountId: string; message: MessageDetail }) {
  const pref = useImagePref();
  const showImages = pref === 'always';

  const clean = useMemo(() => {
    if (!message.html) return null;
    const byCid = new Map(message.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.replace(/^<|>$/g, ''), a.index]));
    return sanitizeEmailHtml(message.html, {
      allowRemote: showImages,
      cidUrl: (cid) => {
        const index = byCid.get(cid);
        return index === undefined ? null : attachmentUrl(accountId, message.folder, message.uid, index, true);
      },
    });
  }, [message, accountId, showImages]);

  if (!clean) {
    return (
      <div className="whitespace-pre-wrap break-words px-1 pb-4 text-sm leading-relaxed text-ink">
        {linkify(message.text ?? '').map((s, i) =>
          s.kind === 'text' ? (
            s.text
          ) : (
            <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              {s.text}
            </a>
          ),
        )}
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
      <HtmlFrame html={clean.html} allowRemote={showImages} title={message.subject || 'Message'} />
    </>
  );
}

function HtmlFrame({ html, allowRemote, title }: { html: string; allowRemote: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => buildSrcdoc(html, allowRemote, window.location.origin), [html, allowRemote]);

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
    measure();
    observer.current?.disconnect();
    const doc = ref.current?.contentDocument;
    if (doc?.body) {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(doc.body);
    }
    // Images arriving late change the height without resizing the body's box in every browser.
    doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
  }, [measure]);
  const onLoad = useCallback(() => watch(), [watch]);

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
