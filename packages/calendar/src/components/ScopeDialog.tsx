// The question a change to one occurrence of a repeating event asks first: this event, this and following, or all.
import { useState } from 'react';
import type { Scope } from '../api';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';

export function ScopeDialog({ action, allowThis = true, onChoose, onCancel }: { action: 'edit' | 'delete'; allowThis?: boolean; onChoose(s: Scope): void; onCancel(): void }) {
  const [scope, setScope] = useState<Scope>(allowThis ? 'this' : 'following');
  const options: [Scope, string][] = [...(allowThis ? [['this', 'This event'] as [Scope, string]] : []), ['following', 'This and following events'], ['all', 'All events']];
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm" hideClose aria-describedby={undefined}>
        <h2 className="text-[18px] font-medium">{action === 'edit' ? 'Edit recurring event' : 'Delete recurring event'}</h2>
        <form onSubmit={(e) => { e.preventDefault(); onChoose(scope); }} className="flex flex-col gap-4">
          <div role="radiogroup" className="flex flex-col gap-2">
            {options.map(([s, label]) => (
              <label key={s} className="flex cursor-pointer items-center gap-3 text-[15px]">
                <input type="radio" name="scope" className="size-4 accent-[var(--color-primary)]" checked={scope === s} onChange={() => setScope(s)} autoFocus={scope === s} />
                {label}
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant={action === 'delete' ? 'destructive' : 'default'}>{action === 'delete' ? 'Delete' : 'OK'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
