// Domains & mail (docs/specs/workspace-admin.md §3.3 and §4): the Mail card, then one card per domain. An organization's
// own domain is five steps to working mail, each saying what to publish in DNS and whether it is there; the platform
// subdomain needs none. Every action saves at once and shows the server's words when it refuses.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDTO, DomainDTO, WorkspaceDTO } from '@flow/shared';
import { DomainCard, type DomainApi } from '@flow/suite-bar/domain-setup';
import { adminApi } from '../api';
import { Button, Card, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** `MAIL_RETENTION_DAYS` on the Worker; shown, not set (ruling 10). */
const RETENTION_DAYS = 30;

export function Domains({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const key = ['domains', org.id];
  const config = useQuery({ queryKey: ['config'], queryFn: adminApi.config, staleTime: Infinity });
  const domains = useQuery({ queryKey: key, queryFn: () => adminApi.domains(org.id) });
  const hostedMail = !!config.data?.hostedMail;
  const accounts = useQuery({ queryKey: ['accounts', org.id], queryFn: () => adminApi.accounts(org.id), enabled: hostedMail });
  const api: DomainApi = {
    verify: (domain) => adminApi.verifyDomain(org.id, domain),
    turnOnMail: (domain) => adminApi.turnOnMail(org.id, domain),
    makePrimary: (domain) => adminApi.makePrimary(org.id, domain),
    remove: (domain) => adminApi.removeDomain(org.id, domain),
  };
  const reload = (refresh = false) => (refresh ? qc.fetchQuery({ queryKey: key, queryFn: () => adminApi.domains(org.id, true), staleTime: 0 }) : qc.invalidateQueries({ queryKey: key }));

  return (
    <>
      <MailCard org={org} hostedMail={hostedMail} mail={config.data?.mail} domains={domains.data} accounts={accounts.data} onAdded={() => void reload()} />
      {domains.isError && <ErrorLine error={errorText(domains.error)} testid="domains-error" />}
      {domains.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {(domains.data ?? []).map((d) => (
        <DomainCard key={d.domain} api={api} domain={d} hostedMail={hostedMail} onChanged={reload} />
      ))}
    </>
  );
}

function MailCard({ org, hostedMail, mail, domains, accounts, onAdded }: { org: WorkspaceDTO; hostedMail: boolean; mail: { imapHost: string; smtpHost: string } | undefined; domains: DomainDTO[] | undefined; accounts: AccountDTO[] | undefined; onAdded(): void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (domain: string) => adminApi.addDomain(org.id, domain),
    onMutate: () => setError(null),
    onSuccess: () => {
      setDraft('');
      onAdded();
    },
    onError: (e) => setError(errorText(e)),
  });
  const primary = domains?.find((d) => d.primary)?.domain;
  const live = (accounts ?? []).filter((a) => a.state !== 'removed' && a.state !== 'suspended' && a.kind === 'native');
  const counts = {
    native: live.length,
    ready: live.filter((a) => a.state === 'active' && a.hosted).length,
    settingUp: live.filter((a) => a.state !== 'active' && !a.statusMessage).length,
    stopped: live.filter((a) => !!a.statusMessage).length,
  };
  return (
    <Card title="Mail" testid="card-mail">
      {hostedMail ? (
        <>
          <p className="text-sm" data-testid="mail-provider">
            Mailboxes are provided by FreeFlow{primary ? <> at <code className="rounded bg-panel px-1">{primary}</code></> : ''}.
            {mail && (
              <>
                {' '}
                A mail client connects with IMAP at <code className="rounded bg-panel px-1">{mail.imapHost}</code> and SMTP at <code className="rounded bg-panel px-1">{mail.smtpHost}</code>.
              </>
            )}
          </p>
          {accounts && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="mail-counts">
              <Count label="Native accounts" n={counts.native} />
              <Count label="Mailboxes ready" n={counts.ready} />
              <Count label="Being set up" n={counts.settingUp} />
              <Count label="Stopped" n={counts.stopped} warn />
            </dl>
          )}
          <p className="text-xs text-muted">A removed member's mailbox is kept for {RETENTION_DAYS} days, then deleted.</p>
        </>
      ) : (
        <p className="text-sm text-muted" data-testid="mail-off">
          Hosted mail is off on this server. Domains still give the organization its addresses.
        </p>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate(draft.trim());
        }}
      >
        <label className="text-sm font-medium" htmlFor="domain-add-input">
          Add a domain
        </label>
        <input id="domain-add-input" className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm" placeholder="example.com" value={draft} disabled={add.isPending} onChange={(e) => setDraft(e.target.value)} data-testid="domain-add-input" />
        <Button type="submit" kind="primary" disabled={add.isPending || !draft.trim()} testid="domain-add">
          Add
        </Button>
      </form>
      <ErrorLine error={error} testid="domain-add-error" />
    </Card>
  );
}

const Count = ({ label, n, warn }: { label: string; n: number; warn?: boolean }) => (
  <div>
    <dt className="text-xs text-muted">{label}</dt>
    <dd className={`text-lg font-semibold ${warn && n > 0 ? 'text-warn' : ''}`}>{n}</dd>
  </div>
);
