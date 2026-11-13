// Making a hosted agent, and a person's own private agents (docs/specs/agents.md §1.3, §6). One form serves "Your agents"
// (every member: private by default) and Agents (owners and admins: shared by default). Private or shared is chosen here,
// once: an agent's kind never changes (decision_log 2026-11-12).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsableAgentDTO, WorkspaceDTO } from '@flow/shared';
import { tellHome } from '@flow/suite-bar';
import { assistantChanged } from '@flow/suite-bar/assistant-dock';
import { adminApi } from '../api';
import { Button, Card, Confirm, ErrorLine } from '../components/ui';
import { HostedDefinition } from './Agents';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Access = 'private' | 'shared';

/** After an agent is made or removed: every list that shows it, here and in the other apps. */
function useAgentsChanged(org: WorkspaceDTO) {
  const qc = useQueryClient();
  return () => {
    for (const key of ['my-agents', 'members', 'accounts', 'members-chat']) void qc.invalidateQueries({ queryKey: [key, org.id] });
    tellHome('members');
    assistantChanged();
  };
}

export function CreateAgent({ org, initialAccess }: { org: WorkspaceDTO; initialAccess: Access }) {
  const changed = useAgentsChanged(org);
  const mine = useQuery({ queryKey: ['my-agents', org.id], queryFn: () => adminApi.myAgents(org.id) });
  const [name, setName] = useState('');
  const [access, setAccess] = useState<Access>(initialAccess);
  const [instructions, setInstructions] = useState('');
  const count = mine.data?.agents?.length ?? 0;
  const limit = mine.data?.limit ?? 5;
  const full = access === 'private' && !!mine.data?.agents && count >= limit;
  const make = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
      return access === 'private' ? adminApi.makePersonalAgent(org.id, body) : adminApi.makeHostedAgent(org.id, body);
    },
    onSuccess: () => {
      setName('');
      setInstructions('');
      changed();
    },
  });
  const made = make.data?.agent;
  return (
    <Card
      title="Create an agent"
      intro="An agent the platform runs for you: no machine of your own. Give it a name and instructions, then talk to it from the assistant panel in any app, or message it in Chat."
      testid="card-create-agent"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !full) make.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" placeholder="For example, Scout" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} data-testid="create-agent-name" />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Who can use it</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="agent-access" checked={access === 'private'} onChange={() => setAccess('private')} data-testid="create-agent-private" />
            <span>
              <span className="font-medium">Private</span>
              <span className="block text-xs text-muted">Only you can ask it. It acts as you and sees what you see. {mine.data?.agents ? `You have ${count} of ${limit}, your assistant included.` : ''}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="agent-access" checked={access === 'shared'} onChange={() => setAccess('shared')} data-testid="create-agent-shared" />
            <span>
              <span className="font-medium">Shared</span>
              <span className="block text-xs text-muted">Anyone in {org.name} can ask it. It sees only what is shared with it, and keeps no secrets from the organization.</span>
            </span>
          </label>
          <p className="text-xs text-muted">You choose this once. To change it later, make a new agent.</p>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Instructions</span>
          <textarea className="rounded-md border border-hairline px-2 py-1 text-sm text-ink" rows={4} placeholder="What it is for, how it should answer, what to avoid." maxLength={8000} value={instructions} onChange={(e) => setInstructions(e.target.value)} data-testid="create-agent-instructions" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button kind="primary" type="submit" disabled={make.isPending || !name.trim() || full} testid="create-agent-make">
            {make.isPending ? 'Creating…' : 'Create agent'}
          </Button>
          {full && <span className="text-xs text-muted" data-testid="create-agent-full">You have {limit} private agents, the most one person may have. Remove one first.</span>}
        </div>
      </form>
      {made && (
        <p className="text-xs text-muted" data-testid="create-agent-made">
          {made.displayName} is ready. {made.mode === 'personal' ? 'Only you can ask it: pick it in the assistant panel, or message it in Chat.' : `Everyone in ${org.name} can ask it from the assistant panel.`}
        </p>
      )}
      <ErrorLine error={make.isError ? errorText(make.error) : null} />
    </Card>
  );
}

/** The person's own private agents (agents.md §1.3): their assistant, set up above, and the others, each with its instructions. */
export function MyAgents({ org }: { org: WorkspaceDTO }) {
  const changed = useAgentsChanged(org);
  const mine = useQuery({ queryKey: ['my-agents', org.id], queryFn: () => adminApi.myAgents(org.id) });
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (userId: string) => adminApi.removeMyAgent(org.id, userId),
    onSuccess: () => {
      setConfirming(null);
      changed();
    },
  });
  const agents = mine.data?.agents ?? [];
  return (
    <Card title="Your private agents" intro="Each one acts as you, sees what you see, and answers only you. Each has its own instructions and its own conversations." testid="card-my-agents">
      {mine.isError && <ErrorLine error={errorText(mine.error)} />}
      {agents.length > 0 && (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {agents.map((a: UsableAgentDTO) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`my-agent-${a.displayName}`}>
              <span className="font-medium">{a.displayName} 🤖</span>
              <span className="text-xs text-muted">{a.self ? 'your assistant · set up above' : 'private · only you'}</span>
              <span className="flex-1" />
              {!a.self && <HostedDefinition org={org} userId={a.id} name={a.displayName} />}
              {!a.self &&
                (confirming === a.id ? (
                  <Confirm question={`Remove ${a.displayName}? Its conversations go with it.`} busy={remove.isPending} onYes={() => remove.mutate(a.id)} onNo={() => setConfirming(null)} testid={`my-agent-remove-confirm-${a.displayName}`} />
                ) : (
                  <Button kind="link" disabled={remove.isPending} onClick={() => setConfirming(a.id)} testid={`my-agent-remove-${a.displayName}`}>
                    Remove
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={remove.isError ? errorText(remove.error) : null} />
    </Card>
  );
}
