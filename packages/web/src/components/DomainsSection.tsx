// The admin panel's Domains tab (platform.md §3.2, phase 5.1): the organization's platform subdomain and its own domains,
// the records an own domain needs in DNS with whether a lookup found each, and verify, make primary and remove.
// Owner/admin only; the Worker answers it (the Node server has no domains).
import { useCallback, useEffect, useState } from 'react';
import type { DnsRecordDTO, DomainDTO } from '@flow/shared';
import { useBoundApi } from '../lib/useBoundApi';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'failed');

export function DomainsSection({ workspaceId }: { workspaceId: string }) {
  const { api } = useBoundApi();
  const [domains, setDomains] = useState<DomainDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/domains`;

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await api<{ domains: DomainDTO[] }>('GET', refresh ? `${base}?refresh=1` : base);
      setDomains(r.domains);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, base]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const domain = draft.trim();
    if (!domain) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', base, { domain });
      setDraft('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="admin-domains" className="mb-6">
      <div className="mb-4 rounded-lg border border-hairline p-4">
        <h3 className="mb-1 text-sm font-bold">Domains</h3>
        <p className="mb-3 text-xs text-muted">
          New members get their address on the primary domain. Setting a primary does not change anyone's existing address.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            data-testid="domain-add-input"
            className="min-w-0 flex-1 rounded border border-hairline bg-base px-2 py-1 text-sm"
            placeholder="example.com"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            data-testid="domain-add"
            type="submit"
            className="rounded bg-accent px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy || !draft.trim()}
          >
            Add a domain
          </button>
        </form>
        {error && <p data-testid="domains-error" className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
      {domains === null ? (
        !error && <p className="text-sm text-muted">Loading…</p>
      ) : (
        <ul className="space-y-3">
          {domains.map((d) => (
            <DomainRow key={d.domain} domain={d} base={base} onChanged={load} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DomainRow({ domain: d, base, onChanged }: { domain: DomainDTO; base: string; onChanged: (refresh?: boolean) => Promise<void> }) {
  const { api } = useBoundApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const path = `${base}/${encodeURIComponent(d.domain)}`;
  const id = d.domain.replace(/[^a-z0-9]+/gi, '-');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = () => run(async () => {
    const r = await api<{ verified: boolean; found: string[] }>('POST', `${path}/verify`);
    setNote(r.verified ? null : r.found.length ? `Found ${r.found.join(', ')}, but not the token.` : 'The verification record was not found yet. DNS can take a while.');
    await onChanged();
  });
  const makePrimary = () => run(async () => {
    await api('PATCH', path, { primary: true });
    await onChanged();
  });
  const remove = () => run(async () => {
    setConfirming(false);
    await api('DELETE', path);
    await onChanged();
  });

  return (
    <li data-testid={`domain-${id}`} className="rounded-lg border border-hairline p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{d.domain}</span>
        <span className="rounded bg-daypill px-1.5 text-xs text-muted">{d.kind === 'platform' ? 'FreeFlow' : 'your domain'}</span>
        <span data-testid={`domain-verified-${id}`} className={`text-xs ${d.verified ? 'text-green-700' : 'text-amber-700'}`}>
          {d.verified ? 'verified' : 'not verified'}
        </span>
        {d.primary && <span data-testid={`domain-primary-${id}`} className="rounded bg-accent/15 px-1.5 text-xs font-semibold text-accent">primary</span>}
        <span className="flex-1" />
        {d.kind === 'own' && !d.verified && (
          <button data-testid={`domain-verify-${id}`} className="rounded border border-hairline px-2 py-0.5 text-xs hover:bg-daypill disabled:opacity-50" disabled={busy} onClick={() => void verify()}>
            Verify
          </button>
        )}
        {d.verified && !d.primary && (
          <button data-testid={`domain-make-primary-${id}`} className="rounded border border-hairline px-2 py-0.5 text-xs hover:bg-daypill disabled:opacity-50" disabled={busy} onClick={() => void makePrimary()}>
            Make primary
          </button>
        )}
        {d.kind === 'own' && !d.primary && (confirming ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">Remove {d.domain}?</span>
            <button data-testid={`domain-remove-confirm-${id}`} className="rounded bg-red-600 px-2 py-0.5 text-xs font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
            <button className="text-xs text-muted hover:underline" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        ) : (
          <button data-testid={`domain-remove-${id}`} className="text-xs text-red-600 hover:underline disabled:opacity-50" disabled={busy} onClick={() => setConfirming(true)}>
            Remove
          </button>
        ))}
      </div>
      {d.kind === 'own' && (
        <>
          <p className="mt-2 text-xs text-muted">Publish these records at your DNS host.</p>
          <div className="mt-2 overflow-x-auto">
            <table data-testid={`domain-records-${id}`} className="w-full text-xs">
              <thead>
                <tr className="text-left text-faint uppercase">
                  <th className="py-1 pr-2 font-semibold">Type</th>
                  <th className="py-1 pr-2 font-semibold">Name</th>
                  <th className="py-1 pr-2 font-semibold">Value</th>
                  <th className="py-1 pr-2 font-semibold">In DNS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.records.map((r, i) => (
                  <RecordRow key={`${r.type}-${r.name}-${r.value}`} record={r} status={d.status[i]?.record} />
                ))}
              </tbody>
            </table>
          </div>
          <button
            data-testid={`domain-recheck-${id}`}
            className="mt-2 text-xs text-accent hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(() => onChanged(true))}
          >
            Check again
          </button>
        </>
      )}
      {note && <p data-testid={`domain-note-${id}`} className="mt-2 text-xs text-muted">{note}</p>}
      {error && <p data-testid={`domain-error-${id}`} className="mt-2 text-xs text-red-600">{error}</p>}
    </li>
  );
}

function RecordRow({ record: r, status }: { record: DnsRecordDTO; status: 'present' | 'missing' | undefined }) {
  const [copied, setCopied] = useState(false);
  const value = r.type === 'MX' ? `${r.priority} ${r.value}` : r.value;
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <tr data-testid="domain-record" className="border-t border-hairline align-top">
      <td className="py-1 pr-2 font-mono">{r.type}</td>
      <td className="py-1 pr-2 font-mono break-all">{r.name}</td>
      <td className="py-1 pr-2 font-mono break-all">{value}</td>
      <td data-testid="domain-record-status" className={`py-1 pr-2 ${status === 'present' ? 'text-green-700' : 'text-amber-700'}`}>
        {status === 'present' ? '✓ present' : status === 'missing' ? 'missing' : '—'}
      </td>
      <td className="py-1 text-right">
        <button data-testid="domain-record-copy" className="rounded border border-hairline px-1.5 text-xs hover:bg-daypill" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </td>
    </tr>
  );
}
