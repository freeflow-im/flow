// shadcn/ui's Input (MIT, see packages/mail/LICENSE-shadcn.md).
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-lg border border-border bg-white px-3 py-1 text-sm text-ink outline-none transition-colors placeholder:text-muted focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label data-slot="label" className={cn('text-[14px] font-medium text-ink', className)} {...props} />;
}
