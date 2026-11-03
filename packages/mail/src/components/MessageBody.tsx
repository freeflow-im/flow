// A message's body. HTML goes through sanitize.ts and into a sandboxed iframe: no allow-scripts (nothing in it can
// run), allow-same-origin only so this page can measure its height, allow-popups so its links open in a new tab, and a
// Content Security Policy in the document itself. Remote images wait for "Show images". Plain text is rendered by
// React (so escaped), with its links made links.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { attachmentUrl, type MessageDetail } from '../api';
import { buildSrcdoc, linkify, sanitizeEmailHtml } from '../lib/sanitize';

export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-same-origin';

export function MessageBody({ accountId, message }: { accountId: string; message: MessageDetail }) {
  const [showImages, setShowImages] = useState(false);
  useEffect(() => setShowImages(false), [message.uid, message.folder]);

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
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-ink">
          <ImageOff className="size-4 shrink-0 text-muted" />
          <span className="flex-1">Images from the web are hidden to protect your privacy.</span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShowImages(true)}>
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
  const [height, setHeight] = useState(120);
  const srcDoc = useMemo(() => buildSrcdoc(html, allowRemote, window.location.origin), [html, allowRemote]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) + 2);
    };
    const onLoad = () => {
      measure();
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
      // Images arriving late change the height without resizing the body's box in every browser.
      frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return <iframe ref={ref} title={title} sandbox={IFRAME_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />;
}
