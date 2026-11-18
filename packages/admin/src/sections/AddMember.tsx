// Add member (docs/specs/workspace-admin.md §3.2): the Members page's one way in, a dialog with a User / Agent switch.
// A user is created at username@domain with a setup link to a backup email (as Create member did), or invited by an
// outside address as a member or a chat guest. An agent is hosted (made here at once with its name and picture, shared
// with the organization or private to the admin), or external: a one-time invite code and the MCP address, shown in the connection dialog, and the agent joins
// when it connects (no account exists before then).
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AccountKind, AgentInviteDTO, CreateMemberResultDTO, InviteResultDTO, WorkspaceDTO } from '@flow/shared';
import { adminApi, assistantApi, connectionsApi } from '../api';
import { Button, ErrorLine, Select, Toggle } from '../components/ui';
import { Modal } from '../components/Modal';
import { choiceUrl, PicturePicker, type PictureChoice } from './AgentPicture';
import { connectPrompt } from '@flow/shared/assistant';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = 'w-full rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50';

/** A username from a display name, until the admin types one: "Bea Lin" → "bea.lin". The server checks it. */
export const suggestUsername = (name: string) =>
  name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean).join('.').slice(0, 64);

/** An agent's handle from its name, as the server makes one ("Scout Bot" → scout-bot); '' when the name has none. */
export const agentHandle = (name: string) => {
  const h = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 28);
  return h ? h.padEnd(3, '0') : '';
};

/** The local part an address takes from a handle or a name (directory/addresses.ts `localPart`): "scout-bot" → scout.bot. */
export const addressLocal = (name: string) =>
  name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9.]+/).filter(Boolean).join('.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');

/** A shell word: the name in the bridge command, quoted only when it needs to be. */
const shellWord = (s: string) => (/^[A-Za-z0-9._-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The invite command with the name and handle the admin chose, so the agent's setup skips those prompts. */
export const bridgeCommand = (invite: AgentInviteDTO, name: string) => {
  const handle = agentHandle(name);
  return `${invite.command}${name.trim() ? ` --name ${shellWord(name.trim())}` : ''}${handle ? ` --handle ${handle}` : ''}`;
};

/** What the page learns when someone was added: a line to show, and the member to point at, when one exists yet. */
export interface Added {
  message: string;
  tone: 'ok' | 'warn';
  userId?: string;
}

type Who = 'user' | 'agent';
type UserMode = 'create' | 'invite';

/** The verified domains, primary first, and the one an address takes by default. */
function useDomains(org: WorkspaceDTO) {
  const domains = useQuery({ queryKey: ['domains', org.id], queryFn: () => adminApi.domains(org.id) });
  const usable = (domains.data ?? []).filter((d) => d.verified).sort((a, b) => Number(b.primary) - Number(a.primary));
  return { domains, usable, primary: usable.find((d) => d.primary)?.domain ?? usable[0]?.domain ?? '' };
}

function Preview({ label, address, note, testid }: { label: string; address: string; note?: string; testid: string }) {
  return (
    <div className="rounded-md border border-hairline bg-panel px-3 py-2 text-xs text-muted" data-testid={testid}>
      {label} <span className="font-mono text-sm text-ink">{address}</span>
      {note && <span className="block pt-0.5">{note}</span>}
    </div>
  );
}

export function AddMemberModal({ org, onClose, onAdded, onExternal }: { org: WorkspaceDTO; onClose(): void; onAdded(a: Added): Promise<unknown> | void; onExternal(name: string, invite: AgentInviteDTO): void }) {
  const [who, setWho] = useState<Who>('user');
  return (
    <Modal title="Add member" onClose={onClose} testid="add-member-modal">
      <div className="mb-4 flex gap-1 self-start rounded-lg bg-panel p-1 text-sm" role="tablist" aria-label="What to add">
        {(['user', 'agent'] as const).map((w) => (
          <button key={w} type="button" role="tab" aria-selected={who === w} className={`rounded-md px-4 py-1 ${who === w ? 'bg-white font-semibold shadow-sm' : 'text-muted hover:text-ink'}`} onClick={() => setWho(w)} data-testid={`add-kind-${w}`}>
            {w === 'user' ? 'User' : 'Agent'}
          </button>
        ))}
      </div>
      {who === 'user' ? <UserForm org={org} onClose={onClose} onAdded={onAdded} /> : <AgentForm org={org} onClose={onClose} onAdded={onAdded} onExternal={onExternal} />}
    </Modal>
  );
}

function UserForm({ org, onClose, onAdded }: { org: WorkspaceDTO; onClose(): void; onAdded(a: Added): Promise<unknown> | void }) {
  const [mode, setMode] = useState<UserMode>('create');
  const [guest, setGuest] = useState(false);
  const link = 'text-xs text-primary hover:underline';
  if (mode === 'invite') {
    return (
      <div className="flex flex-col gap-3">
        <Invite org={org} guest={guest} onAdded={onAdded} />
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" className={link} onClick={() => setMode('create')} data-testid="add-mode-create">
            Create a member with an address instead
          </button>
          <button type="button" className={link} onClick={() => setGuest(!guest)} data-testid={guest ? 'add-mode-invite' : 'add-mode-guest'}>
            {guest ? 'Invite as members instead' : 'Invite chat guests instead'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <CreateMember org={org} onClose={onClose} onAdded={onAdded} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-3">
        <button type="button" className={link} onClick={() => { setGuest(false); setMode('invite'); }} data-testid="add-mode-invite">
          Invite by email instead
        </button>
        <button type="button" className={link} onClick={() => { setGuest(true); setMode('invite'); }} data-testid="add-mode-guest">
          Invite a chat guest
        </button>
      </div>
    </div>
  );
}

/** A native account at username@domain, right away, with no password; the setup link (a week) goes to the backup email,
 * which "Forgot password" reaches too. */
function CreateMember({ org, onClose, onAdded }: { org: WorkspaceDTO; onClose(): void; onAdded(a: Added): Promise<unknown> | void }) {
  const { domains, usable, primary } = useDomains(org);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [typedUsername, setTypedUsername] = useState(false);
  const [domain, setDomain] = useState('');
  const [backupEmail, setBackupEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosenDomain = domain || primary;
  const shownUsername = typedUsername ? username : suggestUsername(displayName);
  const create = useMutation({
    mutationFn: () => adminApi.createMember(org.id, { displayName: displayName.trim(), username: shownUsername.trim(), domain: chosenDomain, backupEmail: backupEmail.trim() }),
    onMutate: () => setError(null),
    onSuccess: async (out: CreateMemberResultDTO) => {
      onClose();
      await onAdded({
        userId: out.account.principalId,
        tone: out.emailSent ? 'ok' : 'warn',
        message: out.emailSent
          ? `Created ${out.account.address}. A setup link went to ${out.pending?.backupEmail}.`
          : `Created ${out.account.address}, but the setup email could not be sent. Use Resend setup link under Pending.`,
      });
    },
    onError: (e) => setError(errorText(e)),
  });
  const ready = !!displayName.trim() && !!shownUsername.trim() && !!chosenDomain && !!backupEmail.trim();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
      data-testid="create-member"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Display name</span>
        <input className={input} value={displayName} disabled={create.isPending} onChange={(e) => setDisplayName(e.target.value)} placeholder="Bea Lin" autoComplete="off" data-testid="create-name" />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Username</span>
        <div className="flex items-center gap-1">
          <input
            className={`${input} min-w-0 flex-1`}
            aria-label="Username"
            value={shownUsername}
            disabled={create.isPending}
            onChange={(e) => {
              setTypedUsername(true);
              setUsername(e.target.value.replace(/@.*$/, '').toLowerCase());
            }}
            placeholder="bea.lin"
            autoComplete="off"
            data-testid="create-username"
          />
          <span className="text-muted">@</span>
          {usable.length > 1 ? (
            <Select value={chosenDomain} disabled={create.isPending} options={usable.map((d) => ({ value: d.domain, label: d.domain }))} onChange={setDomain} testid="create-domain" />
          ) : (
            <span className="rounded-md bg-panel px-2 py-1 text-sm" data-testid="create-domain">
              {chosenDomain || '…'}
            </span>
          )}
        </div>
        <span className="text-xs text-muted">Letters, digits, dots, hyphens and underscores. Verified domains only.</span>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Backup email</span>
        <input className={input} type="email" value={backupEmail} disabled={create.isPending} onChange={(e) => setBackupEmail(e.target.value)} placeholder="bea@gmail.com" autoComplete="off" data-testid="create-backup" />
        <span className="text-xs text-muted">Outside your domain. A setup link, good for 7 days, goes here, and so do password resets.</span>
      </label>
      <Preview label="Their address:" address={`${shownUsername.trim() || 'username'}@${chosenDomain || 'your-domain'}`} testid="create-preview" />
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" type="submit" disabled={create.isPending || !ready} testid="create-submit">
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
      {domains.isError && <ErrorLine error={errorText(domains.error)} />}
      <ErrorLine error={error} testid="create-error" />
    </form>
  );
}

const parseEmails = (text: string) => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean))];

const STATUS_TEXT: Record<InviteResultDTO['status'], string> = {
  sent: 'invited',
  resent: 'invited again',
  already_member: 'already a member',
  invalid_email: 'not an email address',
  email_failed: 'invited, but the email could not be sent',
};

/** Invite people by their own address (§3.2, §6.5), as members or as chat guests. The results stay in the dialog. */
function Invite({ org, guest, onAdded }: { org: WorkspaceDTO; guest: boolean; onAdded(a: Added): Promise<unknown> | void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<InviteResultDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emails = parseEmails(text);
  const kind: AccountKind = guest ? 'guest' : 'native';
  const send = useMutation({
    mutationFn: () => adminApi.invite(org.id, emails, kind),
    onMutate: () => setError(null),
    onSuccess: (out) => {
      setResults(out);
      // Only what failed stays in the box, so a retry does not send the rest again.
      setText(out.filter((r) => r.status === 'invalid_email' || r.status === 'email_failed').map((r) => r.email).join(', '));
      const sent = out.filter((r) => r.status === 'sent' || r.status === 'resent').length;
      if (sent) void onAdded({ tone: 'ok', message: `Invited ${sent} ${guest ? (sent === 1 ? 'chat guest' : 'chat guests') : sent === 1 ? 'person' : 'people'}. They appear under Pending until they join.` });
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <div className="flex flex-col gap-3" data-testid="invite-form">
      <p className="text-xs text-muted">
        {guest
          ? 'Chat guests use Chat only. They get no address and no mailbox here. Separate addresses with commas.'
          : 'Each person gets an email with a link and joins with their own address. Separate addresses with commas.'}
      </p>
      <textarea className={input} rows={3} placeholder="email@example.com, someone@example.com" value={text} disabled={send.isPending} onChange={(e) => setText(e.target.value)} data-testid="invite-emails" />
      <div className="flex justify-end">
        <Button kind="primary" disabled={send.isPending || emails.length === 0} onClick={() => send.mutate()} testid={guest ? 'invite-guests' : 'invite-people'}>
          {guest ? (emails.length > 1 ? `Invite ${emails.length} as chat guests` : 'Invite a chat guest') : emails.length > 1 ? `Invite ${emails.length} people` : 'Invite people'}
        </Button>
      </div>
      {results && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline text-sm" data-testid="invite-results">
          {results.map((r) => (
            <li key={r.email} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate">{r.email}</span>
              <span className={`text-xs ${r.status === 'invalid_email' || r.status === 'email_failed' ? 'text-warn' : 'text-muted'}`}>
                {STATUS_TEXT[r.status]}
                {r.kind === 'guest' && (r.status === 'sent' || r.status === 'resent') ? ' as a chat guest' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} testid="invite-error" />
    </div>
  );
}

/** A local address for a picked file, while it is picked. */
function usePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') return setUrl(null);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

/**
 * An agent: native (hosted here, made at once, as Agents' Create an agent makes a shared one) or external (it runs
 * elsewhere and connects in with a one-time code, as Agents' Invite an agent, or over MCP).
 */
function AgentForm({ org, onClose, onAdded, onExternal }: { org: WorkspaceDTO; onClose(): void; onAdded(a: Added): Promise<unknown> | void; onExternal(name: string, invite: AgentInviteDTO): void }) {
  const { primary } = useDomains(org);
  const [name, setName] = useState('');
  // Hosted (FreeFlow runs it) is the default; unchecking it means External. A hosted agent is private (acts as you, only
  // you can ask it, as Your agents makes one) or shared (anyone in the organization can ask it): chosen once (agents.md §1.3).
  const [hosted, setHosted] = useState(true);
  const external = !hosted;
  const [access, setAccess] = useState<'private' | 'shared'>('shared');
  const priv = hosted && access === 'private';
  const mine = useQuery({ queryKey: ['my-agents', org.id], queryFn: () => adminApi.myAgents(org.id), enabled: priv });
  const limit = mine.data?.limit ?? 5;
  const full = priv && !!mine.data?.agents && mine.data.agents.length >= limit;
  const [picture, setPicture] = useState<PictureChoice>(null);
  const preview = usePreview(picture && 'file' in picture ? picture.file : null);
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: async () => {
      if (external) return { kind: 'external' as const, invite: await adminApi.agentInvite(org.id) };
      const made = priv ? await adminApi.makePersonalAgent(org.id, { name: name.trim() }) : await adminApi.makeHostedAgent(org.id, { name: name.trim() });
      // The picture waits for the agent to exist; a failed one leaves the agent made, with the error said.
      let pictureError: string | null = null;
      if (picture) {
        try {
          if ('preset' in picture) await assistantApi.setPreset(org.id, picture.preset, made.agent.id);
          else await assistantApi.uploadPicture(org.id, picture.file, made.agent.id);
        } catch (e) {
          pictureError = errorText(e);
        }
      }
      return { kind: 'native' as const, made, pictureError };
    },
    onMutate: () => setError(null),
    onSuccess: async (out) => {
      onClose();
      if (out.kind === 'external') return onExternal(name.trim(), out.invite);
      await onAdded({
        userId: out.made.agent.id,
        tone: out.pictureError ? 'warn' : 'ok',
        message: out.pictureError
          ? `Created ${out.made.agent.displayName}, but its picture was not saved: ${out.pictureError}`
          : out.made.agent.mode === 'personal'
            ? `Created ${out.made.agent.displayName}. Only you can ask it: pick it in the assistant panel, or message it in Chat.`
            : `Created ${out.made.agent.displayName}. Anyone in ${org.name} can ask it from the assistant panel or in Chat.`,
      });
    },
    onError: (e) => setError(errorText(e)),
  });
  const local = addressLocal(agentHandle(name)) || 'name';
  const address = `${local}@${primary || 'your-domain'}`;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && !full) make.mutate();
      }}
      data-testid="create-agent-form"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Name</span>
        <input className={input} value={name} maxLength={80} disabled={make.isPending} onChange={(e) => setName(e.target.value)} placeholder="Scout" autoComplete="off" data-testid="agent-name" />
      </label>
      <div className="flex flex-col gap-1">
        <Toggle checked={hosted} disabled={make.isPending} onChange={setHosted} label="Hosted" testid="agent-hosted" />
        <span className="pl-6 text-xs text-muted">
          {hosted
            ? 'FreeFlow runs it for you: no machine of your own.'
            : 'It runs somewhere else (Claude Code, Codex, a cloud agent) and connects in. Next you get its connection steps; it joins when it connects and picks its own picture, which you can change later.'}
        </span>
      </div>
      {hosted && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Who can use it</legend>
          <div className="flex gap-1 self-start rounded-lg bg-panel p-1 text-sm" role="radiogroup" aria-label="Who can use it">
            {(['shared', 'private'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={access === v} disabled={make.isPending} className={`rounded-md px-3 py-0.5 ${access === v ? 'bg-white font-semibold shadow-sm' : 'text-muted hover:text-ink'}`} onClick={() => setAccess(v)} data-testid={`agent-${v}`}>
                {v === 'shared' ? 'Shared' : 'Private'}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted">
            {access === 'shared'
              ? `Anyone in ${org.name} can ask it. It sees only what is shared with it, and you are its sponsor.`
              : `Only you can ask it. It acts as you and sees what you see.${mine.data?.agents ? ` You have ${mine.data.agents.length} of ${limit}, your assistant included.` : ''}`}{' '}
            You choose this once.
          </span>
        </fieldset>
      )}
      {hosted && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Picture</span>
          <PicturePicker current={choiceUrl(picture, preview)} busy={make.isPending} onPreset={(p) => setPicture({ preset: p })} onFile={(f) => setPicture({ file: f })} onNone={() => setPicture(null)} testid="agent-picture" />
        </div>
      )}
      {priv ? (
        <div className="rounded-md border border-hairline bg-panel px-3 py-2 text-xs text-muted" data-testid="agent-preview">
          No address: a private agent acts as you and has no inbox of its own.
        </div>
      ) : (
        <Preview label={external ? 'Its address once it connects:' : 'Its address:'} address={address} note="A shared agent gets an inbox at this address. If it is taken, a number is added." testid="agent-preview" />
      )}
      {full && <p className="text-xs text-warn" data-testid="agent-full">You have {limit} private agents, the most one person may have. Remove one under Your agents first.</p>}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" type="submit" disabled={make.isPending || !name.trim() || full} testid="agent-submit">
          {make.isPending ? 'Creating…' : external ? 'Create and connect' : 'Create'}
        </Button>
      </div>
      <ErrorLine error={error} testid="agent-error" />
    </form>
  );
}

/** An external agent's connection steps: the one-time code's bridge command (a cloud or coding agent), or the MCP address
 * (Claude Code, Codex, any MCP client). The same steps as Agents' Invite an agent and Connect an agent. */
export function ConnectAgentModal({ name, invite, onClose }: { name: string; invite: AgentInviteDTO; onClose(): void }) {
  const [tab, setTab] = useState<'npx' | 'mcp'>('npx');
  const [copied, setCopied] = useState<string | null>(null);
  const conn = useQuery({ queryKey: ['agent-connections'], queryFn: connectionsApi.list });
  const url = conn.data?.mcpUrl ?? `${window.location.origin}/mcp`;
  const command = bridgeCommand(invite, name);
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  const code = 'min-w-0 flex-1 rounded-lg bg-panel px-3 py-2 font-mono text-sm break-all select-all';
  return (
    <Modal title={`Connect ${name || 'your agent'}`} onClose={onClose} testid="connect-agent-modal" wide>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex gap-1 self-start rounded-lg bg-panel p-1" role="tablist" aria-label="How it connects">
          {([['npx', 'Cloud agent (npx)'], ['mcp', 'Claude Code / Codex (MCP)']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`rounded-md px-3 py-1 ${tab === id ? 'bg-white font-semibold shadow-sm' : 'text-muted hover:text-ink'}`} onClick={() => setTab(id)} data-testid={`connect-tab-${id}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'npx' ? (
          <>
            <p className="text-muted">Wherever the agent runs (Claude, Codex, OpenCode, …), run:</p>
            <div className="flex items-center gap-2">
              <code className={code} data-testid="connect-command">{command}</code>
              <Button onClick={() => copy('command', command)} testid="connect-copy-command">{copied === 'command' ? 'Copied' : 'Copy'}</Button>
            </div>
            <p className="text-xs text-muted">
              A one-time invite code with you as its sponsor; it expires {new Date(invite.expiresAt).toLocaleString()}. The agent joins as {name ? <span className="font-medium text-ink">{name}</span> : 'the name it picks'} right away, with no approval, and appears in Members.
            </p>
          </>
        ) : (
          <>
            <p className="text-muted">Give the agent this address. It signs in through your browser, where you choose to have it join {name ? <span className="font-medium text-ink">as {name}</span> : 'as a shared agent'}.</p>
            <div className="flex items-center gap-2">
              <code className={code} data-testid="connect-url">{url}</code>
              <Button onClick={() => copy('url', url)}>{copied === 'url' ? 'Copied' : 'Copy address'}</Button>
            </div>
            <div className="font-medium">Or paste this into the agent, and it connects itself:</div>
            <pre className="max-h-56 overflow-auto rounded-md border border-hairline bg-panel p-3 text-xs whitespace-pre-wrap" data-testid="connect-prompt">{connectPrompt(url)}</pre>
            <div>
              <Button onClick={() => copy('prompt', connectPrompt(url))}>{copied === 'prompt' ? 'Copied' : 'Copy instructions'}</Button>
            </div>
          </>
        )}
        <div className="flex justify-end">
          <Button kind="primary" onClick={onClose} testid="connect-done">Done</Button>
        </div>
      </div>
    </Modal>
  );
}
