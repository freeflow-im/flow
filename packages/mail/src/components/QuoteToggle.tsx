// Gmail's "⋯": the small grey pill that stands for the earlier messages quoted at the end of a message, in a message
// read (MessageBody.tsx) and in the composer (ComposeForm.tsx). A click shows them; in a message read, another hides
// them again.
import { Ellipsis } from 'lucide-react';
import { cn } from '../lib/utils';

export function QuoteToggle({ open, onClick, className }: { open: boolean; onClick(): void; className?: string }) {
  const label = open ? 'Hide quoted text' : 'Show quoted text';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('inline-flex h-[18px] items-center rounded-md bg-row-selected px-2 text-muted hover:bg-hover hover:text-ink', className)}
    >
      <Ellipsis className="size-4" />
    </button>
  );
}
