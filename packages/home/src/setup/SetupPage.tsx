// Setup (docs/specs/onboarding.md §1): Home's own page at /home/setup, with no sidebar. A step bar, then one step at a
// time: the workspace, its own domain (when one was chosen), the person's own email and calendar, their assistant (their Chief of Staff), Omni, the team
// and automations. Each step moved to is saved, so a reload comes back to it; "Finish setup" ends it and opens Home.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chooseOrganization, ORGANIZATIONS_KEY, useOrganizations } from '../hooks/organization';
import { setupApi } from './api';
import { LAST_STEP, nextStep, previousStep, STEPS, stepsFor, type StepNumber } from './lib';
import { WorkspaceStep } from './WorkspaceStep';
import { DomainStep } from './DomainStep';
import { AccountsStep } from './AccountsStep';
import { AssistantStep } from './AssistantStep';
import { OmniStep } from './OmniStep';
import { TeamStep } from './TeamStep';
import { AutomationsStep } from './AutomationsStep';
import { Logo } from './ui';

/** The step the address names (`?step=3`), if any. */
function stepInAddress(): StepNumber | null {
  const n = Number(new URLSearchParams(window.location.search).get('step'));
  return n >= 1 && n <= LAST_STEP ? (n as StepNumber) : null;
}

export function SetupPage() {
  const qc = useQueryClient();
  const organizations = useOrganizations();
  const org = organizations.active ?? null;
  const orgId = org?.id ?? null;
  const state = useQuery({ queryKey: ['setup', orgId], queryFn: () => setupApi.state(orgId!), enabled: !!orgId });
  const [step, setStep] = useState<StepNumber | null>(null);
  // Where setup stood when the page opened: the last step makes the ready-made automations only the first time it is reached.
  const [reachedBefore, setReachedBefore] = useState<number | null>(null);

  // Step 1's domain when it could not be added, for the Domain step to say why and offer it again.
  const [domainProblem, setDomainProblem] = useState<{ domain: string; message: string } | null>(null);
  const admin = !!org && (org.role === 'owner' || org.role === 'admin');
  // An owner or admin with a domain of their own (chosen at step 1) has the Domain step; it stays until setup ends.
  const domains = useQuery({ queryKey: ['setup', 'domains', orgId], queryFn: () => setupApi.domains(orgId!), enabled: admin });
  const ownDomain = (domains.data ?? []).some((d) => d.kind === 'own');
  // (Also while step 1's domain could not be added, or the Domain step is open: it is still this person's step.)
  const steps = stepsFor(org ? org.role ?? 'member' : null, ownDomain || !!domainProblem || step === 2);

  // The step to open on: the address's, else the saved one, else the first this person has (1 with no workspace yet).
  useEffect(() => {
    if (step !== null || !organizations.ready) return;
    if (!org) return setStep(1);
    if (!state.data || (admin && !domains.isFetched)) return;
    setReachedBefore(state.data.step);
    const saved = (stepInAddress() ?? state.data.step) as StepNumber;
    const first = steps.find((s) => s !== 1)!;
    // The Domain step comes back on a reload even when no domain is added yet (step 1's could not be).
    setStep((steps.includes(saved) || (saved === 2 && admin)) && saved !== 1 ? saved : first);
  }, [step, organizations.ready, org, state.data, steps, admin, domains.isFetched]);

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
    window.location.assign('/home/');
  };

  const created = async (id: string, domain: string | null, problem: string | null) => {
    if (domain && problem) setDomainProblem({ domain, message: problem });
    chooseOrganization(id);
    await qc.invalidateQueries({ queryKey: ORGANIZATIONS_KEY });
    setReachedBefore(1);
    // An owner of a new workspace goes on to every step: its domain first when one was chosen.
    go(domain ? 2 : 3, id);
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
        {step === 2 && org && <DomainStep org={org} stepOf={label(steps, 2)} problem={domainProblem} onDone={() => forward(2)} />}
        {step === 3 && org && <AccountsStep org={org} stepOf={label(steps, 3)} onDone={() => forward(3)} />}
        {step === 4 && org && <AssistantStep org={org} stepOf={label(steps, 4)} onDone={() => forward(4)} />}
        {step === 5 && org && <OmniStep org={org} stepOf={label(steps, 5)} onDone={() => forward(5)} onBack={() => back(5)} />}
        {step === 6 && org && <TeamStep org={org} stepOf={label(steps, 6)} onDone={() => forward(6)} onBack={() => back(6)} />}
        {step === 7 && org && (
          <AutomationsStep org={org} stepOf={label(steps, 7)} firstVisit={(reachedBefore ?? LAST_STEP) < LAST_STEP} onFinish={() => void finish()} onBack={previousStep(steps, 7) ? () => back(7) : null} />
        )}
      </main>
    </div>
  );
}

/** "Step 2 of 5", counting only the steps this person has. */
const label = (steps: StepNumber[], n: StepNumber) => `Step ${Math.max(1, steps.indexOf(n) + 1)} of ${steps.length + (steps.includes(n) ? 0 : 1)}`;
