// shadcn/ui's DropdownMenu (MIT, see packages/calendar/LICENSE-shadcn.md), on Radix: the parts the calendar uses.
import type { ComponentProps } from 'react';
import { DropdownMenu as M } from 'radix-ui';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuSub = M.Sub;

const content = 'z-50 min-w-[10rem] max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto rounded-lg border border-hairline bg-white p-1 text-ink shadow-lg';

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={sideOffset} className={cn(content, className)} {...props} />
    </M.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof M.Item>) {
  return (
    <M.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted',
        className,
      )}
      {...props}
    />
  );
}

export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof M.Label>) => (
  <M.Label className={cn('px-2 py-1.5 text-[12px] font-medium uppercase tracking-[.06em] text-muted', className)} {...props} />
);
export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof M.Separator>) => <M.Separator className={cn('-mx-1 my-1 h-px bg-hairline', className)} {...props} />;

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn('flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[state=open]:bg-hover [&_svg]:size-4 [&_svg]:text-muted', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </M.SubTrigger>
  );
}
export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent className={cn(content, className)} {...props} />
    </M.Portal>
  );
}
