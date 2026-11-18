// Step 3, the person's own email and calendar (docs/specs/onboarding.md §1): the mail and calendars they already have,
// linked with the same forms as Mail's and Calendar's "Add an account" (the suite bar's LinkAccounts). Where people get no
// hosted mailbox (the free workspace address, decision_log 2026-11-15), a linked mailbox is the address coworkers see,
// so the person picks it here. "Set this up later" goes on; Mail and Calendar offer the same at any time.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { CalendarAccountForm, MailAccountForm, type CalendarLinkApi, type MailLinkApi } from '@flow/suite-bar/link-accounts';
import { suite } from '../suite';
import { setupApi, type LinkedAccount } from './api';
import { ErrorText, lead, PrimaryButton, SecondaryButton, StepHeading, TextButton } from './ui';

/** What Google's return says (`?connected=` or `?error=`), read once. */
function googleReturn(): { connected: boolean; error: string | null } {
  const q = new URLSearchParams(window.location.search);
  const out = { connected: q.has('connected'), error: q.get('error') };
  if (out.connected || out.error) window.history.replaceState(null, '', '/home/setup?step=3');
  return out;
}

const GOOGLE_ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  scope_denied: 'Google did not give FreeFlow access to your calendars. Try again and tick the calendar box.',
  google_disabled: 'Google Calendar is not set up on this server yet.',
  expired: 'That took too long. Try again.',
};

export function AccountsStep({ org, stepOf, onDone }: { org: WorkspaceDTO; stepOf: string; onDone: () => void }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const mail = useQuery({ queryKey: ['setup', 'mail', org.id], queryFn: () => setupApi.mailAccounts(org.id) });
  const calendars = useQuery({ queryKey: ['setup', 'calendars', org.id], queryFn: () => setupApi.calendarAccounts(org.id) });
  const account = useQuery({ queryKey: ['setup', 'account', org.id], queryFn: () => setupApi.myAccount(org.id) });
  const google = useQuery({ queryKey: ['setup', 'google'], queryFn: setupApi.googleAvailable, staleTime: Infinity });
  const [back] = useState(googleReturn);
  const [adding, setAdding] = useState<'mail' | 'calendar' | null>(null);
  const [error, setError] = useState<unknown>(back.error ? new Error(GOOGLE_ERRORS[back.error] ?? `Google said: ${back.error}`) : null);

  const name = me.data?.displayName ?? '';
  const hosted = account.data?.address ?? null;
  const goesBy = account.data?.linkedAddress ?? null;
  const linked = (mail.data?.length ?? 0) + (calendars.data?.length ?? 0) > 0;

  const mailApi: MailLinkApi<LinkedAccount> = {
    provider: (email) => setupApi.mailProvider(org.id, email),
    add: (body) => setupApi.addMailAccount(org.id, body),
  };
  const calendarApi: CalendarLinkApi<LinkedAccount> = {
    provider: (email) => setupApi.calendarProvider(org.id, email),
    add: (body) => setupApi.addCalendarAccount(org.id, body),
    connectGoogle: async (email) => window.location.assign(await setupApi.googleCalendarStart(org.id, email)),
  };
  const added = async (what: 'mail' | 'calendar', a: LinkedAccount) => {
    setAdding(null);
    await qc.invalidateQueries({ queryKey: ['setup', what === 'mail' ? 'mail' : 'calendars', org.id] });
    // The first mailbox a person with no hosted address links is the one coworkers see, until they pick another.
    if (what === 'mail' && !hosted && !goesBy) {
      await setupApi.setAddress(org.id, a.email.toLowerCase()).catch((err) => setError(err));
      await qc.invalidateQueries({ queryKey: ['setup', 'account', org.id] });
    }
  };
  const pick = async (address: string) => {
    setError(null);
    await setupApi.setAddress(org.id, address.toLowerCase()).catch((err) => setError(err));
    await qc.invalidateQueries({ queryKey: ['setup', 'account', org.id] });
  };

  return (
    <section className="flex min-w-0 flex-[1_1_100%] flex-col gap-6" data-testid="setup-accounts">
      <StepHeading stepOf={stepOf} title="Bring your email and calendar">
        <p className={lead}>
          Link the mail and calendars you already use: Gmail, iCloud, Outlook, Fastmail or any other. You read and send your mail here, see your day, and your Chief of Staff can help with both.
          {hosted ? ` Your ${org.name} address is ${hosted}.` : ` In ${org.name}, the mailbox you link is the address coworkers see.`}
        </p>
      </StepHeading>

      <div className="grid max-w-[980px] grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel
          title="Email"
          icon={<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>}
          accounts={mail.data ?? null}
          loading={mail.isLoading}
          empty="No email linked yet."
          adding={adding === 'mail'}
          onAdd={() => setAdding('mail')}
          addLabel="Link an email account"
          testid="setup-mail"
          rowNote={(a) =>
            hosted ? null : a.email.toLowerCase() === goesBy?.toLowerCase() ? (
              <span className="text-xs font-semibold text-ok">Coworkers see this address</span>
            ) : (
              <button type="button" className="text-xs font-medium text-primary-deep hover:underline" onClick={() => void pick(a.email)}>Use as my address</button>
            )
          }
        >
          <MailAccountForm api={mailApi} defaultName={name} onAdded={(a) => void added('mail', a)} onCancel={() => setAdding(null)} />
        </Panel>

        <Panel
          title="Calendar"
          icon={<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>}
          accounts={calendars.data ?? null}
          loading={calendars.isLoading}
          empty="No calendar linked yet."
          adding={adding === 'calendar'}
          onAdd={() => setAdding('calendar')}
          addLabel="Link a calendar"
          testid="setup-calendar"
          rowNote={(a) => (a.kind === 'google' ? <span className="text-xs text-muted">Google</span> : null)}
        >
          <CalendarAccountForm api={calendarApi} defaultName={name} googleAvailable={google.data ?? false} initialKind={google.data ? 'google' : 'icloud'}
            onAdded={(a) => void added('calendar', a)} onCancel={() => setAdding(null)} />
        </Panel>
      </div>

      {back.connected && <p role="status" className="m-0 text-sm text-ok">Your Google calendars are linked.</p>}
      <ErrorText error={error} />

      <div className="flex flex-wrap items-center gap-5">
        {linked ? (
          <PrimaryButton onClick={onDone} testid="setup-accounts-continue">Continue</PrimaryButton>
        ) : (
          <TextButton onClick={onDone} testid="setup-accounts-later">Set this up later</TextButton>
        )}
      </div>
    </section>
  );
}

function Panel({ title, icon, accounts, loading, empty, adding, onAdd, addLabel, rowNote, testid, children }: {
  title: string; icon: React.ReactNode; accounts: LinkedAccount[] | null; loading: boolean; empty: string; adding: boolean; onAdd: () => void; addLabel: string;
  rowNote: (a: LinkedAccount) => React.ReactNode; testid: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-hairline bg-white p-5" data-testid={testid}>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-selected-blue text-primary-deep">{icon}</span>
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
      </div>
      {loading ? (
        <p className="m-0 text-sm text-muted">Loading…</p>
      ) : accounts && accounts.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-panel px-3 py-2">
              <span aria-hidden="true" className="text-ok">✓</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.email}</span>
              {rowNote(a)}
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="m-0 text-sm text-muted">{empty}</p>
      )}
      {adding ? children : <div><SecondaryButton onClick={onAdd} testid={`${testid}-add`}>{accounts && accounts.length > 0 ? 'Link another' : addLabel}</SecondaryButton></div>}
    </div>
  );
}
