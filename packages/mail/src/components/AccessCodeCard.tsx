// A one-time sign-in or verification code found in a message (the server's imap/accessCode.ts, on the organization's
// OpenAI key), shown above its body with a Copy button. The code is copied without its spaces and dashes ("482 913" is
// pasted as "482913"), the way a code field takes it.
import { Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Notice } from '../lib/notice';

/** What the clipboard gets: the code with its spaces and dashes taken out. */
export const copiedCode = (code: string) => code.replace(/[\s-]/g, '');

/** The older way to copy, where the Clipboard API is refused (an embedded view, a page without permission). */
function copyBySelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function AccessCodeCard({ code, onNotice }: { code: string; onNotice(notice: Notice): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const text = copiedCode(code);
    const done = () => { setCopied(true); onNotice({ text: 'Code copied' }); };
    const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'));
    write.then(done, () => (copyBySelection(text) ? done() : onNotice({ text: "Couldn't copy the code" })));
  };
  return (
    <section aria-label="Access code" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white px-4 py-3">
      <KeyRound className="size-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium uppercase tracking-[.06em] text-muted">Access code</div>
        <div className="select-all font-mono text-[22px] font-semibold leading-tight tracking-[.12em] text-ink">{code}</div>
      </div>
      <button type="button" onClick={copy} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[14px] font-medium text-white hover:opacity-90">
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </section>
  );
}
