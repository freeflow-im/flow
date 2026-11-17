// Step 2, the workspace's own domain (docs/specs/onboarding.md §1), shown only when one was chosen at step 1: the same
// card Admin › Domains shows (the suite bar's DomainCard), from proving ownership to signed mail. DNS can take a while, so
// "Set this up later" goes on; the card stays in Admin › Domains, where it picks up where it was left.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { DomainCard, type DomainApi } from '@flow/suite-bar/domain-setup';
import { setupApi } from './api';
import { cleanDomain } from './lib';
import { ErrorText, input, lead, PrimaryButton, SecondaryButton, StepHeading, TextButton } from './ui';

export function DomainStep({ org, stepOf, onDone }: { org: WorkspaceDTO; stepOf: string; onDone: () => void }) {
  const qc = useQueryClient();
  const key = ['setup', 'domains', org.id];
  const domains = useQuery({ queryKey: key, queryFn: () => setupApi.domains(org.id) });
  const own = (domains.data ?? []).filter((d) => d.kind === 'own');
  const reload = (refresh = false) =>
    refresh ? qc.fetchQuery({ queryKey: key, queryFn: () => setupApi.domains(org.id, true), staleTime: 0 }) : qc.invalidateQueries({ queryKey: key });
  const api: DomainApi = {
    verify: (domain) => setupApi.verifyDomain(org.id, domain),
    turnOnMail: (domain) => setupApi.turnOnMail(org.id, domain),
    makePrimary: (domain) => setupApi.makePrimary(org.id, domain),
    remove: (domain) => setupApi.removeDomain(org.id, domain),
  };
  const ready = own.length > 0 && own.every((d) => d.verified && d.atProvider);
  const title = own.length === 1 ? `Connect ${own[0]!.domain}` : 'Connect your domain';

  return (
    <section className="flex min-w-0 flex-[1_1_100%] flex-col gap-6">
      <StepHeading stepOf={stepOf} title={title}>
        <p className={lead}>
          Publish a few records at your DNS host (where you bought the domain) to prove it is yours and to turn on mail. Then everyone in {org.name}, people and agents, gets an address on it. DNS can take a while: you can set this up later in Admin › Domains.
        </p>
      </StepHeading>

      <div className="flex max-w-[820px] flex-col gap-4" data-testid="setup-domain">
        {domains.isLoading && <p className="m-0 text-sm text-muted">Loading…</p>}
        <ErrorText error={domains.error} />
        {own.map((d) => <DomainCard key={d.domain} api={api} domain={d} hostedMail onChanged={reload} canRemove={false} />)}
        {domains.isSuccess && own.length === 0 && <AddDomain org={org} onAdded={() => void reload()} />}
      </div>

      <div className="flex flex-wrap items-center gap-5">
        {ready ? (
          <PrimaryButton onClick={onDone} testid="setup-domain-continue">Continue</PrimaryButton>
        ) : (
          <TextButton onClick={onDone} testid="setup-domain-later">Set this up later</TextButton>
        )}
      </div>
    </section>
  );
}

/** When step 1's domain could not be added (or was removed), it can be added here. */
function AddDomain({ org, onAdded }: { org: WorkspaceDTO; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const domain = cleanDomain(text);
  const add = async () => {
    if (!domain || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setupApi.addDomain(org.id, domain);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-2 rounded-xl border border-hairline bg-white p-5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <label htmlFor="setup-domain-input" className="text-sm font-semibold">Your domain</label>
      <div className="flex flex-wrap gap-2">
        <input id="setup-domain-input" className={`${input} min-w-0 flex-[1_1_240px]`} value={text} placeholder="yourcompany.com" onChange={(e) => setText(e.target.value)} />
        <SecondaryButton onClick={() => void add()} disabled={!domain || busy}>{busy ? 'Adding…' : 'Add domain'}</SecondaryButton>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
