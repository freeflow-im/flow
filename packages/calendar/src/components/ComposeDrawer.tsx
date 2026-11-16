// A new email beside Calendar: Mail's composer (/mail/compose, Mail's ComposePage.tsx) in a drawer on the right, opened
// by the mail icon by an address on an event. It closes when Mail says the composer is done (`flow:compose:done`: sent
// or discarded). Calendar in Mail's side panel asks Mail instead (PanelApp.tsx), which opens its own composer.
import { useEffect, useRef } from 'react';
import { createAddress } from '@flow/suite-bar';

export interface MailTo { email: string; name?: string | null }

/** Mail's composer page for a new email to someone, about something. */
export const composePageOf = (to: MailTo, subject: string) =>
  createAddress('mail', { to: [{ email: to.email, name: to.name ?? null }], subject }).replace(/^\/mail\/\?/, '/mail/compose?');

export function ComposeDrawer({ to, subject, onClose }: { to: MailTo; subject: string; onClose(sent: boolean): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const data = e.data as { type?: unknown; sent?: unknown } | null;
      if (data?.type === 'flow:compose:done') close.current(data.sent === true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (
    <aside
      aria-label={`New email to ${to.name || to.email}`}
      data-testid="compose-drawer"
      className="fixed inset-y-0 right-0 z-50 flex w-[min(520px,100vw)] flex-col border-l border-hairline bg-white shadow-[-12px_0_48px_rgba(16,24,40,0.2)]"
    >
      <iframe ref={frame} title="New email" src={composePageOf(to, subject)} className="min-h-0 flex-1 border-0" />
    </aside>
  );
}
