// shadcn/ui's Tabs (MIT, see packages/mail/LICENSE-shadcn.md), on Radix.
import type { ComponentProps } from 'react';
import { Tabs as T } from 'radix-ui';
import { cn } from '../../lib/utils';

export const Tabs = T.Root;
export const TabsList = ({ className, ...props }: ComponentProps<typeof T.List>) => (
  <T.List className={cn('inline-flex h-8 items-center rounded-lg bg-track p-[3px] text-muted', className)} {...props} />
);
export const TabsTrigger = ({ className, ...props }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      'inline-flex h-full items-center justify-center whitespace-nowrap rounded-md px-3 text-[14px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=active]:bg-white data-[state=active]:text-ink data-[state=active]:shadow-sm',
      className,
    )}
    {...props}
  />
);
