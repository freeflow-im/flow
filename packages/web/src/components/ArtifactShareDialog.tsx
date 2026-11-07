// Share… on an artifact (platform phases 3.4 and 6.4): who outside its channel may open it by id, on the grants routes
// (GET/PUT/DELETE /v1/artifacts/:id/grants). Its grants as rows (a person, a channel, everyone in the organization), each
// with its role; adding a person or a channel. Someone who does not manage it sees who has it, without the controls.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ArtifactDTO, Grant, Role } from '@flow/shared';
import { useChannels, useMembers } from '../hooks';
import { useBoundApi } from '../lib/useBoundApi';
import { useAuth, useSelection } from '../state';
import { Modal } from './modals';

interface Sharing { grants: Grant[]; role: Role | null }

const ROLES: { role: Role; label: string }[] = [
  { role: 'viewer', label: 'Can view' },
  { role: 'editor', label: 'Can edit' },
  { role: 'manager', label: 'Can share' },
];

export function ArtifactShareDialog({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const { api } = useBoundApi();
  const sel = useSelection();
  const me = useAuth().user;
  const members = useMembers(sel.workspaceId).data ?? [];
  const channels = (useChannels(sel.workspaceId).data ?? []).filter((c) => c.name && !c.archivedAt);
  const artifact = useQuery({ queryKey: ['artifact', artifactId], queryFn: () => api<ArtifactDTO>('GET', `/v1/artifacts/${artifactId}`), retry: false });
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/v1/artifacts/${encodeURIComponent(artifactId)}/grants`;

  useEffect(() => {
    let current = true;
    api<Sharing>('GET', path).then((s) => current && setSharing(s), (e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [api, path]);

  const run = async (change: () => Promise<Sharing>) => {
    setBusy(true);
    setError(null);
    try {
      setSharing(await change());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const grant = (principal: string, role: Role) => run(() => api<Sharing>('PUT', path, { principal, role }));
  const label = (principal: string): string => {
    if (principal === 'org') return 'Everyone in the organization';
    if (principal.startsWith('channel:')) return `#${channels.find((c) => `channel:${c.id}` === principal)?.name ?? 'a channel'}`;
    const m = members.find((x) => `account:${x.accountId}` === principal);
    return m ? `${m.displayName}${m.isAgent ? ' (agent)' : ''}` : 'A member';
  };

  const canManage = sharing?.role === 'manager' || sharing?.role === 'owner';
  const taken = new Set((sharing?.grants ?? []).map((g) => g.principal));
  const people = members.filter((m) => m.accountId && m.userId !== me?.id && !taken.has(`account:${m.accountId}`));
  const rooms = channels.filter((c) => c.id !== artifact.data?.channelId && !taken.has(`channel:${c.id}`));
  const select = 'rounded border border-hairline2 px-2 py-1.5 text-sm';

  return (
    <Modal onClose={onClose} testid="artifact-share-modal" wide>
      <h3 className="mb-3 font-bold">Share “{artifact.data?.name ?? 'artifact'}”</h3>
      {!sharing && !error && <p className="text-sm text-muted">Loading…</p>}
      {sharing && (
        <>
          <ul className="mb-3 space-y-1.5" aria-label="Shared with">
            {sharing.grants.length === 0 && <li className="text-sm text-muted">Only the people in its channel can open it.</li>}
            {sharing.grants.map((g) => (
              <li key={g.principal} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{label(g.principal)}</span>
                {canManage ? (
                  <>
                    <select aria-label={`Role of ${label(g.principal)}`} className={select} value={g.role} disabled={busy} onChange={(e) => void grant(g.principal, e.target.value as Role)}>
                      {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                    </select>
                    <button className="px-2 py-1 text-sm text-ink-soft hover:text-ink" disabled={busy} aria-label={`Remove ${label(g.principal)}`}
                      onClick={() => void run(() => api<Sharing>('DELETE', `${path}/${encodeURIComponent(g.principal)}`))}>Remove</button>
                  </>
                ) : (
                  <span className="text-muted">{ROLES.find((r) => r.role === g.role)?.label}</span>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select aria-label="Person or channel" className={`${select} min-w-0 flex-1`} value={adding} disabled={busy} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Add a person or a channel…</option>
                {people.length > 0 && (
                  <optgroup label="People and agents">
                    {people.map((m) => <option key={m.userId} value={`account:${m.accountId}`}>{m.displayName}{m.isAgent ? ' (agent)' : ''}</option>)}
                  </optgroup>
                )}
                {rooms.length > 0 && (
                  <optgroup label="Channels">
                    {rooms.map((c) => <option key={c.id} value={`channel:${c.id}`}>#{c.name}</option>)}
                  </optgroup>
                )}
              </select>
              <select aria-label="Role" className={select} value={addRole} disabled={busy} onChange={(e) => setAddRole(e.target.value as Role)}>
                {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
              </select>
              <button data-testid="artifact-share-add" className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !adding}
                onClick={() => void grant(adding, addRole).then(() => setAdding(''))}>Add</button>
            </div>
          )}
        </>
      )}
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex justify-end">
        <button className="px-3 py-1.5 text-sm text-ink-soft" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
