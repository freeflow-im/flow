// Agents (docs/specs/workspace-admin.md §3.4): the organization's shared agents with their sponsors, removing one, and
// the one-time code that brings a new agent in (as Chat's "Invite your Agent"). Chat's Agents modal moved here.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO, WorkspaceMemberDTO } from '@flow/shared';
import { adminApi } from '../api';
import { Button, Card, Confirm, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Agents({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => adminApi.members(org.id) });
  const all = members.data ?? [];
  const agents = all.filter((m) => m.isAgent);
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
      <InviteAgent org={org} />
      <Card title="Agents in this organization" intro="Agents are members with a 🤖 mark, each sponsored by the person who invited them. An agent is always native: its mailbox and calendars are part of its work." testid="card-agents">
        {members.isError && <ErrorLine error={errorText(members.error)} />}
        {members.isSuccess && agents.length === 0 && <p className="text-sm text-muted" data-testid="agents-empty">No agents yet.</p>}
        {agents.length > 0 && (
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {agents.map((a: WorkspaceMemberDTO) => (
              <li key={a.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`agent-${a.displayName}`}>
                <span className="font-medium">{a.displayName} 🤖</span>
                <span className="text-xs text-muted">sponsored by {nameOf(a.sponsorId)}</span>
                {a.statusText && <span className="truncate text-xs text-muted">{a.statusText}</span>}
                <span className="flex-1" />
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
    </>
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
