// Share… (FreeFlow suite): who a file or folder is shared with, on grants (server/access.ts, platform phase 3.2). Its
// grants as rows (a person, a channel, everyone in the organization, anyone with the link), each with its role; adding
// a person or a channel of the organization; the organization toggle (Share with organization / Make private); and the
// link, for a presentation or a video. Someone who does not manage the file sees who has it, without the controls.
import { useEffect, useState } from 'react';
import { api, type GrantInfo, type GrantKind, type GrantRole, type Sharing } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useOrganization } from '../organization.ts';
import { suite, type SuiteChannel, type SuiteMember } from '../suite.ts';
import { Modal } from './Modal.tsx';

const ROLES: { role: GrantRole; label: string }[] = [
  { role: 'viewer', label: 'Can view' },
  { role: 'editor', label: 'Can edit' },
  { role: 'manager', label: 'Can share' },
];
const manages = (role: GrantRole | undefined) => role === 'manager' || role === 'owner';

export function ShareWithDialog(props: {
  kind: GrantKind;
  id: string;
  name: string;
  /** Whether it can have a link anyone can open (a presentation, or a video a browser plays). */
  linkable?: boolean;
  onClose(): void;
  /** Its root changed (the organization toggle): now in Organization files (`shared`) or not. */
  onMoved?(shared: boolean): void;
}) {
  const { user } = useAuth();
  const org = useOrganization();
  const [id, setId] = useState(props.id);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [members, setMembers] = useState<SuiteMember[]>([]);
  const [channels, setChannels] = useState<SuiteChannel[]>([]);
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState<GrantRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.grants(props.kind, props.id).then(
      (s) => current && setSharing(s),
      (e: Error) => current && setError(e.message),
    );
    if (org.active) {
      suite.members(org.active.id).then((m) => current && setMembers(m), () => {});
      suite.channels(org.active.id).then((c) => current && setChannels(c.filter((x) => x.name && !x.archivedAt)), () => {});
    }
    return () => {
      current = false;
    };
  }, [props.kind, props.id, org.active?.id]);

  const run = async (change: () => Promise<Sharing | { url: string }>, orgAfter?: boolean) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const next = await change();
      if ('grants' in next) {
        setSharing(next);
        if (next.id) setId(next.id);
      } else setSharing(await api.grants(props.kind, id));
      if (orgAfter !== undefined) props.onMoved?.(orgAfter);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const principalOf = (m: SuiteMember) => `account:${m.accountId ?? m.userId}`;
  const label = (g: GrantInfo): string => {
    if (g.principal === 'org') return `Everyone in ${org.active?.name ?? 'the organization'}`;
    if (g.principal.startsWith('link:')) return 'Anyone with the link';
    if (g.principal.startsWith('channel:')) {
      const c = channels.find((x) => `channel:${x.id}` === g.principal);
      return c ? `#${c.name}` : 'A channel';
    }
    const m = members.find((x) => principalOf(x) === g.principal);
    return m ? `${m.displayName}${m.isAgent ? ' (agent)' : ''}` : 'A member';
  };

  const canManage = manages(sharing?.role);
  const shown = (sharing?.grants ?? []).filter((g) => !g.principal.startsWith('link:'));
  const orgShared = shown.some((g) => g.principal === 'org');
  const taken = new Set(shown.map((g) => g.principal));
  const people = members.filter((m) => m.userId !== user?.id && !taken.has(principalOf(m)));
  // Sharing with a shared agent shares with the whole organization (docs/specs/agents.md §4): the person judges once, here.
  const peopleCount = members.filter((m) => !m.isAgent).length;
  const orgName = org.active?.name ?? 'the organization';
  const agentChosen = people.find((m) => m.isAgent && principalOf(m) === adding);
  const agentOf = (g: GrantInfo) => members.find((m) => m.isAgent && principalOf(m) === g.principal);
  const rooms = channels.filter((c) => !taken.has(`channel:${c.id}`));
  const copy = async () => {
    if (!sharing?.link) return;
    try {
      await navigator.clipboard.writeText(sharing.link);
      setCopied(true);
    } catch {
      setError('The link could not be copied. Select it and copy it yourself.');
    }
  };

  return (
    <Modal title={`Share “${props.name}”`} onClose={props.onClose} className="share-with">
      {!sharing && !error && <p>Loading…</p>}
      {sharing && (
        <>
          <ul className="share-rows" aria-label="Shared with">
            {shown.length === 0 && <li className="muted">Only you{sharing.role === 'owner' ? '' : ' and its owner'} can open it.</li>}
            {shown.map((g) => (
              <li key={g.principal} className="share-row">
                <span className="share-who">{label(g)}</span>
                {canManage ? (
                  <>
                    <select aria-label={`Role of ${label(g)}`} value={g.role} disabled={busy} onChange={(e) => void run(() => api.setGrant(props.kind, id, g.principal, e.target.value as GrantRole))}>
                      {ROLES.map((r) => (
                        <option key={r.role} value={r.role}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    <button className="btn" disabled={busy} aria-label={`Remove ${label(g)}`} onClick={() => void run(() => api.removeGrant(props.kind, id, g.principal), g.principal === 'org' ? false : undefined)}>
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="muted">{ROLES.find((r) => r.role === g.role)?.label}</span>
                )}
                {agentOf(g) && (
                  <span className="muted small share-agent-note" data-testid={`share-agent-note-${g.principal}`}>
                    Everyone in {orgName} can ask {agentOf(g)!.displayName} about this.
                  </span>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <>
              <div className="share-add">
                <select aria-label="Person or channel" value={adding} disabled={busy} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Add a person or a channel…</option>
                  {people.length > 0 && (
                    <optgroup label="People and agents">
                      {people.map((m) => (
                        <option key={m.userId} value={principalOf(m)}>
                          {m.displayName}
                          {m.isAgent ? ' (agent)' : ''}
                          {m.address ? ` · ${m.address}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {rooms.length > 0 && (
                    <optgroup label="Channels">
                      {rooms.map((c) => (
                        <option key={c.id} value={`channel:${c.id}`}>
                          #{c.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <select aria-label="Role" value={addRole} disabled={busy} onChange={(e) => setAddRole(e.target.value as GrantRole)}>
                  {ROLES.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy || !adding} onClick={() => void run(() => api.setGrant(props.kind, id, adding, addRole)).then(() => setAdding(''))}>
                  Add
                </button>
              </div>
              {agentChosen && (
                <p className="share-who" data-testid="share-agent-warning">
                  Everyone in {orgName} ({peopleCount} {peopleCount === 1 ? 'person' : 'people'}) will be able to ask {agentChosen.displayName} about this: a shared agent keeps no secrets from the organization.
                </p>
              )}
              <label className="share-org">
                <input type="checkbox" checked={orgShared} disabled={busy} onChange={(e) => void run(() => (e.target.checked ? api.setGrant(props.kind, id, 'org', 'editor') : api.removeGrant(props.kind, id, 'org')), e.target.checked)} />
                Everyone in {org.active?.name ?? 'the organization'} can edit it (Organization files)
              </label>
            </>
          )}
          {props.linkable && (canManage || sharing.link) && (
            <div className="share-link">
              <div className="share-who">Anyone with the link can view it, without signing in.</div>
              {sharing.link ? (
                <div className="share-add">
                  <input aria-label="Link" readOnly value={sharing.link} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  {canManage && (
                    <button className="btn" disabled={busy} onClick={() => void run(() => api.removeGrant(props.kind, id, `link:${sharing.link!.split('/p/')[1]}`))}>
                      Remove
                    </button>
                  )}
                </div>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void run(() => api.makeLink(props.kind, id))}>
                  Create link
                </button>
              )}
            </div>
          )}
        </>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
