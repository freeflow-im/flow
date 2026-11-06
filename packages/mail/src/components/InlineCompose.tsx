// Reply, Reply all and Forward in the conversation, under the message answered, as Gmail does on wide screens: the
// person's avatar, then a card with the mode (a menu switches between the three), the recipients as one line until clicked,
// the body with the quote, the files, and Send / attach / discard (ComposeForm.tsx). It scrolls into view as it opens. When
// it goes away with something written and was neither sent nor discarded (another conversation opened, the window made
// narrow), `onDetach` gets it as it was, and App.tsx opens it in the dialog: nothing written is lost.
import { useEffect, useLayoutEffect, useRef, type Ref } from 'react';
import type { MailAccount } from '../api';
import type { ComposeRequest, Outgoing } from '../lib/compose';
import { ComposeForm, type ComposerHandle } from './ComposeForm';

export interface InlineComposeProps {
  account: MailAccount;
  request: ComposeRequest;
  handle?: Ref<ComposerHandle | null> | undefined;
  onClose(): void;
  onSend(out: Outgoing): void;
  onDetach?: ((request: ComposeRequest) => void) | undefined;
}

export default function InlineCompose({ account, request, handle, onClose, onSend, onDetach }: InlineComposeProps) {
  const card = useRef<HTMLDivElement>(null);
  const form = useRef<ComposerHandle | null>(null);
  const done = useRef(false);
  const detach = useRef(onDetach);
  detach.current = onDetach;
  useEffect(() => {
    // After the editor has drawn the quote, so the whole card (Send included) comes into view.
    const frame = requestAnimationFrame(() => card.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Gone without Send or Discard: hand over what was written (a layout effect, so the form is still there to ask). StrictMode's
  // trial unmount is followed at once by a mount, so the hand-over waits a tick and stands down if the card is back.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const f = form;
    let alive = true;
    mounted.current = true;
    return () => {
      alive = false;
      mounted.current = false;
      let snap: ComposeRequest | null = null;
      try {
        // The editor may be half torn down already (StrictMode's trial run): then there is nothing to keep.
        if (!done.current && f.current && !f.current.isEmpty()) snap = f.current.snapshot();
      } catch {
        snap = null;
      }
      queueMicrotask(() => {
        if (!alive && !mounted.current && snap) detach.current?.(snap);
      });
    };
  }, []);
  const initial = (account.displayName || account.email).slice(0, 1).toUpperCase();
  return (
    <div ref={card} className="-mx-2 mb-6 flex gap-3 px-3 py-2.5" data-inline-compose>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-tint text-sm font-semibold text-primary-deep" aria-hidden>
        {initial}
      </span>
      <section aria-label={request.mode === 'forward' ? 'Forward' : 'Reply'} className="min-w-0 flex-1 rounded-lg border border-hairline bg-white shadow-[0_1px_3px_rgba(60,64,67,.15)]">
        <ComposeForm
          account={account}
          request={request}
          variant="inline"
          handle={(h: ComposerHandle | null) => {
            form.current = h;
            if (typeof handle === 'function') handle(h);
            else if (handle) (handle as { current: ComposerHandle | null }).current = h;
          }}
          onClose={() => {
            done.current = true;
            onClose();
          }}
          onSend={(out) => {
            done.current = true;
            onSend(out);
          }}
        />
      </section>
    </div>
  );
}
