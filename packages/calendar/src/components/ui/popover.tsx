// A popover on Radix, anchored to an element or to a point (FullCalendar hands us the clicked event's element, or the
// pointer for a selection), or centred on the page when there is neither (an event opened from a link or a search).
import type { ReactNode } from 'react';
import { Popover as P } from 'radix-ui';
import { cn } from '../../lib/utils';

export type Anchor = { el: Element } | { x: number; y: number } | null;

/** Whether an event's target is in the assistant's dock (AssistantDock, `data-testid="assistant-dock"`). */
const insideAssistant = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[data-testid="assistant-dock"]');

/** The widest popover here (EventPopover's 440px), its gap and the page margin: the room a side needs. */
const ROOM = 440 + 8 + 12;

/**
 * The side it opens on: beside the anchor, right or else left, where the popover fits; below it when neither has room (an
 * all-day event across the week, a narrow window or panel). Radix only flips to the opposite side, and leaves a popover
 * that fits on neither cut off at the window's edge.
 */
export function sideFor(rect: { left: number; right: number }, width: number, wanted: 'right' | 'bottom'): 'right' | 'left' | 'bottom' {
  if (wanted === 'bottom') return 'bottom';
  if (width - rect.right >= ROOM) return 'right';
  if (rect.left >= ROOM) return 'left';
  return 'bottom';
}

/** `side`: where it opens by its anchor, beside it (the default, where there is room) or below it (the side panel). */
export function AnchoredPopover({ anchor, onClose, className, children, label, autoFocus = false, side = 'right' }: { anchor: Anchor; onClose(): void; className?: string; children: ReactNode; label: string; autoFocus?: boolean; side?: 'right' | 'bottom' }) {
  const virtual = { current: { getBoundingClientRect: () => (anchor && 'el' in anchor ? anchor.el.getBoundingClientRect() : anchor ? new DOMRect(anchor.x, anchor.y, 0, 0) : new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0)) } };
  const placed = anchor ? sideFor(virtual.current.getBoundingClientRect(), window.innerWidth, side) : 'bottom';
  return (
    <P.Root open onOpenChange={(o) => !o && onClose()}>
      <P.Anchor virtualRef={virtual} />
      <P.Portal>
        <P.Content
          aria-label={label}
          side={placed}
          align={anchor && placed !== 'bottom' ? 'start' : 'center'}
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
