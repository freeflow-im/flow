// Setup (docs/specs/onboarding.md §1): Home's own page at /home/setup, with no sidebar. A step bar, then one step at a
// time: the workspace, the person's assistant (their Chief of Staff), Omni, the team and automations. Each step moved
// to is saved, so a reload comes back to it; "Finish setup" ends it and opens Home (or Admin › Domains, after choosing a
// domain of one's own).
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminAddress } from '@flow/shared/addresses';
import { chooseOrganization, ORGANIZATIONS_KEY, useOrganizations } from '../hooks/organization';
import { setupApi } from './api';
import { nextStep, previousStep, STEPS, stepsFor, type StepNumber } from './lib';
import { WorkspaceStep } from './WorkspaceStep';
import { AssistantStep } from './AssistantStep';
import { OmniStep } from './OmniStep';
import { TeamStep } from './TeamStep';
import { AutomationsStep } from './AutomationsStep';
import { Logo } from './ui';

/** The step the address names (`?step=3`), if any. */
function stepInAddress(): StepNumber | null {
  const n = Number(new URLSearchParams(window.location.search).get('step'));
  return n >= 1 && n <= 5 ? (n as StepNumber) : null;
}

export function SetupPage() {
  const qc = useQueryClient();
  const organizations = useOrganizations();
  const org = organizations.active ?? null;
  const orgId = org?.id ?? null;
  const state = useQuery({ queryKey: ['setup', orgId], queryFn: () => setupApi.state(orgId!), enabled: !!orgId });
  const [step, setStep] = useState<StepNumber | null>(null);
  // The domain chosen at step 1, for the end of setup.
  const [ownDomain, setOwnDomain] = useState<string | null>(null);
  // Where setup stood when the page opened: step 5 makes the ready-made automations only the first time it is reached.
  const [reachedBefore, setReachedBefore] = useState<number | null>(null);

  const steps = stepsFor(org ? org.role ?? 'member' : null);

  // The step to open on: the address's, else the saved one, else the first this person has (1 with no workspace yet).
  useEffect(() => {
    if (step !== null || !organizations.ready) return;
    if (!org) return setStep(1);
    if (!state.data) return;
    setReachedBefore(state.data.step);
    const saved = (stepInAddress() ?? state.data.step) as StepNumber;
    const first = steps.find((s) => s !== 1)!;
    setStep(steps.includes(saved) && saved !== 1 ? saved : first);
  }, [step, organizations.ready, org, state.data, steps]);

  const go = (n: StepNumber, id = orgId) => {
    setStep(n);
    window.history.replaceState(null, '', `/home/setup?step=${n}`);
    window.scrollTo(0, 0);
    if (id) void setupApi.save(id, { step: n }).catch(() => undefined);
  };
  const forward = (from: StepNumber, id = orgId) => {
    const n = nextStep(steps, from);
    if (n) go(n, id);
    else void finish();
  };
  const back = (from: StepNumber) => {
    const n = previousStep(steps, from);
    if (n) go(n);
  };
  const finish = async () => {
    if (orgId) await setupApi.save(orgId, { done: true }).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['setup', orgId] });
    window.location.assign(ownDomain ? adminAddress('domains') : '/home/');
  };

  const created = async (id: string, domain: string | null) => {
    setOwnDomain(domain);
    chooseOrganization(id);
    await qc.invalidateQueries({ queryKey: ORGANIZATIONS_KEY });
    setReachedBefore(1);
    // An owner of a new workspace goes on to every step.
    go(2, id);
  };

  if (!organizations.ready || step === null) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Loading…</div>;
  }

  return (
    <div className="min-h-full bg-[#f6f7f9] text-ink" data-testid="setup-page">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline bg-white px-4 py-4 sm:px-10">
        <Logo />
        <ol aria-label="Setup steps" className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm">
          {STEPS.filter((s) => steps.includes(s.n)).map((s) => {
            const current = s.n === step;
            const done = s.n < step || (s.n === 1 && !!org);
            return (
              <li
                key={s.n}
                aria-current={current ? 'step' : undefined}
                className={`rounded-full px-3.5 py-2 ${current ? 'bg-selected-blue font-semibold text-primary-deep' : 'text-muted'}`}
                data-testid={`setup-step-${s.n}`}
              >
                {done ? '✓ ' : `${steps.indexOf(s.n) + 1} · `}
                {s.label}
              </li>
            );
          })}
        </ol>
      </header>
      <main className="mx-auto flex w-full max-w-[1200px] flex-wrap items-start gap-12 px-4 py-10 sm:px-10 sm:py-14">
        {step > 1 && !org && <p className="text-sm text-muted">Loading…</p>}
        {step === 1 && <WorkspaceStep stepOf={label(steps, 1)} onCreated={created} />}
        {step === 2 && org && <AssistantStep org={org} stepOf={label(steps, 2)} onDone={() => forward(2)} />}
        {step === 3 && org && <OmniStep org={org} stepOf={label(steps, 3)} onDone={() => forward(3)} onBack={() => back(3)} />}
        {step === 4 && org && <TeamStep org={org} stepOf={label(steps, 4)} onDone={() => forward(4)} onBack={() => back(4)} />}
        {step === 5 && org && (
          <AutomationsStep org={org} stepOf={label(steps, 5)} firstVisit={(reachedBefore ?? 5) < 5} onFinish={() => void finish()} onBack={previousStep(steps, 5) ? () => back(5) : null} />
        )}
      </main>
    </div>
  );
}

/** "Step 2 of 5", counting only the steps this person has. */
const label = (steps: StepNumber[], n: StepNumber) => `Step ${steps.indexOf(n) + 1} of ${steps.length}`;
