// Share… on a native calendar (platform phase 4.4), after Docs' ShareWithDialog: who it is shared with, each with a role
// (Can view, Can edit, Can share) and Remove; add a person or agent of the organization, a channel, or everyone in the
// organization. No link: a calendar is not shared by link. Each change is one call to the grants routes (phase 4.1),
// and a refusal shows the server's message.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { calendarApi, type CalendarInfo, type CalendarSharing, type GrantRole } from '../api';
import { keys, useChannels, useMembers } from '../hooks/calendar';
import { ROLES, addable, grantLabel, ownerOfNative } from '../lib/sharing';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const field = 'h-9 rounded-lg border border-border bg-white px-2 text-sm text-ink outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

export function ShareCalendarDialog({ calendar, org, onClose }: { calendar: CalendarInfo; org: { id: string; name: string } | null; onClose(): void }) {
  const qc = useQueryClient();
  const members = useMembers(org?.id ?? null).data ?? [];
  const channels = useChannels(org?.id ?? null).data ?? [];
  const [sharing, setSharing] = useState<CalendarSharing | null>(null);
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState<GrantRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    calendarApi.grants(calendar.id).then((s) => current && setSharing(s), (e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [calendar.id]);

  const run = async (change: () => Promise<CalendarSharing>) => {
    setBusy(true);
    setError(null);
    try {
      setSharing(await change());
      void qc.invalidateQueries({ queryKey: keys.shared });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const grants = sharing?.grants ?? [];
  const label = (principal: string) => grantLabel({ principal }, members, channels, org?.name);
  const offer = addable(grants, members, channels, ownerOfNative(calendar.id));
  const add = () => void run(() => calendarApi.setGrant(calendar.id, adding, addRole)).then((ok) => ok && setAdding(''));

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{calendar.name}”</DialogTitle>
          <DialogDescription>People, agents and channels you add see its events; an editor can change them too.</DialogDescription>
        </DialogHeader>
        {!sharing && !error && <div className="flex justify-center py-4 text-muted"><Loader2 className="size-5 animate-spin" /></div>}
        {sharing && (
          <>
            <ul aria-label="Shared with" className="flex flex-col gap-1">
              {!grants.length && <li className="py-1 text-[14px] text-muted">Only you can see it.</li>}
              {grants.map((g) => (
                <li key={g.principal} className="flex items-center gap-2 py-1 text-[14px]">
                  <span className="min-w-0 flex-1 truncate">{label(g.principal)}</span>
                  <select aria-label={`Role of ${label(g.principal)}`} className={field} value={g.role} disabled={busy} onChange={(e) => void run(() => calendarApi.setGrant(calendar.id, g.principal, e.target.value as GrantRole))}>
                    {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                  </select>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${label(g.principal)}`} onClick={() => void run(() => calendarApi.removeGrant(calendar.id, g.principal))}>Remove</Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Person, channel or organization" className={`${field} min-w-0 flex-1`} value={adding} disabled={busy} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Add a person, a channel or everyone…</option>
                {offer.people.length > 0 && (
                  <optgroup label="People and agents">
                    {offer.people.map((m) => <option key={m.userId} value={`account:${m.accountId}`}>{m.displayName}{m.isAgent ? ' (agent)' : ''}{m.address ? ` · ${m.address}` : ''}</option>)}
                  </optgroup>
                )}
                {offer.rooms.length > 0 && (
                  <optgroup label="Channels">
                    {offer.rooms.map((c) => <option key={c.id} value={`channel:${c.id}`}>#{c.name}</option>)}
                  </optgroup>
                )}
                {offer.org && <option value="org">Everyone in {org?.name ?? 'the organization'}</option>}
              </select>
              <select aria-label="Role" className={field} value={addRole} disabled={busy} onChange={(e) => setAddRole(e.target.value as GrantRole)}>
                {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
              </select>
              <Button type="button" disabled={busy || !adding} onClick={add}>{busy && <Loader2 className="animate-spin" />}Add</Button>
            </div>
          </>
        )}
        {error && <p role="alert" className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[14px]">{error}</p>}
        <div className="flex justify-end"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Done</Button></div>
      </DialogContent>
    </Dialog>
  );
}
