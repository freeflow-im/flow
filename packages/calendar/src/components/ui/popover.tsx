// A popover on Radix, anchored to an element or to a point (FullCalendar hands us the clicked event's element, or the
// pointer for a selection), or centred on the page when there is neither (an event opened from a link or a search).
import type { ReactNode } from 'react';
import { Popover as P } from 'radix-ui';
import { cn } from '../../lib/utils';

export type Anchor = { el: Element } | { x: number; y: number } | null;

/** Whether an event's target is in the assistant's dock (AssistantDock, `data-testid="assistant-dock"`). */
const insideAssistant = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[data-testid="assistant-dock"]');

export function AnchoredPopover({ anchor, onClose, className, children, label, autoFocus = false }: { anchor: Anchor; onClose(): void; className?: string; children: ReactNode; label: string; autoFocus?: boolean }) {
  const virtual = { current: { getBoundingClientRect: () => (anchor && 'el' in anchor ? anchor.el.getBoundingClientRect() : anchor ? new DOMRect(anchor.x, anchor.y, 0, 0) : new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0)) } };
  return (
    <P.Root open onOpenChange={(o) => !o && onClose()}>
      <P.Anchor virtualRef={virtual} />
      <P.Portal>
        <P.Content
          aria-label={label}
          side={anchor ? 'right' : 'bottom'}
          align={anchor ? 'start' : 'center'}
          sideOffset={8}
          collisionPadding={12}
          className={cn('z-50 w-[min(400px,calc(100vw-24px))] rounded-xl border border-hairline bg-white p-4 text-ink shadow-xl outline-none', className)}
          // With `autoFocus` the first control takes the focus (Radix's default); without it the page keeps it.
          onOpenAutoFocus={(e) => { if (!autoFocus) e.preventDefault(); }}
          // Opening or using the assistant (its pill and panel, the suite bar's dock) leaves the event open: the person
          // is likely asking about it. Any other click or focus outside closes it, as before.
          onInteractOutside={(e) => { if (insideAssistant(e.target)) e.preventDefault(); }}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
