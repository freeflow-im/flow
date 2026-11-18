// Step 3, Omni (docs/specs/onboarding.md §2): the workspace's shared agent, for owners and admins. It joins every public
// channel, now and as new ones are made, and sees what is shared with it; people decide what that is.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { suite } from '../suite';
import { setupApi } from './api';
import { ErrorText, lead, Mark, PrimaryButton, StepHeading, TextButton } from './ui';

const OMNI_TINT: [string, string] = ['#fef3c7', '#92400e'];

export function OmniStep({ org, stepOf, onDone, onBack }: { org: WorkspaceDTO; stepOf: string; onDone: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const existing = useQuery({ queryKey: ['setup', 'team-agent', org.id], queryFn: () => setupApi.teamAgent(org.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const firstName = (me.data?.displayName ?? '').split(' ')[0] || 'You';

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await setupApi.addTeamAgent(org.id);
      await qc.invalidateQueries({ queryKey: ['setup', 'team-agent', org.id] });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
        <StepHeading stepOf={stepOf} title="Add Omni, your team’s shared agent">
          <p className="m-0 text-[22px] font-semibold leading-snug text-[#92400e]">Omni is your company brain.</p>
          <p className={lead}>Your Chief of Staff works only for you. Omni works for everyone: it knows what your team shares with the whole workspace, and anyone can ask it, people and agents alike.</p>
        </StepHeading>

        <div className="grid max-w-[600px] grid-cols-1 gap-4 sm:grid-cols-2">
          <SeeList title="Omni can see" yes items={['Every public channel in Chat', 'Files shared with the whole team or with Omni', 'Calendars shared with Omni', 'Shared inboxes you give it']} />
          <SeeList title="Omni can’t see" items={['Direct messages', 'Private channels it isn’t in', 'Private files and folders', 'Anyone’s personal inbox']} />
        </div>

        <div className="flex max-w-[600px] items-center gap-3.5 rounded-xl border border-hairline bg-white p-4">
          <Mark name={me.data?.displayName ?? 'You'} src={me.data?.avatarUrl ?? null} />
          <span className="flex flex-col gap-1">
            <span className="font-semibold">Sponsor: {firstName} (you)</span>
            <span className="text-sm leading-snug text-muted">You’re accountable for Omni and decide what it’s allowed to do.</span>
          </span>
        </div>

        <ErrorText error={error} />
        {existing.data ? (
          <div className="flex flex-wrap items-center gap-5">
            <p className="m-0 text-[15px]"><b>{existing.data.displayName}</b> is already on your team.</p>
            <PrimaryButton onClick={onDone} testid="setup-omni-continue">Continue</PrimaryButton>
            <TextButton onClick={onBack}>Back</TextButton>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-5">
              <PrimaryButton onClick={() => void add()} disabled={busy || existing.isLoading} testid="setup-omni-add">
                <Mark name="Om" agent size={22} tint={OMNI_TINT} />
                {busy ? 'Adding Omni…' : `Add Omni to ${org.name}`}
              </PrimaryButton>
              <TextButton onClick={onDone} testid="setup-omni-skip">Not now</TextButton>
              <TextButton onClick={onBack}>Back</TextButton>
            </div>
            <p className="m-0 text-xs text-muted">You can add Omni later, from Admin › Agents.</p>
          </div>
        )}
      </section>

      <aside aria-label="Example of Omni answering in a channel" className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
        <div className="overflow-hidden rounded-2xl border border-hairline bg-white shadow-[0_12px_32px_rgba(16,24,40,0.08)]">
          <div className="flex items-center gap-2 border-b border-hairline px-4 py-3.5">
            <span className="font-semibold"># general</span>
            <span className="text-xs text-muted">· Chat · everyone</span>
            <span className="ml-auto rounded-md bg-track px-2 py-0.5 text-xs font-semibold text-ink-soft">Example</span>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex gap-3">
              <Mark name="Dev" size={32} tint={['#dcfce7', '#166534']} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-semibold">Dev</span>
                <span className="text-[15px] leading-relaxed">First day! <span className="font-medium text-primary-deep">@Omni</span> what’s our refund policy, and who signs off on big ones?</span>
              </span>
            </div>
            <div className="flex gap-3">
              <Mark name="Om" agent size={32} tint={OMNI_TINT} />
              <span className="flex min-w-0 flex-col gap-2">
                <span className="text-sm"><span className="font-semibold">Omni</span> <span className="text-xs text-muted">shared agent</span></span>
                <span className="text-[15px] leading-relaxed">Full refunds within 30 days. Anything over $500 goes to {firstName}.</span>
                <span className="inline-flex items-center gap-2 self-start rounded-lg border border-hairline px-2.5 py-1.5 text-xs text-ink-soft">Support playbook · shared file</span>
              </span>
            </div>
          </div>
        </div>
        <p className="m-0 text-xs leading-relaxed text-muted">Omni answers where everyone can see, and shows where each answer came from. The more your team shares, the more it knows.</p>
      </aside>
    </>
  );
}

function SeeList({ title, items, yes }: { title: string; items: string[]; yes?: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-hairline bg-white p-4">
      <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={yes ? '#188038' : '#d93025'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {yes ? <path d="M20 6 9 17l-5-5" /> : <path d="M18 6 6 18M6 6l12 12" />}
        </svg>
        {title}
      </h2>
      <ul className="m-0 flex flex-col gap-2 pl-[18px] text-sm leading-snug text-ink-soft">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </div>
  );
}
