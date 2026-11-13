// Your assistant (docs/specs/agents.md §1.1): every member's own section of Organization settings, not an admin's. The
// assistant's name (its first one gives it its address, mailbox and calendar), its standing instructions, who may mail it,
// and the model it runs on. It used to live in Docs' Settings; the suite keeps it here.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { AGENT_AVATAR_PRESETS, agentAvatarUrl, ANTHROPIC_MODELS, OPENAI_MODELS, OPENROUTER_MODELS, type AssistantProvider, type AssistantSettings, type AssistantSettingsUpdate } from '@flow/shared/assistant';
import { adminApi, assistantApi } from '../api';
import { suite } from '../suite';
import { tellHome } from '@flow/suite-bar';
import { assistantChanged } from '@flow/suite-bar/assistant-dock';
import { Button, Card, ErrorLine, Row } from '../components/ui';
import { CreateAgent, MyAgents } from './CreateAgent';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = 'w-72 rounded-md border border-border px-2 py-1 text-sm';

type KeyProvider = 'anthropic' | 'openai' | 'openrouter';
const PROVIDERS: { id: KeyProvider; name: string; placeholder: string; keysAt: string }[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-…', keysAt: 'console.anthropic.com' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…', keysAt: 'platform.openai.com' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…', keysAt: 'openrouter.ai/keys' },
];

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
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const def = useQuery({ queryKey: ['assistant', org.id, 'definition'], queryFn: () => assistantApi.definition(org.id) });
  // Its address, once named: the member list carries it (the assistant is a member, agents.md §1.1).
  const members = useQuery({ queryKey: ['members-chat', org.id], queryFn: () => adminApi.members(org.id) });
  const mine = (members.data ?? []).find((m) => m.kind === 'personal_agent' && m.agentRuntime === 'hosted' && m.sponsorId === me.data?.id);
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
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const members = useQuery({ queryKey: ['members-chat', org.id], queryFn: () => adminApi.members(org.id) });
  const mine = (members.data ?? []).find((m) => m.kind === 'personal_agent' && m.agentRuntime === 'hosted' && m.sponsorId === me.data?.id);
  const current = mine?.avatarUrl ?? null;
  const done = async () => {
    tellHome('members');
    assistantChanged();
    await qc.invalidateQueries({ queryKey: ['members-chat', org.id] });
  };
  const preset = useMutation({ mutationFn: (p: (typeof AGENT_AVATAR_PRESETS)[number] | null) => assistantApi.setPreset(org.id, p), onSuccess: done });
  const upload = useMutation({ mutationFn: (f: File) => assistantApi.uploadPicture(org.id, f), onSuccess: done });
  const busy = preset.isPending || upload.isPending;
  const tile = 'size-12 rounded-xl border-2 p-0.5';
  return (
    <Card title="Picture" intro="Shown on the AI button in every app and beside its messages in Chat. Pick one, or upload your own (PNG, JPEG, GIF or WebP, up to 5 MB)." testid="card-assistant-picture">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Picture">
          {AGENT_AVATAR_PRESETS.map((p) => {
            const url = agentAvatarUrl(p);
            const on = current === url;
            return (
              <button key={p} type="button" role="radio" aria-checked={on} aria-label={p} disabled={busy} onClick={() => preset.mutate(p)} className={`${tile} ${on ? 'border-primary' : 'border-transparent hover:border-hairline'}`} data-testid={`assistant-picture-${p}`}>
                <img src={url} alt="" className="size-full rounded-lg" />
              </button>
            );
          })}
          {current && !AGENT_AVATAR_PRESETS.some((p) => agentAvatarUrl(p) === current) && (
            <span className={`${tile} border-primary`} title="Your upload" data-testid="assistant-picture-upload-current">
              <img src={current} alt="" className="size-full rounded-lg object-cover" />
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-md border border-border px-3 py-1 text-sm hover:bg-hover">
            {upload.isPending ? 'Uploading…' : 'Upload a picture'}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} data-testid="assistant-picture-file" />
          </label>
          {current && (
            <Button kind="link" disabled={busy} onClick={() => preset.mutate(null)} testid="assistant-picture-none">No picture</Button>
          )}
        </div>
        <ErrorLine error={preset.isError ? errorText(preset.error) : upload.isError ? errorText(upload.error) : null} />
      </div>
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
  return (
    <Card
      title="Who may mail it"
      intro="Empty, your assistant reads no mail at all. Add the addresses it may take mail from, one per line (yours too, if you want to mail it); it then checks every ten minutes, and mail from anyone else goes to its Refused folder, unread."
      testid="card-assistant-allowlist"
    >
      {list.isError && <ErrorLine error={errorText(list.error)} />}
      {list.data && (
        <div className="flex flex-col gap-3">
          <textarea className={`${input} h-24 w-full`} value={text} placeholder="name@example.com" onChange={(e) => setText(e.target.value)} disabled={save.isPending} data-testid="assistant-allowlist" />
          <div>
            <Button disabled={save.isPending || text === saved} onClick={() => save.mutate()} testid="assistant-allowlist-save">
              {save.isPending ? 'Saving…' : 'Save senders'}
            </Button>
          </div>
          <ErrorLine error={save.isError ? errorText(save.error) : null} />
        </div>
      )}
    </Card>
  );
}

/** What it runs on: the organization's model, which its admins choose in Agents (operator ruling 2026-11-11). */
function RunsOn({ org }: { org: WorkspaceDTO }) {
  const settings = useQuery({ queryKey: ['assistant', org.id, 'settings'], queryFn: () => assistantApi.settings(org.id) });
  const s = settings.data;
  const label = !s ? null : s.provider === 'anthropic' ? `Anthropic · ${ANTHROPIC_MODELS.find((m) => m.id === s.anthropicModel)?.name ?? s.anthropicModel}` : s.provider === 'openai' ? `OpenAI · ${OPENAI_MODELS.find((m) => m.id === s.openaiModel)?.name ?? s.openaiModel}` : s.provider === 'openrouter' ? `OpenRouter · ${s.openrouterModel}` : 'The built-in model';
  return (
    <Card title="Model" intro="Every agent in this organization runs on the model its owners and admins choose, under Agents." testid="card-assistant-runs-on">
      {settings.isError && <ErrorLine error={errorText(settings.error)} />}
      {label && <p className="text-sm" data-testid="assistant-runs-on">{label}</p>}
    </Card>
  );
}

/** The organization's model (Agents section, owners and admins): what every agent runs on, people's assistants included. */
export function Model({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['assistant', org.id, 'settings'], queryFn: () => assistantApi.settings(org.id) });
  const s = settings.data;
  const [provider, setProvider] = useState<AssistantProvider>('default');
  const [models, setModels] = useState<Record<KeyProvider, string>>({ anthropic: '', openai: '', openrouter: '' });
  const [key, setKey] = useState('');
  const [braveKey, setBraveKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!s) return;
    setProvider(s.provider === 'default' && !s.builtIn ? 'anthropic' : s.provider);
    setModels({ anthropic: s.anthropicModel, openai: s.openaiModel, openrouter: s.openrouterModel });
    setKey('');
    setBraveKey('');
  }, [s]);
  const current = PROVIDERS.find((p) => p.id === provider);
  const savedKey = (p: KeyProvider, x: AssistantSettings) => ({ anthropic: x.anthropicKey, openai: x.openaiKey, openrouter: x.openrouterKey })[p];
  const update = (): AssistantSettingsUpdate => ({
    provider,
    anthropicModel: models.anthropic as AssistantSettingsUpdate['anthropicModel'],
    openaiModel: models.openai as AssistantSettingsUpdate['openaiModel'],
    openrouterModel: models.openrouter.trim(),
    ...(current && key.trim() ? { [`${current.id}Key`]: key.trim() } : {}),
    ...(braveKey.trim() ? { braveKey: braveKey.trim() } : {}),
  });
  const save = useMutation({
    mutationFn: (p: { body: AssistantSettingsUpdate; done: string }) => assistantApi.saveSettings(org.id, p.body).then(() => p.done),
    onMutate: () => setNotice(null),
    onSuccess: async (done) => {
      setNotice(done);
      await qc.invalidateQueries({ queryKey: ['assistant', org.id, 'settings'] });
    },
  });
  return (
    <Card title="Model for every agent" intro="What every agent in this organization runs on, each person's assistant included: the built-in model, or Anthropic, OpenAI or OpenRouter billed to the organization's API key. Keys are stored encrypted and never shown again." testid="card-assistant-model">
      {settings.isError && <ErrorLine error={errorText(settings.error)} />}
      {s && (
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ body: update(), done: 'Saved.' });
          }}
        >
          <Row label="Runs on">
            <select className={input} value={provider} onChange={(e) => setProvider(e.target.value as AssistantProvider)} data-testid="assistant-provider">
              {s.builtIn && <option value="default">Built-in model</option>}
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}, with my API key
                </option>
              ))}
            </select>
          </Row>
          {current && (
            <>
              <Row label={`${current.name.replace(/ \(.*\)/, '')} API key`} help={savedKey(current.id, s) ? undefined : `Get one at ${current.keysAt}.`}>
                <input type="password" autoComplete="new-password" className={input} value={key} placeholder={savedKey(current.id, s) ? `Saved (${savedKey(current.id, s)}); leave blank to keep` : current.placeholder} onChange={(e) => setKey(e.target.value)} data-testid="assistant-key" />
              </Row>
              <Row label="Model">
                {current.id === 'openrouter' ? (
                  <>
                    <input className={input} list="openrouter-models" value={models.openrouter} placeholder="author/model" spellCheck={false} onChange={(e) => setModels({ ...models, openrouter: e.target.value })} />
                    <datalist id="openrouter-models">
                      {OPENROUTER_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <select className={input} value={models[current.id]} onChange={(e) => setModels({ ...models, [current.id]: e.target.value })}>
                    {(current.id === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.hint}
                      </option>
                    ))}
                  </select>
                )}
              </Row>
            </>
          )}
          <Row label="Brave Search API key (optional)" help="For web and image search; without one it uses the model's own search.">
            <input type="password" autoComplete="new-password" className={input} value={braveKey} placeholder={s.braveKey ? `Saved (${s.braveKey}); leave blank to keep` : 'BSA…'} onChange={(e) => setBraveKey(e.target.value)} />
          </Row>
          <div className="flex flex-wrap items-center gap-3">
            <Button kind="primary" type="submit" disabled={save.isPending} testid="assistant-model-save">
              {save.isPending ? 'Checking…' : 'Save'}
            </Button>
            {current && savedKey(current.id, s) && (
              <Button kind="danger" disabled={save.isPending} onClick={() => save.mutate({ body: { ...update(), provider: s.provider === current.id ? 'default' : s.provider, [`${current.id}Key`]: null }, done: 'The key was removed.' })}>
                Remove saved key
              </Button>
            )}
            {notice && <span className="text-xs text-muted">{notice}</span>}
          </div>
          <ErrorLine error={save.isError ? errorText(save.error) : null} />
        </form>
      )}
    </Card>
  );
}
