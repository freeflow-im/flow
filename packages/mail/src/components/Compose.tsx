// Writing a message in a dialog on wide screens, the whole screen on narrow ones: New message, a saved draft opened to
// edit, and, on narrow screens, Reply, Reply all and Forward (wide screens answer in the conversation, InlineCompose.tsx).
// The composer itself is ComposeForm.tsx; this is its frame. Escape and the close button ask before dropping what was written.
import { useRef } from 'react';
import { X } from 'lucide-react';
import type { MailAccount } from '../api';
import type { ComposeRequest, Outgoing } from '../lib/compose';
import { cn } from '../lib/utils';
import { ComposeForm, type ComposerHandle } from './ComposeForm';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

export type { ComposeRequest } from '../lib/compose';

export function Compose({ account, request, narrow, onClose, onSend }: { account: MailAccount; request: ComposeRequest; narrow: boolean; onClose(): void; onSend(out: Outgoing): void }) {
  const form = useRef<ComposerHandle | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && form.current?.requestClose()}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn(
          'gap-0 overflow-hidden p-0',
          narrow ? 'left-0 top-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0' : 'h-[min(720px,calc(100dvh-48px))] max-w-3xl',
        )}
      >
        <ComposeForm
          account={account}
          request={request}
          variant="dialog"
          handle={form}
          onClose={onClose}
          onSend={onSend}
          header={(title, close) => (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-4">
              <DialogTitle className="flex-1 text-[16px] font-semibold">{title}</DialogTitle>
              <button type="button" onClick={close} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}
