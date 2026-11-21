// A one-time sign-in or verification code found in a message (the server's imap/accessCode.ts, on the organization's
// OpenAI key), shown above its body with a Copy button. The code is copied without its spaces and dashes ("482 913" is
// pasted as "482913"), the way a code field takes it.
import { Check } from 'lucide-react';
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

/** Copies a code (without its spaces and dashes); false when the browser refused both ways. */
export function copyCode(code: string): Promise<boolean> {
  const text = copiedCode(code);
  const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'));
  return write.then(() => true, () => copyBySelection(text));
}

export function AccessCodeCard({ code, onNotice }: { code: string; onNotice(notice: Notice): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    void copyCode(code).then((ok) => {
      if (!ok) { onNotice({ text: "Couldn't copy the code" }); return; }
      setCopied(true);
      onNotice({ text: 'Code copied' });
    });
  };
  return (
    <section aria-label="Code requested" className="mb-3 rounded-2xl bg-[#eef2f7] px-5 py-4">
      <div className="text-[15px] text-[#444746]">Code Requested</div>
      {/* One white box per character (a dash too); a space is a gap. The code is read out whole, not box by box. */}
      <div role="text" aria-label={code} className="mt-3 flex flex-wrap items-center gap-1.5">
        {[...code].map((ch, i) =>
          ch === ' ' ? (
            <span key={i} className="w-2" aria-hidden />
          ) : (
            <span key={i} aria-hidden className="flex h-11 w-9 items-center justify-center rounded-md bg-white font-mono text-[26px] leading-none text-[#1f1f1f]">
              {ch}
            </span>
          ),
        )}
      </div>
      <button type="button" onClick={copy} className="mt-4 inline-flex h-11 items-center gap-1.5 rounded-full bg-[#2a6197] px-7 text-[16px] font-medium text-white hover:bg-[#245485]">
        {copied && <Check className="size-4" aria-hidden />}
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </section>
  );
}
