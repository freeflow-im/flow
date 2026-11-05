// shadcn/ui's Dialog (MIT, see packages/calendar/LICENSE-shadcn.md), on Radix.
import type { ComponentProps } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ className, children, hideClose, ...props }: ComponentProps<typeof D.Content> & { hideClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-hairline bg-white p-6 text-ink shadow-xl outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <D.Close className="absolute right-4 top-4 rounded-md p-1 text-muted opacity-70 hover:bg-hover hover:opacity-100" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
}

export const DialogHeader = ({ className, ...props }: ComponentProps<'div'>) => <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
export const DialogFooter = ({ className, ...props }: ComponentProps<'div'>) => <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
export const DialogTitle = ({ className, ...props }: ComponentProps<typeof D.Title>) => <D.Title className={cn('text-lg font-semibold leading-none', className)} {...props} />;
export const DialogDescription = ({ className, ...props }: ComponentProps<typeof D.Description>) => <D.Description className={cn('text-sm text-muted', className)} {...props} />;
