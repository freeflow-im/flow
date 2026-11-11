// Event log (docs/specs/workspace-admin.md §3.6): the organization's event log (platform.md §5.2) as the admin's account
// may read it, newest first, with filters by type, actor kind, channel and text, and each event's envelope: who acted,
// through which agent (`via`), asked by whom (`invokedBy`), caused by which job. Read-only.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChannelDTO, PlatformEvent, WorkspaceDTO } from '@flow/shared';
import { formatReference } from '@flow/shared';
import { adminApi } from '../api';
import { Button, Card, ErrorLine, Select } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PAGE = 50;

type ActorFilter = 'any' | 'person' | 'agent';

export function EventLog({ org }: { org: WorkspaceDTO }) {
  const [types, setTypes] = useState('');
  const [actor, setActor] = useState<ActorFilter>('any');
  const [channel, setChannel] = useState('');
  const [text, setText] = useState('');
  const [applied, setApplied] = useState({ types: '', actor: 'any' as ActorFilter, channel: '', text: '' });
  /** The pages read so far, newest first; `before` of the next page is the last page's `next`. */
  const [before, setBefore] = useState(0);
  const [pages, setPages] = useState<PlatformEvent[][]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id) });
  const channels = useQuery({ queryKey: ['channels', org.id], queryFn: () => adminApi.channels(org.id) });
  const page = useQuery({
    queryKey: ['events', org.id, applied, before],
    queryFn: () => adminApi.events(org.id, { before, limit: PAGE, ...(applied.types ? { types: applied.types } : {}), ...(applied.channel ? { channel: applied.channel } : {}), ...(applied.actor !== 'any' ? { actor: applied.actor } : {}), ...(applied.text ? { text: applied.text } : {}) }),
  });
  // Each page read lands in order; a filter change starts over (see apply).
  const shown = useMemo(() => {
    const all = [...pages, ...(page.data && !pages.some((p) => p === page.data.events) ? [page.data.events] : [])];
    const seen = new Set<string>();
    return all.flat().filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [pages, page.data]);

  const apply = () => {
    setApplied({ types: types.trim(), actor, channel, text: text.trim() });
    setPages([]);
    setBefore(0);
    setOpen(null);
  };
  const older = () => {
    if (!page.data) return;
    setPages((p) => [...p, page.data.events]);
    setBefore(page.data.next);
  };

  // Who an account id is: the member whose account it is, by name, with the 🤖 mark for an agent.
  const accountName = (accountId: string | null | undefined): string => {
    if (!accountId) return '';
    const a = accounts.data?.find((x) => x.id === accountId);
    const m = a && members.data?.find((x) => x.userId === a.principalId);
    const name = m?.displayName ?? a?.displayName ?? accountId.slice(0, 8);
    return m?.isAgent || a?.agentMode ? `${name} 🤖` : name;
  };
  const principalName = (userId: string | null | undefined): string => {
    if (!userId) return '';
    const a = accounts.data?.find((x) => x.principalId === userId);
    const m = members.data?.find((x) => x.userId === userId);
    return m?.displayName ?? a?.displayName ?? userId.slice(0, 8);
  };
  const channelName = (c: ChannelDTO | undefined, id: string | undefined): string => (id ? (c?.name ? `#${c.name}` : c ? (c.kind === 'dm' ? 'a DM' : 'a group DM') : id.slice(0, 8)) : '');
  const channelOf = (id: string | undefined) => channels.data?.find((c) => c.id === id);
  const when = (iso: string) => new Date(iso).toLocaleString();
  const canReadMore = !!page.data && page.data.events.length >= PAGE && page.data.next > 1;

  return (
    <Card title="Event log" intro="Everything the apps publish into this organization's event log (platform.md §5.2), as your account may read it: the organization's events, your private channels, and what is shared with you. Newest first. An event says who acted, through which agent, and who asked." testid="card-events">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Type
          <input className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" placeholder="chat.* or calendar.event.added" value={types} onChange={(e) => setTypes(e.target.value)} data-testid="events-types" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Actor
          <Select<ActorFilter> value={actor} options={[{ value: 'any', label: 'Anyone' }, { value: 'person', label: 'People' }, { value: 'agent', label: 'Agents' }]} onChange={setActor} testid="events-actor" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Channel
          <select className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="events-channel">
            <option value="">Any</option>
            {(channels.data ?? []).filter((c) => c.kind === 'standard').map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Text
          <input className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" placeholder="words in the event" value={text} onChange={(e) => setText(e.target.value)} data-testid="events-text" />
        </label>
        <Button kind="primary" onClick={apply} testid="events-apply">Show</Button>
      </div>
      {page.isError && <ErrorLine error={errorText(page.error)} />}
      <div className="overflow-x-auto rounded-lg border border-hairline">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline bg-panel text-left text-xs text-faint uppercase">
              <th className="px-3 py-2 font-semibold">When</th>
              <th className="px-3 py-2 font-semibold">Event</th>
              <th className="px-3 py-2 font-semibold">Who</th>
              <th className="px-3 py-2 font-semibold">Where</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const c = channelOf(e.channelId);
              const who = e.actor ? accountName(e.actor) : 'the system';
              return (
                <EventRow key={e.id} e={e} who={who} via={e.via ? principalName(e.via) : ''} asked={e.invokedBy ? accountName(e.invokedBy) : ''} where={channelName(c, e.channelId)} when={when(e.ts)} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
              );
            })}
            {page.isSuccess && shown.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-sm text-muted" colSpan={4} data-testid="events-empty">Nothing yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span data-testid="events-count">{shown.length} {shown.length === 1 ? 'event' : 'events'}</span>
        <span className="flex-1" />
        {canReadMore && (
          <Button kind="link" disabled={page.isFetching} onClick={older} testid="events-older">Older</Button>
        )}
      </div>
    </Card>
  );
}

function EventRow({ e, who, via, asked, where, when, open, onToggle }: { e: PlatformEvent; who: string; via: string; asked: string; where: string; when: string; open: boolean; onToggle(): void }) {
  return (
    <>
      <tr className="cursor-pointer border-b border-hairline hover:bg-hover" onClick={onToggle} data-testid={`event-${e.id}`}>
        <td className="px-3 py-2 whitespace-nowrap text-xs text-muted">{when}</td>
        <td className="px-3 py-2 font-mono text-xs">{e.type}</td>
        <td className="px-3 py-2">
          {who}
          {via && <span className="text-xs text-muted"> via {via}</span>}
          {asked && <span className="text-xs text-muted">, asked by {asked}</span>}
        </td>
        <td className="px-3 py-2 text-xs text-muted">{where}{e.ref ? ` · ${e.ref.app}/${e.ref.kind}` : ''}</td>
      </tr>
      {open && (
        <tr className="border-b border-hairline bg-panel" data-testid={`event-detail-${e.id}`}>
          <td colSpan={4} className="px-3 py-2 text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted">
              <dt>seq</dt><dd className="font-mono text-ink">{e.seq}</dd>
              <dt>id</dt><dd className="font-mono text-ink">{e.id}</dd>
              {e.ref && <><dt>ref</dt><dd className="font-mono text-ink break-all">{formatReference(e.ref)}</dd></>}
              {e.causedBy && <><dt>caused by job</dt><dd className="font-mono text-ink">{e.causedBy} (depth {e.depth})</dd></>}
              {e.actor && <><dt>actor account</dt><dd className="font-mono text-ink">{e.actor}</dd></>}
              {e.via && <><dt>via agent</dt><dd className="font-mono text-ink">{e.via}</dd></>}
              {e.invokedBy && <><dt>invoked by account</dt><dd className="font-mono text-ink">{e.invokedBy}</dd></>}
              <dt>data</dt><dd><pre className="max-h-64 overflow-auto rounded bg-white p-2 font-mono text-ink">{JSON.stringify(e.data, null, 2)}</pre></dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
