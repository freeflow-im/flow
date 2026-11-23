// A draft's sign-in to other services (docs/specs/user-apps.md §6.5): for each provider its manifest declares under
// "oauth", the client id and secret its author registered with that service, for the draft's preview. Without its own, a
// draft uses the installed app's when the provider is the same one. The secret is typed here and never shown again.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appsApi, type AppOAuthClient } from '../api';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const draftOAuthKey = (org: string, name: string) => ['draft-oauth', org, name];

/** The draft's providers, or none (no "oauth" in its manifest, or a manifest with problems). */
export function useDraftOAuth(org: string, name: string, updatedAt: string | undefined) {
  return useQuery({ queryKey: [...draftOAuthKey(org, name), updatedAt], queryFn: () => appsApi.draftOAuth(org, name), enabled: !!updatedAt, retry: false });
}

export function DraftOAuth({ org, name, updatedAt }: { org: string; name: string; updatedAt: string }) {
  const q = useDraftOAuth(org, name, updatedAt);
  const qc = useQueryClient();
  const providers = q.data?.providers ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-white p-4 text-sm" data-testid="draft-oauth">
      <p className="text-xs text-muted">
        People sign in to these services from your app. Register an OAuth app with each service, with this callback address, and enter its client id and secret here for your preview. FreeFlow keeps the secret: your app’s code, agents and this page never see it again. Never put a secret in the app’s files.
      </p>
      <code className="rounded-md bg-panel px-2 py-1 text-xs break-all select-all" data-testid="oauth-callback">{q.data?.callbackUrl}</code>
      {q.error && <p className="text-xs text-danger">{errorText(q.error)}</p>}
      {providers.map((p) => <Row key={p.provider} org={org} name={name} p={p} onSaved={() => void qc.invalidateQueries({ queryKey: draftOAuthKey(org, name) })} />)}
      <p className="text-xs text-muted">Once an owner or admin installs the app, they set its client in Admin › Apps for everyone.</p>
    </div>
  );
}

function Row({ org, name, p, onSaved }: { org: string; name: string; p: AppOAuthClient; onSaved(): void }) {
  const own = p.set && !p.inherited;
  const [editing, setEditing] = useState(!p.set);
  const [clientId, setClientId] = useState(own ? p.clientId ?? '' : '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => appsApi.setDraftOAuth(org, name, p.provider, clientId.trim(), secret.trim()),
    onMutate: () => setError(null),
    onSuccess: () => { setSecret(''); setEditing(false); onSaved(); },
    onError: (e) => setError(errorText(e)),
  });
  const clear = useMutation({ mutationFn: () => appsApi.clearDraftOAuth(org, name, p.provider), onSuccess: onSaved, onError: (e) => setError(errorText(e)) });
  const status = own ? `Set up (client ${p.clientId})` : p.inherited ? `Uses the installed app’s client (${p.clientId})` : 'Not set up: sign-in fails in the preview';
  return (
    <div className="flex flex-col gap-1.5 border-t border-hairline pt-3" data-testid={`draft-oauth-${p.provider}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-sm font-semibold">{p.label}</span>
        <span className={p.set ? 'text-ok' : 'text-muted'}>{status}</span>
      </div>
      {editing ? (
        <form className="flex flex-col gap-1.5 text-xs sm:flex-row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <input className="min-w-0 flex-1 rounded-md border border-border px-2 py-1" placeholder="Client id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" data-testid="oauth-client-id" />
          <input className="min-w-0 flex-1 rounded-md border border-border px-2 py-1" type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" data-testid="oauth-client-secret" />
          <button type="submit" className="rounded-md bg-primary px-3 py-1 font-semibold text-white disabled:opacity-50" disabled={!clientId.trim() || !secret.trim() || save.isPending} data-testid="oauth-save">{save.isPending ? 'Saving…' : 'Save'}</button>
          {p.set && <button type="button" className="text-primary hover:underline" onClick={() => setEditing(false)}>Cancel</button>}
        </form>
      ) : (
        <div className="flex gap-3 text-xs">
          <button type="button" className="rounded-md border border-border px-2 py-0.5 hover:bg-hover" onClick={() => setEditing(true)} data-testid="oauth-change">{own ? 'Change' : 'Use my own client'}</button>
          {own && <button type="button" className="text-primary hover:underline" onClick={() => clear.mutate()} data-testid="oauth-clear">Remove</button>}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
