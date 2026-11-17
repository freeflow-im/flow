// Step 4, the team (docs/specs/onboarding.md §1), for owners and admins: invite a person by email, add a hosted agent
// (its name, what it is for, and who may use it), or connect an agent that runs elsewhere over MCP, as Admin › Connect an
// agent does. Beside it, the workspace's members as they are now, people and agents on one list.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';
import { connectPrompt } from '@flow/shared/assistant';
import { suite } from '../suite';
import { setupApi } from './api';
import { ErrorText, input, lead, Mark, PrimaryButton, SecondaryButton, SideCard, StepHeading, TextButton, textarea } from './ui';

type Mode = 'hosted' | 'connect';

export function TeamStep({ org, stepOf, onDone, onBack }: { org: WorkspaceDTO; stepOf: string; onDone: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const members = useQuery({ queryKey: ['setup', 'members', org.id], queryFn: () => setupApi.members(org.id) });
  const invites = useQuery({ queryKey: ['setup', 'invites', org.id], queryFn: () => setupApi.invites(org.id) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['setup', 'members', org.id] }), qc.invalidateQueries({ queryKey: ['setup', 'invites', org.id] })]);

  return (
    <>
      <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
        <StepHeading stepOf={stepOf} title="Build your team">
          <p className={lead}>Add people and agents. Mention them in Chat, CC them in Mail, share files with them, invite them to meetings. Every agent gets its own address and calendar.</p>
        </StepHeading>
        <InviteCard org={org} onInvited={() => void refresh()} />
        <AgentCard org={org} onAdded={() => void refresh()} />
        <div className="flex flex-wrap items-center gap-5">
          <PrimaryButton onClick={onDone} testid="setup-team-continue">Continue</PrimaryButton>
          <TextButton onClick={onBack}>Back</TextButton>
        </div>
      </section>
      <Roster org={org} meId={me.data?.id ?? null} members={members.data ?? null} invited={(invites.data ?? []).map((i) => i.email)} />
    </>
  );
}

function Card({ icon, title, children, aside }: { icon: React.ReactNode; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex max-w-[640px] flex-col gap-4 rounded-2xl border border-hairline bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-selected-blue text-primary-deep">{icon}</span>
          <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

const personIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const agentIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M9 13h.01M15 13h.01" /></svg>;

function InviteCard({ org, onInvited }: { org: WorkspaceDTO; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const [r] = await setupApi.invite(org.id, address);
      setNote(r?.status === 'already_member' ? `${address} is already a member.` : r?.status === 'invalid_email' ? `${address} is not an email address.` : `Invitation sent to ${address}.`);
      if (r?.status !== 'invalid_email') setEmail('');
      onInvited();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card icon={personIcon} title="Invite a person">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="invite-email" className="text-sm font-semibold">Their email</label>
        <div className="flex flex-wrap gap-2">
          <input id="invite-email" type="email" className={`${input} min-w-0 flex-[1_1_240px]`} value={email} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} data-testid="setup-invite-email" />
          <PrimaryButton type="submit" disabled={busy || !email.trim()} testid="setup-invite-send">{busy ? 'Sending…' : 'Send invite'}</PrimaryButton>
        </div>
      </form>
      {note && <p role="status" className="m-0 text-sm text-ok">{note}</p>}
      <ErrorText error={error} />
      <p className="m-0 text-xs text-muted">They join {org.name} with their own Chief of Staff.</p>
    </Card>
  );
}

function AgentCard({ org, onAdded }: { org: WorkspaceDTO; onAdded: () => void }) {
  const [mode, setMode] = useState<Mode>('hosted');
  const tab = (m: Mode, label: string) => (
    <button type="button" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`setup-agent-${m}`}
      className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${mode === m ? 'bg-white text-ink shadow-sm' : 'bg-transparent text-muted'}`}>{label}</button>
  );
  return (
    <Card icon={agentIcon} title="Add an agent" aside={<div role="group" aria-label="Agent type" className="flex gap-1 rounded-[10px] bg-track p-1">{tab('hosted', 'Hosted')}{tab('connect', 'Connect Claude or ChatGPT')}</div>}>
      {mode === 'hosted' ? <HostedAgentForm org={org} onAdded={onAdded} /> : <ConnectAgent org={org} />}
    </Card>
  );
}

function HostedAgentForm({ org, onAdded }: { org: WorkspaceDTO; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'private'>('shared');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = [purpose.trim() && `What you are for: ${purpose.trim()}`, instructions.trim()].filter(Boolean).join('\n\n');
      await setupApi.addAgent(org.id, visibility, name.trim(), body);
      setAdded(name.trim());
      setName('');
      setPurpose('');
      setInstructions('');
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const choice = (v: 'shared' | 'private', label: string) => (
    <button type="button" aria-pressed={visibility === v} onClick={() => setVisibility(v)}
      className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${visibility === v ? 'bg-white text-ink shadow-sm' : 'bg-transparent text-muted'}`}>{label}</button>
  );
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ag-name" className="text-sm font-semibold">Name</label>
          <input id="ag-name" className={input} value={name} maxLength={80} placeholder="Scout" onChange={(e) => setName(e.target.value)} data-testid="setup-agent-name" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ag-purpose" className="text-sm font-semibold">Purpose</label>
          <input id="ag-purpose" className={input} value={purpose} maxLength={200} placeholder="Researches markets, competitors and people" onChange={(e) => setPurpose(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span id="vis-label" className="text-sm font-semibold">Who can use it</span>
        <div role="group" aria-labelledby="vis-label" className="flex gap-1 rounded-[10px] bg-track p-1">{choice('shared', 'Shared')}{choice('private', 'Private')}</div>
        <span className="text-xs text-muted">{visibility === 'shared' ? `Anyone in ${org.name} can ask it` : 'Only you can ask it'}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ag-instr" className="text-sm font-semibold">Instructions</label>
        <textarea id="ag-instr" rows={3} className={textarea} value={instructions} maxLength={7000} placeholder="Write findings up as docs and post a short summary in #growth. Always cite your sources." onChange={(e) => setInstructions(e.target.value)} />
      </div>
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <SecondaryButton onClick={() => void add()} disabled={busy || !name.trim()} testid="setup-agent-add">{busy ? 'Adding…' : `Add ${name.trim() || 'agent'} to the team`}</SecondaryButton>
        {added ? <span role="status" className="text-sm text-ok">{added} joined the team. You’re its sponsor.</span> : <span className="text-xs text-muted">You’re its sponsor.</span>}
      </div>
    </form>
  );
}

function ConnectAgent({ org }: { org: WorkspaceDTO }) {
  const url = useQuery({ queryKey: ['setup', 'mcp-url'], queryFn: setupApi.mcpUrl });
  const [copied, setCopied] = useState<'url' | 'prompt' | null>(null);
  const address = url.data ?? `${window.location.origin}/mcp`;
  const copy = async (what: 'url' | 'prompt') => {
    await navigator.clipboard?.writeText(what === 'url' ? address : connectPrompt(address)).catch(() => undefined);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1600);
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[15px] leading-relaxed text-ink-soft">Bring an agent you already use into {org.name}. Give Claude, ChatGPT or any MCP client this address; it signs in through your browser, where you choose whether it acts as you or joins as a shared agent.</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="mcp-url" className="text-sm font-semibold">MCP server address</label>
        <div className="flex flex-wrap gap-2">
          <input id="mcp-url" className={`${input} min-w-0 flex-[1_1_260px] font-mono text-sm`} value={address} readOnly data-testid="setup-mcp-url" />
          <SecondaryButton onClick={() => void copy('url')}>{copied === 'url' ? 'Copied' : 'Copy'}</SecondaryButton>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Or paste this into your agent, and it connects itself</span>
        <pre className="m-0 max-h-48 overflow-auto rounded-[10px] border border-hairline bg-panel p-3 text-xs whitespace-pre-wrap">{connectPrompt(address)}</pre>
        <div><SecondaryButton onClick={() => void copy('prompt')} testid="setup-copy-prompt">{copied === 'prompt' ? 'Copied' : 'Copy instructions'}</SecondaryButton></div>
      </div>
    </div>
  );
}

/** The workspace's members, people and agents on one list (the admin agent left out), and invitations not yet taken. */
function Roster({ org, meId, members, invited }: { org: WorkspaceDTO; meId: string | null; members: WorkspaceMemberDTO[] | null; invited: string[] }) {
  const shown = (members ?? []).filter((m) => m.agentRole !== 'admin' && m.kind !== 'guest');
  const nameOf = (id: string | null) => shown.find((m) => m.userId === id)?.displayName.split(' ')[0];
  const badge = (m: WorkspaceMemberDTO) => (m.isAgent ? (m.kind === 'personal_agent' ? 'Private agent' : 'Agent') : m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Person');
  const note = (m: WorkspaceMemberDTO) => {
    if (!m.isAgent) return m.title || m.address || m.email;
    const sponsor = nameOf(m.sponsorId);
    return m.kind === 'personal_agent' ? `${sponsor ?? 'Someone'}’s agent` : sponsor ? `Shared · sponsor ${sponsor}` : 'Shared';
  };
  return (
    <SideCard label={`${org.name} members`}>
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-lg font-semibold">{org.name}</h2>
        <span className="text-xs text-muted">{members ? `${shown.length} ${shown.length === 1 ? 'member' : 'members'}` : 'Loading…'}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="setup-roster">
        {shown.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 rounded-xl p-2">
            <Mark name={m.displayName} agent={m.isAgent} src={m.avatarUrl} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{m.displayName}{m.userId === meId && <span className="font-normal text-muted"> (you)</span>}</span>
              <span className="truncate text-xs text-muted">{note(m)}</span>
            </span>
            <span className="ml-auto flex-none rounded-md bg-track px-2 py-1 text-xs font-semibold text-ink-soft">{badge(m)}</span>
          </li>
        ))}
        {invited.map((email) => (
          <li key={email} className="flex items-center gap-3 rounded-xl p-2">
            <Mark name={email} />
            <span className="min-w-0 truncate font-semibold">{email}</span>
            <span className="ml-auto flex-none rounded-md bg-[#fef7e0] px-2 py-1 text-xs font-semibold text-warn">Invited</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs leading-relaxed text-muted">Working solo? You, your Chief of Staff and Omni are already a team.</p>
    </SideCard>
  );
}
