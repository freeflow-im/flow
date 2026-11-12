// Agents (docs/specs/workspace-admin.md §3.4, docs/specs/agents.md §2): the organization's shared agents with their sponsors,
// its members' personal agents (Claude Desktop on /mcp, say), removing either, and the one-time code that brings a new
// shared agent in (as Chat's "Invite your Agent"). Chat's Agents modal moved here.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDTO, WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';
import { adminApi } from '../api';
import { suite } from '../suite';
import { Button, Card, Confirm, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Agents({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const all = members.data ?? [];
  // Shared agents only: personal agents (each person's assistant among them) are listed below (agents.md §1).
  const agents = all.filter((m) => m.isAgent && m.kind !== 'personal_agent');
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id) });
  const hostedOf = (userId: string) => (accounts.data ?? []).find((a) => a.principalId === userId)?.agentRuntime === 'hosted';
  const nameOf = (userId: string | null) => all.find((m) => m.userId === userId)?.displayName ?? 'unknown';
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (userId: string) => adminApi.removeAgent(org.id, userId),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['members', org.id] });
      void qc.invalidateQueries({ queryKey: ['accounts', org.id] });
    },
    onError: (e) => setError(errorText(e)),
  });

  return (
    <>
      <MakeHostedAgent org={org} onMade={() => { void qc.invalidateQueries({ queryKey: ['members', org.id] }); void qc.invalidateQueries({ queryKey: ['accounts', org.id] }); }} />
      <InviteAgent org={org} />
      <Card title="Shared agents" intro="Shared agents are members with a 🤖 mark, each sponsored by the person who invited them; anyone in the organization can ask them, and they keep no secrets from it. A shared agent is always native: its mailbox and calendars are part of its work." testid="card-agents">
        {members.isError && <ErrorLine error={errorText(members.error)} />}
        {members.isSuccess && agents.length === 0 && <p className="text-sm text-muted" data-testid="agents-empty">No agents yet.</p>}
        {agents.length > 0 && (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {agents.map((a: WorkspaceMemberDTO) => (
              <li key={a.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`agent-${a.displayName}`}>
                <span className="font-medium">{a.displayName} 🤖</span>
                <span className="text-xs text-muted">sponsored by {nameOf(a.sponsorId)}{hostedOf(a.userId) ? ' · hosted here' : ''}</span>
                {a.statusText && <span className="truncate text-xs text-muted">{a.statusText}</span>}
                <span className="flex-1" />
                {hostedOf(a.userId) && <HostedDefinition org={org} userId={a.userId} name={a.displayName} />}
                {confirming === a.userId ? (
                  <Confirm question={`Remove ${a.displayName}? Its credentials are revoked; history stays.`} busy={remove.isPending} onYes={() => remove.mutate(a.userId)} onNo={() => setConfirming(null)} testid={`agent-remove-confirm-${a.displayName}`} />
                ) : (
                  <Button kind="link" disabled={remove.isPending} onClick={() => setConfirming(a.userId)} testid={`agent-remove-${a.displayName}`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorLine error={error} />
      </Card>
      <PersonalAgents org={org} nameOf={nameOf} />
    </>
  );
}

/**
 * The members' personal agents (agents.md §2): each acts as its sponsor and only the sponsor can use it, so there is
 * nothing to open here; an admin sees that it exists, whose it is, and may remove it, which ends its delegations.
 */
function PersonalAgents({ org, nameOf }: { org: WorkspaceDTO; nameOf: (userId: string | null) => string }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id) });
  const agents = (accounts.data ?? []).filter((a) => a.kind === 'personal_agent' && a.state !== 'removed');
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (accountId: string) => adminApi.removePersonalAgent(org.id, accountId),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['accounts', org.id] });
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Card title="Personal agents" intro="A personal agent acts as one person, with that person's access, and only they can use it. Each person's assistant is one: it gets its own address and mailbox when its person names it, and it goes only with them. Claude Desktop or Claude Code connected through FreeFlow's MCP endpoint is another: it has no address, and removing it ends its connection; the person can connect it again." testid="card-personal-agents">
      {accounts.isError && <ErrorLine error={errorText(accounts.error)} />}
      {accounts.isSuccess && agents.length === 0 && <p className="text-sm text-muted" data-testid="personal-agents-empty">No personal agents yet.</p>}
      {agents.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {agents.map((a: AccountDTO) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`personal-agent-${a.id}`}>
              <span className="font-medium">{a.displayName} 🤖</span>
              <span className="text-xs text-muted">
                {a.agentRuntime === 'hosted' ? 'assistant of ' : 'personal agent of '}
                {nameOf(a.sponsorId ?? null)}
                {a.address ? ` · ${a.address}` : ''}
              </span>
              <span className="flex-1" />
              {a.agentRuntime === 'hosted' ? (
                // A person's assistant is theirs to name (Docs Settings), and it comes and goes with them (agents.md §6).
                a.sponsorId === me.data?.id ? (
                  <a className="text-primary hover:underline" href="/docs/settings" data-testid={`personal-agent-rename-${a.id}`}>
                    Rename
                  </a>
                ) : null
              ) : confirming === a.id ? (
                <Confirm question={`Remove ${a.displayName}? Its connection stops working; ${nameOf(a.sponsorId ?? null)} can connect it again.`} busy={remove.isPending} onYes={() => remove.mutate(a.id)} onNo={() => setConfirming(null)} testid={`personal-agent-remove-confirm-${a.id}`} />
              ) : (
                <Button kind="link" disabled={remove.isPending} onClick={() => setConfirming(a.id)} testid={`personal-agent-remove-${a.id}`}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

/**
 * A hosted shared agent (docs/specs/agents.md §6): a member the platform runs, made here with a name and standing
 * instructions; everyone in the organization can ask it from the panel, and it keeps no secrets from them.
 */
function MakeHostedAgent({ org, onMade }: { org: WorkspaceDTO; onMade(): void }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const make = useMutation({
    mutationFn: () => adminApi.makeHostedAgent(org.id, { name: name.trim(), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) }),
    onSuccess: () => {
      setName('');
      setInstructions('');
      onMade();
    },
  });
  return (
    <Card title="Make a hosted agent" intro="A shared agent the platform runs for the organization: no machine of your own. Give it a name and standing instructions; anyone here can then talk to it from the assistant panel, share files with it, and mention it. It sees only what is shared with it, and keeps no secrets from the organization." testid="card-hosted-agent">
      <div className="flex flex-col gap-2">
        <input className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" placeholder="Its name, e.g. Omni" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} data-testid="hosted-agent-name" />
        <textarea className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" rows={3} placeholder="Instructions: what it is for, how it should answer, what to avoid." maxLength={8000} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="hosted-agent-instructions" />
        <div>
          <Button kind="primary" disabled={make.isPending || !name.trim()} onClick={() => make.mutate()} testid="hosted-agent-make">
            {make.isPending ? 'Making…' : 'Make the agent'}
          </Button>
        </div>
      </div>
      {make.data && <p className="text-xs text-muted" data-testid="hosted-agent-made">{make.data.agent.displayName} is here. Everyone in {org.name} can ask it from the panel.</p>}
      <ErrorLine error={make.isError ? errorText(make.error) : null} />
    </Card>
  );
}

/** A hosted shared agent's instructions, read and set in place (its sponsor, an owner or an admin). */
function HostedDefinition({ org, userId, name }: { org: WorkspaceDTO; userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const def = useQuery({ queryKey: ['agent-definition', org.id, userId], queryFn: () => adminApi.agentDefinition(org.id, userId), enabled: open });
  const save = useMutation({ mutationFn: (instructions: string) => adminApi.saveAgentDefinition(org.id, userId, { instructions }), onSuccess: () => { setOpen(false); setText(null); } });
  const current = text ?? def.data?.definition.instructions ?? '';
  if (!open) {
    return (
      <Button kind="link" onClick={() => setOpen(true)} testid={`agent-instructions-${name}`}>
        Instructions
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 pt-1" data-testid={`agent-instructions-editor-${name}`}>
      <textarea className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" rows={3} maxLength={8000} value={current} disabled={def.isLoading || !def.data?.mayEdit} onChange={(e) => setText(e.target.value)} data-testid={`agent-instructions-text-${name}`} />
      <div className="flex gap-2">
        <Button kind="primary" disabled={save.isPending || !def.data?.mayEdit || text === null} onClick={() => save.mutate(current)} testid={`agent-instructions-save-${name}`}>
          Save
        </Button>
        <Button kind="link" onClick={() => { setOpen(false); setText(null); }}>Close</Button>
      </div>
      <ErrorLine error={def.isError ? errorText(def.error) : save.isError ? errorText(save.error) : null} />
    </div>
  );
}

/** A one-time invite code tied to the caller as sponsor; the agent redeems it and joins at once (phase 15). */
function InviteAgent({ org }: { org: WorkspaceDTO }) {
  const [copied, setCopied] = useState(false);
  const mint = useMutation({ mutationFn: () => adminApi.agentInvite(org.id) });
  const command = mint.data?.command ?? '';
  const copy = () => {
    if (!command) return;
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Card title="Invite an agent" intro="Your coding agent (Claude, Codex, OpenCode, …) joins with a one-time code tied to you as its sponsor. Wherever it runs, run the command." testid="card-invite-agent">
      {command ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-panel px-3 py-2 font-mono text-sm break-all select-all" data-testid="agent-invite-command">
            {command}
          </code>
          <Button onClick={copy} testid="agent-invite-copy">
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button kind="link" disabled={mint.isPending} onClick={() => mint.mutate()}>
            New code
          </Button>
        </div>
      ) : (
        <div>
          <Button kind="primary" disabled={mint.isPending} onClick={() => mint.mutate()} testid="agent-invite">
            {mint.isPending ? 'Making a code…' : 'Get an invite code'}
          </Button>
        </div>
      )}
      {mint.data && <p className="text-xs text-muted">The code works once and expires {new Date(mint.data.expiresAt).toLocaleString()}. The agent picks its own name and handle.</p>}
      <ErrorLine error={mint.isError ? errorText(mint.error) : null} />
    </Card>
  );
}
