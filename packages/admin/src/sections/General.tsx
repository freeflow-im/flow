// General (docs/specs/workspace-admin.md §3.1): the organization's name and look, its custom emoji, how people join,
// the agents and sharing policies, link previews, and the owner's two actions. Every control saves as it changes.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_EMOJI_CODE_RE, DEFAULT_SIDEBAR_COLOR, emailDomain, isSelfRegisterableDomain, SIDEBAR_COLORS, WORKSPACE_POLICY_DEFAULTS,
  type SidebarColor, type UpdateWorkspaceBody, type WorkspaceDTO, type WorkspaceEmojiDTO, type WorkspacePolicies,
} from '@flow/shared';
import { adminApi, type AdminApiError } from '../api';
import { suite } from '../suite';
import { useRefreshOrganizations } from '../hooks/organization';
import { Button, Card, Confirm, ErrorLine, Row, Select, Toggle } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_EMOJI_BYTES = 256 * 1024; // the server's limit
const PLATFORM_DOMAIN = 'freeflow.im';

/** The web's drawing of the presets (packages/web/src/lib/sidebarTheme.ts): the default violet is the suite's navy. */
const SUITE_NAVY: SidebarColor = { id: DEFAULT_SIDEBAR_COLOR, name: 'Navy (default)', top: '#27365C', bottom: '#1E2A4A', rail: '#1A2442' };
const COLORS = SIDEBAR_COLORS.map((c) => (c.id === DEFAULT_SIDEBAR_COLOR ? SUITE_NAVY : c));

/** One PATCH of the workspace, then the organizations refetch (the bar and every card read the list). */
function useUpdate(org: WorkspaceDTO) {
  const refresh = useRefreshOrganizations();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (patch: UpdateWorkspaceBody) => adminApi.update(org.id, patch),
    onMutate: () => setError(null),
    onSuccess: () => void refresh(),
    onError: (e) => setError(errorText(e)),
  });
  return { save: (patch: UpdateWorkspaceBody) => m.mutate(patch), busy: m.isPending, error };
}

export function General({ org }: { org: WorkspaceDTO }) {
  return (
    <>
      <NameAndLook org={org} />
      <Emoji org={org} />
      <Joining org={org} />
      <Policies org={org} />
      <LinkPreviews org={org} />
      {org.role === 'owner' && <Ownership org={org} />}
    </>
  );
}

function NameAndLook({ org }: { org: WorkspaceDTO }) {
  const { save, busy, error } = useUpdate(org);
  const refresh = useRefreshOrganizations();
  const [name, setName] = useState(org.name);
  useEffect(() => setName(org.name), [org.name]);
  const [iconError, setIconError] = useState<string | null>(null);
  const icon = useMutation({
    mutationFn: (file: File | null) => (file ? adminApi.setIcon(org.id, file) : adminApi.clearIcon(org.id)),
    onMutate: () => setIconError(null),
    onSuccess: () => void refresh(),
    onError: (e) => setIconError(errorText(e)),
  });
  const trimmed = name.trim();
  const changed = trimmed !== org.name && trimmed.length > 0 && trimmed.length <= 80;

  return (
    <Card title="Name and look" testid="card-name">
      <Row label="Name" help="Shown in every app's bar and in invitations.">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) save({ name: trimmed });
          }}
        >
          <input className="w-64 rounded-md border border-border px-2 py-1 text-sm" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} data-testid="name-input" />
          <Button type="submit" kind="primary" disabled={!changed || busy} testid="name-save">
            Save
          </Button>
        </form>
        <ErrorLine error={error} testid="name-error" />
      </Row>
      <Row label="Address" help="Addresses and the organization's own subdomain depend on it, so it cannot change.">
        <code className="rounded bg-panel px-2 py-1 text-sm" data-testid="slug">
          {org.slug}.{PLATFORM_DOMAIN}
        </code>
      </Row>
      <Row label="Icon" help="PNG, JPEG, GIF or WebP under 1 MB. Without one, the first letter of the name on the color below.">
        <div className="flex items-center gap-3">
          {org.avatarUrl ? (
            <img src={org.avatarUrl} alt={org.name} className="size-12 rounded-xl object-cover" data-testid="icon-image" />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ background: gradient(org.sidebarColor) }} data-testid="icon-placeholder">
              {org.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="flex flex-col items-start gap-0.5">
            <label className="cursor-pointer text-sm text-primary hover:underline">
              {icon.isPending ? 'Working…' : org.avatarUrl ? 'Replace image…' : 'Upload image…'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                data-testid="icon-input"
                disabled={icon.isPending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) icon.mutate(f);
                  e.target.value = '';
                }}
              />
            </label>
            {org.avatarUrl && (
              <Button kind="link" disabled={icon.isPending} onClick={() => icon.mutate(null)} testid="icon-remove">
                Remove
              </Button>
            )}
          </div>
        </div>
        <ErrorLine error={iconError} />
      </Row>
      <Row label="Color" help="The sidebar in Chat and the mark the apps draw for the organization.">
        <div className="grid grid-cols-4 gap-2" data-testid="colors">
          {COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              title={c.name}
              aria-pressed={org.sidebarColor === c.id}
              disabled={busy}
              className={`flex h-10 w-14 items-center justify-center rounded-lg text-white ${org.sidebarColor === c.id ? 'ring-2 ring-primary ring-offset-2' : 'hover:opacity-85'}`}
              style={{ background: gradient(c.id) }}
              onClick={() => save({ sidebarColor: c.id })}
              data-testid={`color-${c.id}`}
            >
              {org.sidebarColor === c.id ? '✓' : ''}
            </button>
          ))}
        </div>
      </Row>
    </Card>
  );
}

const gradient = (id: string) => {
  const c = COLORS.find((x) => x.id === id) ?? COLORS[0]!;
  return `linear-gradient(to bottom, ${c.top}, ${c.bottom})`;
};

function Emoji({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const key = ['emoji', org.id];
  const emoji = useQuery({ queryKey: key, queryFn: () => adminApi.emoji(org.id) });
  const [shortcode, setShortcode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const code = shortcode.trim().toLowerCase();
  const codeOk = CUSTOM_EMOJI_CODE_RE.test(code);
  const list = emoji.data ?? [];
  const taken = list.some((e) => e.shortcode === code);

  const add = useMutation({
    mutationFn: ({ code, file }: { code: string; file: File }) => adminApi.addEmoji(org.id, code, file),
    onMutate: () => setError(null),
    onSuccess: () => {
      setShortcode('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (e: WorkspaceEmojiDTO) => adminApi.removeEmoji(org.id, e.id),
    onMutate: () => setError(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setError(errorText(e)),
  });

  const pickFile = (f: File | null) => {
    setError(null);
    if (f && f.size > MAX_EMOJI_BYTES) {
      setError(`Images must be under ${MAX_EMOJI_BYTES / 1024} KB; that one is ${Math.round(f.size / 1024)} KB.`);
      setFile(null);
      return;
    }
    setFile(f);
    // The file's name is the shortcode until one is typed: the common case is one click.
    if (f && !shortcode.trim()) {
      const base = f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (CUSTOM_EMOJI_CODE_RE.test(base)) setShortcode(base);
    }
  };

  return (
    <Card title="Custom emoji" intro={`An image with a name; anyone in the organization can then react with it. PNG, GIF, WebP or JPEG under ${MAX_EMOJI_BYTES / 1024} KB.`} testid="card-emoji">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (codeOk && !taken && file) add.mutate({ code, file });
        }}
      >
        <span className="text-sm text-muted">:</span>
        <input className="w-44 rounded-md border border-border px-2 py-1 text-sm" placeholder="party-parrot" value={shortcode} onChange={(e) => setShortcode(e.target.value)} data-testid="emoji-shortcode" />
        <span className="text-sm text-muted">:</span>
        <input ref={fileInput} type="file" accept="image/png,image/gif,image/webp,image/jpeg" className="text-sm" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} data-testid="emoji-file" />
        <Button type="submit" kind="primary" disabled={!codeOk || taken || !file || add.isPending} testid="emoji-add">
          {add.isPending ? 'Uploading…' : 'Add emoji'}
        </Button>
      </form>
      {shortcode.trim() && !codeOk && <p className="text-xs text-muted">Letters, digits, - and _ only; 2 to 32 characters.</p>}
      {taken && <p className="text-xs text-muted">:{code}: exists already.</p>}
      <ErrorLine error={error} testid="emoji-error" />
      {emoji.isSuccess && list.length === 0 && <p className="text-sm text-muted" data-testid="emoji-empty">No custom emoji yet.</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {list.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2">
              <img src={`/v1/files/${encodeURIComponent(e.fileId)}`} alt={e.emoji} className="size-6 object-contain" />
              <code className="min-w-0 flex-1 truncate text-sm">{e.emoji}</code>
              <Button kind="link" disabled={remove.isPending} onClick={() => remove.mutate(e)} testid={`emoji-remove-${e.shortcode}`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Joining({ org }: { org: WorkspaceDTO }) {
  const { save, busy, error } = useUpdate(org);
  const policies: WorkspacePolicies = { ...WORKSPACE_POLICY_DEFAULTS, ...org.policies };
  return (
    <Card title="Joining" intro="Whoever joins, by invitation, by link or by signing in with Google, becomes a member with an address and a mailbox. A guest is invited separately, from Members." testid="card-joining">
      <Row label="Who can invite people">
        <Select
          value={policies.inviteBy}
          disabled={busy}
          options={[
            { value: 'admins', label: 'Owners and admins' },
            { value: 'members', label: 'Every member' },
          ]}
          onChange={(v) => save({ policies: { inviteBy: v } })}
          testid="policy-inviteBy"
        />
      </Row>
      <JoinLink org={org} />
      <SelfRegistration org={org} />
      <ErrorLine error={error} />
    </Card>
  );
}

function JoinLink({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const key = ['join-link', org.id];
  const link = useQuery({ queryKey: key, queryFn: () => adminApi.joinLink(org.id) });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<'reset' | 'off' | null>(null);
  const change = useMutation({
    mutationFn: (what: 'on' | 'reset' | 'off') => (what === 'off' ? adminApi.revokeJoinLink(org.id) : adminApi.newJoinLink(org.id)),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorText(e)),
  });
  const url = link.data?.joinUrl ?? null;
  const copy = () => {
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Row label="Join link" help="Anyone with the link joins as a member. Reset replaces it, and the old link stops working.">
      {link.isLoading ? (
        <span className="text-xs text-muted">Loading…</span>
      ) : url ? (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <code className="max-w-xs truncate rounded bg-panel px-2 py-1 text-xs" title={url} data-testid="join-link-url">
            {url}
          </code>
          <div className="flex items-center gap-3">
            <Button kind="link" onClick={copy} testid="join-link-copy">
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {confirming === 'reset' ? (
              <Confirm question="Replace the link? The old one stops working." busy={change.isPending} onYes={() => change.mutate('reset')} onNo={() => setConfirming(null)} testid="join-link-reset-confirm" />
            ) : (
              <Button kind="link" disabled={change.isPending} onClick={() => setConfirming('reset')} testid="join-link-reset">
                Reset
              </Button>
            )}
            {confirming === 'off' ? (
              <Confirm question="Turn the link off?" busy={change.isPending} onYes={() => change.mutate('off')} onNo={() => setConfirming(null)} testid="join-link-off-confirm" />
            ) : (
              <Button kind="link" disabled={change.isPending} onClick={() => setConfirming('off')} testid="join-link-off">
                Turn off
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Button disabled={change.isPending} onClick={() => change.mutate('on')} testid="join-link-on">
          Turn on a join link
        </Button>
      )}
      <ErrorLine error={error} />
    </Row>
  );
}

/** Google self-registration (phase 16 §5a): the domain offered is the signed-in admin's own Google login domain, and
 * the server checks it again (docs/specs/workspace-admin.md ruling 7). */
function SelfRegistration({ org }: { org: WorkspaceDTO }) {
  const { save, busy, error } = useUpdate(org);
  const identities = useQuery({ queryKey: ['identities'], queryFn: adminApi.identities, staleTime: Infinity });
  const google = (identities.data ?? []).find((i) => i.provider === 'google');
  const domain = google ? emailDomain(google.email) : null;
  const offered = domain && isSelfRegisterableDomain(domain) ? domain : null;
  const on = org.googleSelfRegisterDomain;
  if (!offered && !on) return null;
  return (
    <Row
      label="Google sign-in"
      help={
        on && on !== offered ? `Anyone with a Google account at ${on} joins when they sign in.` : `Let anyone with a Google account at ${offered} join when they sign in, with no invitation.`
      }
    >
      <Toggle
        checked={!!on}
        disabled={busy || (!offered && !on)}
        label={on ? 'On' : 'Off'}
        onChange={(v) => save({ googleSelfRegisterDomain: v ? offered : null })}
        testid="self-register"
      />
      <ErrorLine error={error} />
    </Row>
  );
}

function Policies({ org }: { org: WorkspaceDTO }) {
  const { save, busy, error } = useUpdate(org);
  const policies: WorkspacePolicies = { ...WORKSPACE_POLICY_DEFAULTS, ...org.policies };
  return (
    <Card title="Agents and sharing" testid="card-policies">
      <Row label="Who can add agents" help="An agent's sponsor is responsible for it; its mailbox and calendars are part of its account.">
        <Select
          value={policies.agentsBy}
          disabled={busy}
          options={[
            { value: 'members', label: 'Every member' },
            { value: 'admins', label: 'Owners and admins' },
          ]}
          onChange={(v) => save({ policies: { agentsBy: v } })}
          testid="policy-agentsBy"
        />
      </Row>
      <Row label="Sharing by link" help="Whether a document or calendar can be opened by anyone with its link.">
        <Toggle checked={policies.linkSharing} disabled={busy} label={policies.linkSharing ? 'Allowed' : 'Not allowed'} onChange={(v) => save({ policies: { linkSharing: v } })} testid="policy-linkSharing" />
      </Row>
      <ErrorLine error={error} />
    </Card>
  );
}

function LinkPreviews({ org }: { org: WorkspaceDTO }) {
  const { save, busy, error } = useUpdate(org);
  const enabled = org.unfurlEnabled ?? true;
  const listed = org.unfurlDomainAllowlist ?? null;
  const [text, setText] = useState((listed ?? []).join('\n'));
  useEffect(() => setText((org.unfurlDomainAllowlist ?? []).join('\n')), [org.unfurlDomainAllowlist]);
  const domains = text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const changed = JSON.stringify(domains) !== JSON.stringify(listed ?? []);
  return (
    <Card title="Link previews" intro="A link pasted in Chat shows the page's title and picture." testid="card-previews">
      <Row label="Show previews">
        <Toggle checked={enabled} disabled={busy} label={enabled ? 'On' : 'Off'} onChange={(v) => save({ unfurlEnabled: v })} testid="unfurl-enabled" />
      </Row>
      {enabled && (
        <Row label="Only these domains" help="One per line. Empty: any domain is previewed.">
          <form
            className="flex flex-col items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              save({ unfurlDomainAllowlist: domains.length ? domains : null });
            }}
          >
            <textarea className="w-64 rounded-md border border-border px-2 py-1 font-mono text-xs" rows={3} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} data-testid="unfurl-domains" />
            <Button type="submit" kind="primary" disabled={!changed || busy} testid="unfurl-save">
              Save
            </Button>
          </form>
        </Row>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

/** The owner's two actions (docs/specs/workspace-admin.md §3.1): hand the organization to a person, or, alone in it,
 * delete it. The server has the same rules (an heir is a member and a person; delete needs no other people). */
function Ownership({ org }: { org: WorkspaceDTO }) {
  const refresh = useRefreshOrganizations();
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const [heir, setHeir] = useState('');
  const [confirming, setConfirming] = useState<'transfer' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const people = (members.data ?? []).filter((m) => m.userId !== me.data?.id && !m.isAgent && !m.isBot);
  const heirName = people.find((m) => m.userId === heir)?.displayName;
  const alone = members.isSuccess && !!me.data && people.length === 0;

  const transfer = useMutation({
    mutationFn: () => adminApi.transferOwnership(org.id, heir),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      setHeir('');
      void refresh();
    },
    onError: (e: AdminApiError) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => adminApi.deleteWorkspace(org.id),
    onMutate: () => setError(null),
    onSuccess: () => window.location.assign('/'),
    onError: (e: AdminApiError) => setError(errorText(e)),
  });

  let deleteControl: ReactNode;
  if (!members.isSuccess) deleteControl = <span className="text-xs text-muted">Loading…</span>;
  else if (!alone) deleteControl = <span className="text-xs text-muted">Hand the organization to someone first; it can be deleted only by an owner who is alone in it.</span>;
  else if (confirming === 'delete') deleteControl = <Confirm question={`Delete ${org.name} and everything in it? This cannot be undone.`} busy={remove.isPending} onYes={() => remove.mutate()} onNo={() => setConfirming(null)} testid="delete-confirm" />;
  else deleteControl = <Button kind="danger" onClick={() => setConfirming('delete')} testid="delete">Delete organization</Button>;

  return (
    <Card title="Ownership" testid="card-ownership">
      <Row label="Transfer ownership" help="The new owner must be a member and a person. You become an admin.">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={heir}
            disabled={transfer.isPending || confirming === 'transfer'}
            options={[{ value: '', label: 'Choose a member…' }, ...people.map((m) => ({ value: m.userId, label: m.displayName }))]}
            onChange={setHeir}
            testid="heir"
          />
          {confirming === 'transfer' ? (
            <Confirm question={`Make ${heirName} the owner?`} busy={transfer.isPending} onYes={() => transfer.mutate()} onNo={() => setConfirming(null)} testid="transfer-confirm" />
          ) : (
            <Button disabled={!heir} onClick={() => setConfirming('transfer')} testid="transfer">
              Transfer
            </Button>
          )}
        </div>
      </Row>
      <Row label="Delete the organization" help="Its channels, files, documents and mailboxes go with it.">
        {deleteControl}
      </Row>
      <ErrorLine error={error} testid="ownership-error" />
    </Card>
  );
}
