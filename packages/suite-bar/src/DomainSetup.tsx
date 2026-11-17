// One domain's card (docs/specs/workspace-admin.md §4): an organization's own domain is five steps to working mail, each
// saying what to publish in DNS and whether it is there; the platform subdomain needs none. Admin › Domains shows one per
// domain, and setup's Domain step the one just added (docs/specs/onboarding.md §1). Each app passes the calls (`api`), so
// this depends on no app; its look is Tailwind, the suite's tokens (each app's index.css reads this file with @source).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DnsRecordDTO, DomainDTO } from '@flow/shared';

/** The calls a domain card makes, each for this domain in the app's organization. */
export interface DomainApi {
  verify(domain: string): Promise<{ verified: boolean; found: string[] }>;
  turnOnMail(domain: string): Promise<unknown>;
  makePrimary(domain: string): Promise<unknown>;
  remove(domain: string): Promise<unknown>;
}

/** The server reuses a DNS check for a minute and looks again on `refresh` unless the last look is only seconds old
 * (directory/core.ts DOMAIN_STATUS_MIN_AGE): "Check again" rests that long rather than pretending to look. */
const RECHECK_REST_MS = 5_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the server said, in the admin's terms (workspace-admin.md §4.3). */
function explain(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'mail_provider_pending') return 'The mail provider cannot see its ownership record yet. DNS can take a while; try again in a few minutes.';
  if (code === 'dkim_pending') return 'The signing key is being made; try again in a minute.';
  return errorText(e);
}

/** An action the card runs: pending while it runs, its error, and a refresh of the domain after. */
function useAction<T>(fn: () => Promise<T>, done: (out: T) => Promise<unknown> | void, onError: (e: unknown) => void, onStart: () => void) {
  const [pending, setPending] = useState(false);
  return {
    isPending: pending,
    mutate: () => {
      onStart();
      setPending(true);
      void fn().then(done, onError).catch(onError).finally(() => setPending(false));
    },
  };
}

function Card({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-xl border border-hairline bg-white p-5" data-testid={testid}>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

const ErrorLine = ({ error, testid }: { error: string | null; testid?: string }) => (error ? <p className="text-xs text-danger" data-testid={testid ?? 'error'}>{error}</p> : null);

function Button({ children, onClick, disabled, kind = 'plain', testid }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'plain' | 'primary' | 'danger' | 'link'; testid?: string }) {
  const look =
    kind === 'primary' ? 'rounded-md bg-primary px-3 py-1 text-sm font-semibold text-white hover:bg-primary-deep'
    : kind === 'danger' ? 'rounded-md bg-danger px-3 py-1 text-sm font-semibold text-white hover:opacity-90'
    : kind === 'link' ? 'text-sm text-primary hover:underline'
    : 'rounded-md border border-border bg-white px-3 py-1 text-sm hover:bg-hover';
  return (
    <button type="button" className={`${look} disabled:opacity-50`} onClick={onClick} disabled={disabled} data-testid={testid}>
      {children}
    </button>
  );
}

function Confirm({ question, busy, onYes, onNo, testid }: { question: string; busy?: boolean; onYes(): void; onNo(): void; testid?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted" data-testid={testid}>
      <span>{question}</span>
      <Button kind="danger" disabled={busy} onClick={onYes} testid={testid ? `${testid}-yes` : undefined}>Yes</Button>
      <Button kind="link" disabled={busy} onClick={onNo}>No</Button>
    </span>
  );
}

type Status = 'present' | 'missing' | undefined;
const idOf = (domain: string) => domain.replace(/[^a-z0-9]+/gi, '-');

interface Step {
  n: number;
  title: string;
  done: boolean;
  records: { record: DnsRecordDTO; status: Status }[];
}

function stepsOf(d: DomainDTO): Step[] {
  const rows = d.records.map((record, i) => ({ record, status: d.status[i]?.record }));
  const of = (...purposes: DnsRecordDTO['purpose'][]) => rows.filter((r) => purposes.includes(r.record.purpose));
  const allPresent = (list: typeof rows) => list.length > 0 && list.every((r) => r.status === 'present');
  const mailRows = of('provider', 'mx', 'spf', 'dmarc');
  const dkimRows = of('dkim');
  return [
    { n: 1, title: 'Added', done: true, records: [] },
    { n: 2, title: 'Prove ownership', done: d.verified, records: of('verification') },
    { n: 3, title: 'Publish the mail records', done: allPresent(mailRows), records: mailRows },
    { n: 4, title: 'Turn on mail', done: d.atProvider, records: [] },
    { n: 5, title: 'Publish the signing record', done: dkimRows.length > 0 && allPresent(dkimRows), records: dkimRows },
  ];
}

const PURPOSE_LABELS: Record<DnsRecordDTO['purpose'], string> = {
  verification: 'Ownership (FreeFlow)',
  provider: 'Ownership (mail provider)',
  mx: 'Mail routing',
  spf: 'Sender policy',
  dmarc: 'DMARC',
  dkim: 'Signing (DKIM)',
};

export function DomainCard({ api, domain: d, hostedMail, onChanged, canRemove = true }: { api: DomainApi; domain: DomainDTO; hostedMail: boolean; onChanged(refresh?: boolean): Promise<unknown>; canRemove?: boolean }) {
  const id = idOf(d.domain);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'remove' | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [, tick] = useState(0);
  const resting = Date.now() - checkedAt < RECHECK_REST_MS;
  useEffect(() => {
    if (!resting) return;
    const t = setTimeout(() => tick((n) => n + 1), RECHECK_REST_MS - (Date.now() - checkedAt));
    return () => clearTimeout(t);
  }, [resting, checkedAt]);

  const act = <T,>(fn: () => Promise<T>, after?: (out: T) => void) =>
    useAction(fn, async (out) => {
      after?.(out);
      await onChanged();
    }, (e) => setError(explain(e)), () => {
      setError(null);
      setNote(null);
    });
  const verify = act(() => api.verify(d.domain), (r) => {
    if (!r.verified) setNote(r.found.length ? `Found ${r.found.join(', ')}, but not the token.` : 'The ownership record was not found yet. DNS can take a while.');
  });
  const turnOn = act(() => api.turnOnMail(d.domain));
  const makePrimary = act(() => api.makePrimary(d.domain));
  const remove = act(() => api.remove(d.domain), () => setConfirming(null));
  const recheck = useAction(() => onChanged(true), () => setCheckedAt(Date.now()), (e) => setError(explain(e)), () => setError(null));
  const busy = verify.isPending || turnOn.isPending || makePrimary.isPending || remove.isPending || recheck.isPending;

  const steps = useMemo(() => stepsOf(d), [d]);
  const current = steps.find((s) => !s.done)?.n ?? 6;
  const mailReady = d.kind === 'platform' ? d.atProvider : steps.every((s) => s.done);
  const providerTxt = steps[2]!.records.find((r) => r.record.purpose === 'provider');
  const canTurnOn = d.verified && (!providerTxt || providerTxt.status === 'present');
  const dkimMissing = d.atProvider && steps[4]!.records.length === 0;

  const badge = mailReady ? ['mail ready', 'text-ok'] : d.verified ? ['verified', 'text-ok'] : ['not verified', 'text-warn'];

  return (
    <Card title={d.domain} testid={`domain-${id}`}>
      <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-panel px-1.5 text-muted">{d.kind === 'platform' ? 'managed by FreeFlow' : 'your domain'}</span>
        <span className={`font-medium ${badge[1]}`} data-testid={`domain-status-${id}`}>
          {badge[0]}
        </span>
        {d.primary && (
          <span className="rounded bg-primary-tint px-1.5 font-semibold text-primary" data-testid={`domain-primary-${id}`}>
            primary
          </span>
        )}
        <span className="flex-1" />
        {d.verified && !d.primary && (
          <Button disabled={busy} onClick={() => makePrimary.mutate()} testid={`domain-make-primary-${id}`}>
            Make primary
          </Button>
        )}
        {canRemove && d.kind === 'own' && !d.primary && (confirming === 'remove' ? (
          <Confirm question={`Remove ${d.domain}?`} busy={busy} onYes={() => remove.mutate()} onNo={() => setConfirming(null)} testid={`domain-remove-confirm-${id}`} />
        ) : (
          <Button kind="link" disabled={busy} onClick={() => setConfirming('remove')} testid={`domain-remove-${id}`}>
            Remove
          </Button>
        ))}
      </div>
      {d.primary && <p className="text-xs text-muted">New members get their address here. Making another domain primary moves nobody's existing address.</p>}

      {d.kind === 'platform' ? (
        <PlatformBody d={d} hostedMail={hostedMail} busy={busy} onTurnOn={() => turnOn.mutate()} />
      ) : (
        <ol className="flex flex-col gap-3" data-testid={`domain-steps-${id}`}>
          {steps.map((s) => {
            const state = s.done ? 'done' : s.n === current ? 'current' : 'later';
            return (
              <li key={s.n} className={state === 'later' ? 'opacity-50' : ''} data-testid={`step-${s.n}-${id}`} data-state={state}>
                <div className="flex items-center gap-2 text-sm">
                  <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-ok text-white' : state === 'current' ? 'bg-primary text-white' : 'bg-panel text-muted'}`} aria-hidden>
                    {s.done ? '✓' : s.n}
                  </span>
                  <span className={state === 'current' ? 'font-semibold' : ''}>{s.title}</span>
                  {s.n === 1 && <span className="text-xs text-muted">{new Date(d.createdAt).toLocaleDateString()}</span>}
                </div>
                {state !== 'later' && (
                  <div className="mt-2 ml-7 flex flex-col gap-2">
                    {s.n === 2 && !s.done && (
                      <>
                        <p className="text-xs text-muted">Publish this record at your DNS host, then press Verify. Some hosts want the name without the domain (<code>_freeflow</code> alone).</p>
                        <Records rows={s.records} />
                        <div>
                          <Button kind="primary" disabled={busy} onClick={() => verify.mutate()} testid={`domain-verify-${id}`}>
                            Verify
                          </Button>
                        </div>
                      </>
                    )}
                    {s.n === 3 && (
                      <>
                        {!s.done && <p className="text-xs text-muted">Publish each record at your DNS host with the name and value shown. The mail provider's ownership record must be in DNS before mail can be turned on.</p>}
                        <Records rows={s.records} collapsed={s.done} />
                      </>
                    )}
                    {s.n === 4 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {!s.done ? (
                          <>
                            <Button kind="primary" disabled={busy || !canTurnOn} onClick={() => turnOn.mutate()} testid={`domain-turn-on-${id}`}>
                              {turnOn.isPending ? 'Turning on…' : 'Turn on mail for this domain'}
                            </Button>
                            {!canTurnOn && <span className="text-xs text-muted">{d.verified ? "Publish the mail provider's ownership record first." : 'Prove ownership first.'}</span>}
                          </>
                        ) : dkimMissing ? (
                          <>
                            <span className="text-xs text-muted">The domain is at the provider; its signing record has not come yet.</span>
                            <Button disabled={busy} onClick={() => turnOn.mutate()} testid={`domain-signing-${id}`}>
                              Get the signing record
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-muted">Mail is on at the provider.</span>
                        )}
                      </div>
                    )}
                    {s.n === 5 && (
                      <>
                        {!s.done && <p className="text-xs text-muted">The last record: with it, mail from this domain is signed and lands in inboxes.</p>}
                        <Records rows={s.records} collapsed={s.done} />
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {d.kind === 'own' && (
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          <Button kind="link" disabled={busy || resting} onClick={() => recheck.mutate()} testid={`domain-recheck-${id}`}>
            {resting ? 'Checked just now' : 'Check again'}
          </Button>
          {mailReady && <span className="text-xs text-ok">Everything is in place.</span>}
        </div>
      )}
      {note && <p className="text-xs text-muted" data-testid={`domain-note-${id}`}>{note}</p>}
      <ErrorLine error={error} testid={`domain-error-${id}`} />
    </Card>
  );
}

/** The platform subdomain (§4.4): FreeFlow publishes its records; mail is on once the domain is at the provider. */
function PlatformBody({ d, hostedMail, busy, onTurnOn }: { d: DomainDTO; hostedMail: boolean; busy: boolean; onTurnOn(): void }) {
  const rows = d.records.map((record) => ({ record, status: 'present' as Status }));
  return (
    <>
      <p className="text-xs text-muted">
        FreeFlow publishes this domain's records. {d.atProvider ? 'Mail is on.' : hostedMail ? 'Mail is on as soon as the first mailbox is set up, or now:' : ''}
      </p>
      {hostedMail && !d.atProvider && (
        <div>
          <Button kind="primary" disabled={busy} onClick={onTurnOn} testid={`domain-turn-on-${idOf(d.domain)}`}>
            Turn on mail
          </Button>
        </div>
      )}
      {rows.length > 0 && <Records rows={rows} collapsed published />}
    </>
  );
}

function Records({ rows, collapsed = false, published = false }: { rows: { record: DnsRecordDTO; status: Status }[]; collapsed?: boolean; published?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  useEffect(() => setOpen(!collapsed), [collapsed]);
  if (rows.length === 0) return null;
  if (!open) {
    return (
      <Button kind="link" onClick={() => setOpen(true)} testid="records-show">
        Show {rows.length} {rows.length === 1 ? 'record' : 'records'}
      </Button>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="domain-records">
        <thead>
          <tr className="text-left text-faint uppercase">
            <th className="py-1 pr-2 font-semibold">For</th>
            <th className="py-1 pr-2 font-semibold">Type</th>
            <th className="py-1 pr-2 font-semibold">Name</th>
            <th className="py-1 pr-2 font-semibold">Value</th>
            <th className="py-1 pr-2 font-semibold">In DNS</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ record: r, status }) => (
            <RecordRow key={`${r.type}-${r.name}-${r.value}`} record={r} status={published ? 'published' : status} />
          ))}
        </tbody>
      </table>
      {collapsed && (
        <Button kind="link" onClick={() => setOpen(false)}>
          Hide
        </Button>
      )}
    </div>
  );
}

function RecordRow({ record: r, status }: { record: DnsRecordDTO; status: Status | 'published' }) {
  const [copied, setCopied] = useState(false);
  const value = r.type === 'MX' ? `${r.priority} ${r.value}` : r.value;
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const shown = status === 'published' ? 'published' : status === 'present' ? '✓ present' : status === 'missing' ? 'missing' : '—';
  return (
    <tr data-testid="domain-record" className="border-t border-hairline align-top">
      <td className="py-1 pr-2 whitespace-nowrap text-muted">{PURPOSE_LABELS[r.purpose]}</td>
      <td className="py-1 pr-2 font-mono">{r.type}</td>
      <td className="py-1 pr-2 font-mono break-all">{r.name}</td>
      <td className="py-1 pr-2 font-mono break-all">{value}</td>
      <td data-testid="domain-record-status" className={`py-1 pr-2 whitespace-nowrap ${status === 'present' || status === 'published' ? 'text-ok' : status === 'missing' ? 'text-warn' : 'text-muted'}`}>
        {shown}
      </td>
      <td className="py-1 text-right">
        <Button kind="link" onClick={copy} testid="domain-record-copy">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </td>
    </tr>
  );
}
