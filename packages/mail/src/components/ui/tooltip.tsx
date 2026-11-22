// shadcn/ui's Tooltip (MIT, see packages/mail/LICENSE-shadcn.md), on Radix: a short line of text on hover or focus.
import type { ReactNode } from 'react';
import { Tooltip as T } from 'radix-ui';
import { cn } from '../../lib/utils';

/** `content` beside `children` (one focusable or hoverable element) while the pointer or focus is on it. */
export function Tooltip({ content, children, side = 'bottom', className }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; className?: string }) {
  return (
    <T.Provider delayDuration={300}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          {/* Above the floating assistant panel, which sits over the page. */}
          <T.Content side={side} sideOffset={6} className={cn('z-[1000] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-[12px] leading-snug text-white shadow-lg', className)}>
            {content}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
