// Your assistant (docs/specs/agents.md §1.1): every member's own section of Organization settings, not an admin's. The
// assistant's name (its first one gives it its address, mailbox and calendar), its standing instructions, who may mail it,
// and the model it runs on. It used to live in Docs' Settings; the suite keeps it here.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { AGENT_AVATAR_PRESETS } from '@flow/shared/assistant';
import { adminApi, assistantApi } from '../api';
import { tellHome } from '@flow/suite-bar';
import { assistantChanged } from '@flow/suite-bar/assistant-dock';
import { Button, Card, ErrorLine, Row } from '../components/ui';
import { CreateAgent, MyAgents } from './CreateAgent';
import { PicturePicker } from './AgentPicture';
import { ModelPicker } from './Models';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = 'w-72 rounded-md border border-border px-2 py-1 text-sm';


export function Assistant({ org }: { org: WorkspaceDTO }) {
  return (
    <>
      <NameAndInstructions org={org} />
      <Picture org={org} />
      <WhoMayMail org={org} />
      <RunsOn org={org} />
      <MyAgents org={org} />
      <CreateAgent org={org} initialAccess="private" />
    </>
  );
}

function NameAndInstructions({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const def = useQuery({ queryKey: ['assistant', org.id, 'definition'], queryFn: () => assistantApi.definition(org.id) });
  // Its address, once named: the member list carries it (the assistant is a member, agents.md §1.1).
  const members = useQuery({ queryKey: ['members-chat', org.id], queryFn: () => adminApi.members(org.id) });
  const mineList = useQuery({ queryKey: ['my-agents', org.id], queryFn: () => adminApi.myAgents(org.id) });
  const selfId = mineList.data?.agents?.find((a) => a.self)?.id;
  const mine = (members.data ?? []).find((m) => m.userId === selfId);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (def.data) {
      setName(def.data.name);
      setInstructions(def.data.instructions);
    }
  }, [def.data]);
  const save = useMutation({
    mutationFn: () => assistantApi.saveDefinition(org.id, { name, instructions }),
    onMutate: () => setNotice(null),
    onSuccess: async () => {
      setNotice('Saved.');
      // Its name shows in Home's sidebar and Chat's lists, and on this page's AI button.
      tellHome('members');
      assistantChanged();
      await qc.invalidateQueries({ queryKey: ['assistant', org.id] });
      await qc.invalidateQueries({ queryKey: ['members-chat', org.id] });
    },
  });
  const dirty = !!def.data && (name !== def.data.name || instructions !== def.data.instructions);
  return (
    <Card
      title="Your assistant"
      intro="Your assistant is your personal agent in this organization: it acts as you, sees what you see, and answers only you. Message it in Chat (a DM, or mention it in any channel and it answers in the thread), or in the assistant panel. Its first name gives it its own address, mailbox and calendar."
      testid="card-assistant"
    >
      {def.isError && <ErrorLine error={errorText(def.error)} />}
      {def.data && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Row label="Name" help={mine?.address ? `Its address: ${mine.address}` : 'Naming it gives it its address, name@your domain.'}>
            <input className={input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={save.isPending} data-testid="assistant-name" />
          </Row>
          <Row label="Instructions" help="How it should work for you; they go into every conversation with it here.">
            <textarea className={`${input} h-28`} value={instructions} maxLength={8000} placeholder="What to focus on, how to write, what to avoid." onChange={(e) => setInstructions(e.target.value)} disabled={save.isPending} data-testid="assistant-instructions" />
          </Row>
          <div className="flex items-center gap-3">
            <Button kind="primary" type="submit" disabled={save.isPending || !dirty || !name.trim()} testid="assistant-save">
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {notice && <span className="text-xs text-muted">{notice}</span>}
          </div>
          <ErrorLine error={save.isError ? errorText(save.error) : null} />
        </form>
      )}
    </Card>
  );
}

/** Its picture (agents.md §1.1): one of the presets, an upload, or none (the spark). Shown on the AI button and in Chat. */
function Picture({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  // The assistant is the person's default agent (agents.md §1.3): the member row with its id, not just any of theirs.
  const mineList = useQuery({ queryKey: ['my-agents', org.id], queryFn: () => adminApi.myAgents(org.id) });
  const selfId = mineList.data?.agents?.find((a) => a.self)?.id;
  const members = useQuery({ queryKey: ['members-chat', org.id], queryFn: () => adminApi.members(org.id) });
  const mine = (members.data ?? []).find((m) => m.userId === selfId);
  const current = mine?.avatarUrl ?? null;
  const done = async () => {
    tellHome('members');
    assistantChanged();
    await qc.invalidateQueries({ queryKey: ['members-chat', org.id] });
    await qc.invalidateQueries({ queryKey: ['my-agents', org.id] });
  };
  const preset = useMutation({ mutationFn: (p: (typeof AGENT_AVATAR_PRESETS)[number] | null) => assistantApi.setPreset(org.id, p), onSuccess: done });
  const upload = useMutation({ mutationFn: (f: File) => assistantApi.uploadPicture(org.id, f), onSuccess: done });
  return (
    <Card title="Picture" intro="Shown on the AI button in every app and beside its messages in Chat. Pick one, or upload your own (PNG, JPEG, GIF or WebP, up to 5 MB)." testid="card-assistant-picture">
      <PicturePicker current={current} busy={preset.isPending || upload.isPending} onPreset={(p) => preset.mutate(p)} onFile={(f) => upload.mutate(f)} onNone={() => preset.mutate(null)} testid="assistant-picture" />
      <ErrorLine error={preset.isError ? errorText(preset.error) : upload.isError ? errorText(upload.error) : null} />
    </Card>
  );
}

function WhoMayMail({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['assistant', org.id, 'allowlist'], queryFn: () => assistantApi.allowlist(org.id) });
  const [text, setText] = useState('');
  useEffect(() => {
    if (list.data) setText(list.data.join('\n'));
  }, [list.data]);
  const save = useMutation({
    mutationFn: () => assistantApi.saveAllowlist(org.id, text.split(/[\s,;]+/).filter(Boolean)),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['assistant', org.id, 'allowlist'] }),
  });
  const saved = (list.data ?? []).join('\n');
  const own = useQuery({ queryKey: ['assistant', org.id, 'ownAddresses'], queryFn: () => assistantApi.ownAddresses(org.id) });
  const auto = useQuery({ queryKey: ['assistant', org.id, 'autoReply'], queryFn: () => assistantApi.autoReply(org.id) });
  const setAuto = useMutation({
    mutationFn: (on: boolean) => assistantApi.saveAutoReply(org.id, on),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['assistant', org.id, 'autoReply'] }),
  });
  return (
    <Card
      title="Who may mail it"
      intro="Your assistant takes mail from your own addresses, and from the ones you add here, one per line. It checks every ten minutes; mail from anyone else goes to its Refused folder, unread. Mail it takes waits in its inbox until you ask about it, unless it always responds. Invitations it takes go on its calendar."
      testid="card-assistant-allowlist"
    >
      {list.isError && <ErrorLine error={errorText(list.error)} />}
      {list.data && (
        <div className="flex flex-col gap-3">
          {!!own.data?.length && (
            <p className="text-sm text-muted" data-testid="assistant-own-addresses">
              Always allowed, as yours: {own.data.join(', ')}
            </p>
          )}
          <textarea className={`${input} h-24 w-full`} value={text} placeholder="name@example.com" onChange={(e) => setText(e.target.value)} disabled={save.isPending} data-testid="assistant-allowlist" />
          <div>
            <Button disabled={save.isPending || text === saved} onClick={() => save.mutate()} testid="assistant-allowlist-save">
              {save.isPending ? 'Saving…' : 'Save senders'}
            </Button>
          </div>
          <ErrorLine error={save.isError ? errorText(save.error) : null} />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={auto.data === true}
              disabled={!auto.isSuccess || setAuto.isPending}
              onChange={(e) => setAuto.mutate(e.target.checked)}
              data-testid="assistant-autoreply"
            />
            <span>
              <span className="font-medium">Agent always responds to incoming email</span>
              <span className="block text-xs text-muted">Each message from a sender above starts its turn, and it answers by email from its own address. Off, it only reads that mail when you ask, or when an automation wakes it.</span>
            </span>
          </label>
          <ErrorLine error={setAuto.isError ? errorText(setAuto.error) : null} />
        </div>
      )}
    </Card>
  );
}

/**
 * What it runs on: the organization's default, or one of its models it is pinned to (task #26). Owners and admins keep
 * the list under Agents; a pin to a model that is removed falls back to the default.
 */
function RunsOn({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const def = useQuery({ queryKey: ['assistant', org.id, 'definition'], queryFn: () => assistantApi.definition(org.id) });
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (modelId: string) => assistantApi.saveDefinition(org.id, { modelId: modelId || null }),
    onMutate: () => setNotice(null),
    onSuccess: async () => {
      setNotice('Saved.');
      await qc.invalidateQueries({ queryKey: ['assistant', org.id, 'definition'] });
    },
  });
  return (
    <Card title="Model" intro="The model your assistant runs on: the organization's default, or another of the models its owners and admins set up under Agents." testid="card-assistant-runs-on">
      {def.isError && <ErrorLine error={errorText(def.error)} />}
      {def.data && (
        <div className="flex items-center gap-3">
          <ModelPicker org={org} value={def.data.modelId ?? ''} disabled={save.isPending} onChange={(id) => save.mutate(id)} testid="assistant-runs-on" />
          {notice && <span className="text-xs text-muted">{notice}</span>}
        </div>
      )}
      <ErrorLine error={save.isError ? errorText(save.error) : null} />
    </Card>
  );
}
