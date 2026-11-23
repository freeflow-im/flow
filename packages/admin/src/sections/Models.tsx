// The organization's models (task #26): a list of provider+model entries its owners and admins keep, one the default.
// Every agent runs on the default unless it is pinned to another entry (its definition's modelId); a pin to an entry that
// is removed, or whose provider's key is removed, falls back to the default. The keys are one per provider, sealed.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL, OPENAI_MODELS, OPENROUTER_MODELS, type ModelEntryProvider, type OrgModelsDTO } from '@flow/shared/assistant';
import { assistantApi } from '../api';
import { Button, Card, Confirm, ErrorLine, Row } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = 'w-72 rounded-md border border-border px-2 py-1 text-sm';

type KeyProvider = Exclude<ModelEntryProvider, 'default'>;
const PROVIDERS: { id: KeyProvider; name: string; placeholder: string; keysAt: string; first: string }[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-…', keysAt: 'console.anthropic.com', first: DEFAULT_ANTHROPIC_MODEL },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…', keysAt: 'platform.openai.com', first: DEFAULT_OPENAI_MODEL },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…', keysAt: 'openrouter.ai/keys', first: DEFAULT_OPENROUTER_MODEL },
];
const PROVIDER_SHORT: Record<KeyProvider | 'brave', string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', brave: 'Brave Search' };

/** The list, read by every member (to pin their own agents) and cached under one key. */
export function useOrgModels(org: WorkspaceDTO) {
  return useQuery({ queryKey: ['assistant', org.id, 'models'], queryFn: () => assistantApi.models(org.id) });
}

/** Owners and admins: the models, the default, adding one (with its provider's key) and the saved keys. */
export function Models({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const models = useOrgModels(org);
  const m = models.data;
  const [confirming, setConfirming] = useState<string | null>(null);
  const done = async (next?: OrgModelsDTO) => {
    setConfirming(null);
    if (next) qc.setQueryData(['assistant', org.id, 'models'], next);
    // What every agent runs on shows in Your assistant too.
    await qc.invalidateQueries({ queryKey: ['assistant', org.id] });
  };
  const change = useMutation({
    mutationFn: (p: { id: string; to: 'default' | 'remove' }) => (p.to === 'default' ? assistantApi.makeDefaultModel(org.id, p.id) : assistantApi.removeModel(org.id, p.id)),
    onSuccess: done,
  });
  const removeKey = useMutation({ mutationFn: (p: KeyProvider | 'brave') => assistantApi.removeKey(org.id, p), onSuccess: done });
  return (
    <Card
      title="Models"
      intro="The models this organization's agents can run on. Every agent runs on the default unless it is pinned to another model when it is made (or in its settings); if that model is removed, or its key is, the agent runs on the default instead. Keys are stored encrypted and never shown again."
      testid="card-models"
    >
      {models.isError && <ErrorLine error={errorText(models.error)} />}
      {m && (
        <div className="flex flex-col gap-4">
          {m.entries.length === 0 ? (
            <p className="text-sm text-muted" data-testid="models-empty">
              {m.builtIn ? 'No models yet: agents run on the built-in model.' : 'No models yet. Add one below so agents can run.'}
            </p>
          ) : (
            <ul className="divide-y divide-hairline rounded-lg border border-hairline" data-testid="models-list">
              {m.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid={`model-${e.label}`}>
                  <span className="font-medium">{e.label}</span>
                  {e.id === m.defaultId && <span className="rounded bg-panel px-1.5 py-0.5 text-xs font-medium" data-testid="model-default-badge">Default</span>}
                  {!e.ready && <span className="text-xs text-danger">no key saved: agents pinned to it run on the default</span>}
                  <span className="flex-1" />
                  {e.id !== m.defaultId && (
                    <Button kind="link" disabled={change.isPending} onClick={() => change.mutate({ id: e.id, to: 'default' })} testid={`model-make-default-${e.label}`}>
                      Make default
                    </Button>
                  )}
                  {confirming === e.id ? (
                    <Confirm question={`Remove ${e.label}? Agents pinned to it will run on the default.`} busy={change.isPending} onYes={() => change.mutate({ id: e.id, to: 'remove' })} onNo={() => setConfirming(null)} testid={`model-remove-confirm-${e.label}`} />
                  ) : (
                    <Button kind="link" disabled={change.isPending} onClick={() => setConfirming(e.id)} testid={`model-remove-${e.label}`}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ErrorLine error={change.isError ? errorText(change.error) : null} />
          <AddModel org={org} models={m} onDone={done} />
          <Keys models={m} busy={removeKey.isPending} onRemove={(p) => removeKey.mutate(p)} />
          <ErrorLine error={removeKey.isError ? errorText(removeKey.error) : null} />
          <BraveKey org={org} models={m} onDone={done} />
        </div>
      )}
    </Card>
  );
}

function AddModel({ org, models, onDone }: { org: WorkspaceDTO; models: OrgModelsDTO; onDone(next: OrgModelsDTO): Promise<void> }) {
  const [provider, setProvider] = useState<ModelEntryProvider>('anthropic');
  const [model, setModel] = useState<string>(DEFAULT_ANTHROPIC_MODEL);
  const [key, setKey] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = PROVIDERS.find((p) => p.id === provider);
  const saved = current ? models.keys[current.id] : null;
  const add = useMutation({
    mutationFn: () => assistantApi.addModel(org.id, { provider, ...(current ? { model: model.trim() } : {}), ...(key.trim() ? { key: key.trim() } : {}), ...(makeDefault ? { makeDefault } : {}) }),
    onMutate: () => setNotice(null),
    onSuccess: async (next) => {
      setKey('');
      setMakeDefault(false);
      setNotice('Added.');
      await onDone(next);
    },
  });
  const pick = (p: ModelEntryProvider) => {
    setProvider(p);
    setModel(PROVIDERS.find((x) => x.id === p)?.first ?? '');
    setKey('');
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-hairline p-3"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      data-testid="model-add"
    >
      <p className="text-sm font-medium">Add a model</p>
      <Row label="Provider">
        <select className={input} value={provider} onChange={(e) => pick(e.target.value as ModelEntryProvider)} data-testid="model-add-provider">
          {models.builtIn && <option value="default">Built-in model</option>}
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      {current && (
        <>
          <Row label="Model">
            {current.id === 'openrouter' ? (
              <>
                <input className={input} list="openrouter-models" value={model} placeholder="author/model" spellCheck={false} onChange={(e) => setModel(e.target.value)} data-testid="model-add-model" />
                <datalist id="openrouter-models">
                  {OPENROUTER_MODELS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </datalist>
              </>
            ) : (
              <select className={input} value={model} onChange={(e) => setModel(e.target.value)} data-testid="model-add-model">
                {(current.id === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} · {o.hint}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <Row label={`${PROVIDER_SHORT[current.id]} API key`} help={saved ? 'One key per provider: a new one replaces it for every model on it.' : `Get one at ${current.keysAt}.`}>
            <input type="password" autoComplete="new-password" className={input} value={key} placeholder={saved ? `Saved (${saved}); leave blank to keep` : current.placeholder} onChange={(e) => setKey(e.target.value)} data-testid="model-add-key" />
          </Row>
        </>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} data-testid="model-add-default" />
        Make it the default
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" type="submit" disabled={add.isPending || (!!current && !model.trim())} testid="model-add-save">
          {add.isPending ? 'Checking…' : 'Add model'}
        </Button>
        {notice && <span className="text-xs text-muted">{notice}</span>}
      </div>
      <ErrorLine error={add.isError ? errorText(add.error) : null} />
    </form>
  );
}

function Keys({ models, busy, onRemove }: { models: OrgModelsDTO; busy: boolean; onRemove(p: KeyProvider): void }) {
  const saved = PROVIDERS.filter((p) => models.keys[p.id]);
  if (!saved.length) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="model-keys">
      <span className="font-medium">Saved keys</span>
      {saved.map((p) => (
        <span key={p.id} className="flex items-center gap-3">
          <span>
            {PROVIDER_SHORT[p.id]} <span className="text-muted">{models.keys[p.id]}</span>
          </span>
          <Button kind="link" disabled={busy} onClick={() => onRemove(p.id)} testid={`model-key-remove-${p.id}`}>
            Remove
          </Button>
        </span>
      ))}
    </div>
  );
}

function BraveKey({ org, models, onDone }: { org: WorkspaceDTO; models: OrgModelsDTO; onDone(next?: OrgModelsDTO): Promise<void> }) {
  const [key, setKey] = useState('');
  const save = useMutation({ mutationFn: () => assistantApi.setBraveKey(org.id, key.trim()), onSuccess: async (next) => { setKey(''); await onDone(next); } });
  const remove = useMutation({ mutationFn: () => assistantApi.removeKey(org.id, 'brave'), onSuccess: (next) => onDone(next) });
  return (
    <form
      className="flex flex-col gap-2"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) save.mutate();
      }}
    >
      <Row label="Brave Search API key (optional)" help="For web and image search; without one agents use the model's own search.">
        <input type="password" autoComplete="new-password" className={input} value={key} placeholder={models.keys.brave ? `Saved (${models.keys.brave}); leave blank to keep` : 'BSA…'} onChange={(e) => setKey(e.target.value)} data-testid="model-brave-key" />
      </Row>
      <div className="flex gap-3">
        <Button type="submit" disabled={save.isPending || !key.trim()}>{save.isPending ? 'Checking…' : 'Save search key'}</Button>
        {models.keys.brave && (
          <Button kind="link" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Remove search key
          </Button>
        )}
      </div>
      <ErrorLine error={save.isError ? errorText(save.error) : remove.isError ? errorText(remove.error) : null} />
    </form>
  );
}

/**
 * Which of the organization's models an agent runs on: '' for the default (whatever it is at the time), or an entry's id.
 * A pin to an entry that is gone says so: the agent runs on the default until it is pinned again.
 */
export function ModelPicker({ org, value, onChange, disabled, testid }: { org: WorkspaceDTO; value: string; onChange(id: string): void; disabled?: boolean; testid?: string }) {
  const models = useOrgModels(org);
  const m = models.data;
  const def = m?.entries.find((e) => e.id === m.defaultId);
  const pinned = value ? m?.entries.find((e) => e.id === value) : undefined;
  const gone = !!value && !!m && !pinned;
  return (
    <span className="flex flex-col gap-1">
      <select className={input} value={gone ? '' : value} disabled={disabled || !m} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
        <option value="">Organization default{def ? ` (${def.label})` : m?.builtIn ? ' (the built-in model)' : ''}</option>
        {m?.entries.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
            {e.ready ? '' : ' (no key: uses the default)'}
          </option>
        ))}
      </select>
      {gone && <span className="text-xs text-muted" data-testid={testid ? `${testid}-gone` : undefined}>The model it was pinned to was removed, so it runs on the default.</span>}
      {pinned && !pinned.ready && <span className="text-xs text-muted">That model has no key saved, so it runs on the default for now.</span>}
    </span>
  );
}
