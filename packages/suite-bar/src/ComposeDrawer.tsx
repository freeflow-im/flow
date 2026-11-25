// A new email beside an app: Mail's composer (/mail/compose, Mail's ComposePage.tsx) in a panel on the right, over the
// page. Calendar opens it from an address on an event, Docs from File > Send as email (with the file added). It closes
// when Mail says the composer is done (`flow:compose:done`: sent or discarded).
import { useEffect, useRef } from 'react';
import { createAddress, type CreateFields } from './lib/intents';
import './compose-drawer.css';

/** Mail's composer page, filled in: `createAddress('mail')`'s address, on the composer alone. */
export const composePageOf = (fields: CreateFields['mail']): string => createAddress('mail', fields).replace(/^\/mail\/\?/, '/mail/compose?');

export interface ComposeDrawerProps {
  /** What the composer starts with. Read when the drawer opens; a new email means a new drawer (a `key`). */
  email: CreateFields['mail'];
  /** The drawer's name, for a screen reader ("New email to Ann"). */
  label: string;
  onClose(sent: boolean): void;
}

export function ComposeDrawer({ email, label, onClose }: ComposeDrawerProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // The address is the first one: the frame does not reload when the host draws again.
  const src = useRef(composePageOf(email)).current;
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
    <aside aria-label={label} data-testid="compose-drawer" className="compose-drawer">
      <iframe ref={frame} title="New email" src={src} className="compose-drawer-frame" />
    </aside>
  );
}
