// Writing a message in a window on wide screens, the whole screen on narrow ones: New message, a saved draft opened to
// edit, and, on narrow screens, Reply, Reply all and Forward (wide screens answer in the conversation, InlineCompose.tsx).
// The composer itself is ComposeForm.tsx; this is its frame. Escape and the close button ask before dropping what was written.
// On wide screens the window is not modal: it sits at the window's bottom left, and stops short of the side panel
// (its width is --side-panel-width, SidePanel.tsx), so a file can be dragged from Docs while writing (side-panel.md §7).
import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { MailAccount } from '../api';
import type { ComposeRequest, Outgoing } from '../lib/compose';
import { cn } from '../lib/utils';
import { ComposeForm, type ComposerHandle } from './ComposeForm';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

export type { ComposeRequest } from '../lib/compose';

export function Compose({ account, request, narrow, onClose, onSend }: { account: MailAccount; request: ComposeRequest; narrow: boolean; onClose(): void; onSend(out: Outgoing): void }) {
  const form = useRef<ComposerHandle | null>(null);
  const titleId = useId();
  const close = (
    onClick: () => void,
  ) => (
    <button type="button" onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label="Close">
      <X className="size-4" />
    </button>
  );
  const composer = (title: (text: string) => ReactNode) => (
    <ComposeForm
      account={account}
      request={request}
      variant="dialog"
      handle={form}
      onClose={onClose}
      onSend={onSend}
      header={(text, onClick) => (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-panel px-4">
          {title(text)}
          {close(onClick)}
        </div>
      )}
    />
  );
  if (!narrow)
    return (
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className="fixed bottom-4 left-4 z-50 flex flex-col overflow-hidden rounded-xl border border-hairline bg-white text-ink shadow-[0_12px_48px_rgba(16,24,40,0.3)]"
        style={{ width: 'min(720px, calc(100vw - var(--side-panel-width, 0px) - 32px))', minWidth: 'min(440px, calc(100vw - 32px))', height: 'min(720px, calc(100dvh - 88px))' }}
        onKeyDown={(e) => {
          // Not from the "Discard?" question (a portal, whose keys still reach here through React) or an open address
          // list (AddressField keeps its Escape).
          if (e.key !== 'Escape' || !e.currentTarget.contains(e.target as Node)) return;
          e.preventDefault();
          form.current?.requestClose();
        }}
      >
        {composer((text) => (
          <h2 id={titleId} className="flex-1 text-[16px] font-semibold">
            {text}
          </h2>
        ))}
      </section>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && form.current?.requestClose()}>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn('gap-0 overflow-hidden p-0', 'left-0 top-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0')}
      >
        {composer((text) => <DialogTitle className="flex-1 text-[16px] font-semibold">{text}</DialogTitle>)}
      </DialogContent>
    </Dialog>
  );
}
