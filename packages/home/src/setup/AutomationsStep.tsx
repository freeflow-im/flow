// Step 5, automations (docs/specs/onboarding.md §3, §4). Two are made for the person the first time they reach this step,
// both waking their assistant: Daily Briefing and Meeting Prep, each with a switch (off removes it, on makes it again).
// Below, a new one written in plain language: WHEN, who does it, and THEN. "Create automation" asks the person's
// assistant to make it with its create_subscription tool; its answer is shown under the form, and the list refreshes.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubscriptionDTO, UsableAgentDTO, WorkspaceDTO } from '@flow/shared';
import { adminAddress } from '@flow/shared/addresses';
import { useSuiteAssistant } from '@flow/suite-bar/assistant-chat';
import { setupApi } from './api';
import { automationRequest, browserZone, IDEAS, READY_MADE, readyMadeBody, readyMadeOf, type ReadyMade } from './lib';
import { ErrorText, lead, PrimaryButton, StepHeading, TextButton, textarea } from './ui';

const NO_AGENT = 'none';

export function AutomationsStep({ org, stepOf, firstVisit, onFinish, onBack }: { org: WorkspaceDTO; stepOf: string; firstVisit: boolean; onFinish: () => void; onBack: (() => void) | null }) {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ['setup', 'agents', org.id], queryFn: () => setupApi.usableAgents(org.id) });
  const subsKey = ['setup', 'subscriptions', org.id];
  const subs = useQuery({ queryKey: subsKey, queryFn: () => setupApi.subscriptions(org.id) });
  const model = useQuery({ queryKey: ['setup', 'model', org.id], queryFn: () => setupApi.hasModel(org.id) });
  const assistant = agents.data?.find((a) => a.self) ?? null;
  const [error, setError] = useState<unknown>(null);
  const [seed, setSeed] = useState<Seed | null>(null);

  // The ready-made ones, made once: the first time the person reaches this step and has neither.
  const made = useRef(false);
  useEffect(() => {
    if (made.current || !firstVisit || !assistant || !subs.data) return;
    made.current = true;
    const have = new Set(subs.data.map(readyMadeOf));
    const missing = (['briefing', 'prep'] as ReadyMade[]).filter((w) => !have.has(w));
    if (!missing.length) return;
    void Promise.all(missing.map((w) => setupApi.createSubscription(org.id, readyMadeBody(w, assistant.accountId, browserZone()))))
      .catch((err) => setError(err))
      .finally(() => void qc.invalidateQueries({ queryKey: subsKey }));
  }, [firstVisit, assistant, subs.data, org.id, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (which: ReadyMade, sub: SubscriptionDTO | undefined) => {
    if (!assistant) return;
    setError(null);
    try {
      if (sub) await setupApi.removeSubscription(org.id, sub.id);
      else await setupApi.createSubscription(org.id, readyMadeBody(which, assistant.accountId, browserZone()));
    } catch (err) {
      setError(err);
    }
    await qc.invalidateQueries({ queryKey: subsKey });
  };

  const assistantName = assistant?.displayName ?? 'your assistant';
  const mine = subs.data ?? [];
  const others = mine.filter((s) => !readyMadeOf(s) && s.delivery !== 'pull');

  return (
    <>
      <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-7">
        <StepHeading stepOf={stepOf} title="Put work on autopilot">
          <p className={lead}>An automation is a trigger and an action, both written in plain language. When an email arrives, a chat message comes in, or it’s time, an agent does the work.</p>
        </StepHeading>

        <div className="flex max-w-[680px] flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-lg font-semibold">Already set up for you</h2>
            <span className="text-xs text-muted">{assistantName} starts with these two</span>
          </div>
          {(['briefing', 'prep'] as ReadyMade[]).map((which) => {
            const sub = mine.find((s) => readyMadeOf(s) === which);
            return <ReadyMadeCard key={which} which={which} agent={assistantName} on={!!sub} busy={!subs.data || !assistant} onToggle={() => void toggle(which, sub)} />;
          })}
          <ErrorText error={error} />
        </div>

        <CreateAutomation org={org} agents={agents.data ?? []} modelReady={model.data ?? null} seed={seed} onMade={() => void qc.invalidateQueries({ queryKey: subsKey })} />

        {others.length > 0 && (
          <div className="flex max-w-[680px] flex-col gap-2" data-testid="setup-automations-list">
            <h2 className="m-0 text-lg font-semibold">Your other automations</h2>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {others.map((s) => (
                <li key={s.id} className="rounded-xl border border-hairline bg-white px-4 py-3 text-sm">
                  <b>{s.name || 'Automation'}</b>
                  <span className="text-muted"> · {s.schedule ? `runs ${s.schedule.every.replace('@', ' at ')} (${s.schedule.timezone})` : `on ${(s.filter.types ?? ['any event']).join(', ')}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-5">
          <PrimaryButton onClick={onFinish} testid="setup-finish">Finish setup</PrimaryButton>
          {onBack && <TextButton onClick={onBack}>Back</TextButton>}
        </div>
      </section>

      <IdeasList onPick={(idea) => setSeed((s) => ({ idea, n: (s?.n ?? 0) + 1 }))} />
    </>
  );
}

function ReadyMadeCard({ which, agent, on, busy, onToggle }: { which: ReadyMade; agent: string; on: boolean; busy: boolean; onToggle: () => void }) {
  const r = READY_MADE[which];
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-hairline bg-white p-4" data-testid={`setup-ready-${which}`}>
      <div className="flex items-center gap-2.5">
        <h3 className="m-0 text-base font-semibold">{r.name}</h3>
        <span className="rounded-md bg-track px-2 py-0.5 text-xs font-semibold text-ink-soft">Private</span>
        <button type="button" role="switch" aria-checked={on} aria-label={`${r.name} on`} disabled={busy} onClick={onToggle} data-testid={`setup-ready-${which}-switch`}
          className={`ml-auto flex h-7 w-12 flex-none items-center rounded-full p-0.5 transition-colors disabled:opacity-50 ${on ? 'justify-end bg-primary' : 'justify-start bg-border'}`}>
          <span className="h-6 w-6 rounded-full bg-white shadow" />
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-2 text-[15px]">
        <span className="text-xs font-bold tracking-wide text-muted">WHEN</span>
        <span>{r.when}</span>
        <span className="text-xs font-bold tracking-wide text-muted">THEN</span>
        <span>{r.then(agent)}</span>
      </div>
    </article>
  );
}

/** A filled-in idea from the side list, handed to the form (`n` changes with each pick, so the same one picked twice fills it again). */
type Idea = { when: string; agent: string; then: string };
type Seed = { idea: Idea; n: number };

function CreateAutomation({ org, agents, modelReady, seed, onMade }: { org: WorkspaceDTO; agents: UsableAgentDTO[]; modelReady: boolean | null; seed: Seed | null; onMade: () => void }) {
  const assistant = agents.find((a) => a.self) ?? null;
  const chat = useSuiteAssistant(org.id, null);
  const [when, setWhen] = useState('');
  const [agentId, setAgentId] = useState<string>('');
  const [then, setThen] = useState('');
  const [asked, setAsked] = useState<number | null>(null);
  const wasRunning = useRef(false);
  const choices = agents.filter((a) => a.role !== 'admin');
  const chosen = agentId === NO_AGENT ? null : (choices.find((a) => a.id === agentId) ?? assistant);

  useEffect(() => {
    if (!seed) return;
    const { idea } = seed;
    setWhen(idea.when);
    setThen(idea.then);
    const byName = idea.agent === 'assistant' ? assistant : choices.find((a) => a.displayName === idea.agent);
    setAgentId(idea.agent === NO_AGENT ? NO_AGENT : (byName?.id ?? assistant?.id ?? ''));
    document.getElementById('au-when')?.focus();
  }, [seed?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // When the assistant's turn ends, the list is read again: it may have made one.
  useEffect(() => {
    if (wasRunning.current && !chat.running) onMade();
    wasRunning.current = chat.running;
  }, [chat.running, onMade]);

  const create = () => {
    if (!when.trim() || !then.trim() || chat.running) return;
    setAsked(chat.items.length);
    chat.send(automationRequest({ when, agent: chosen ? { name: chosen.self ? 'yourself' : chosen.displayName, accountId: chosen.accountId } : null, then, timezone: browserZone() }));
  };
  // The assistant's words since this form asked, the last of them its answer.
  const answer = asked === null ? null : chat.items.slice(asked).filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text).join('\n\n');

  return (
    <div className="flex max-w-[680px] flex-col gap-4 rounded-2xl border border-hairline bg-white p-5" data-testid="setup-create-automation">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-lg font-semibold">Create an automation</h2>
        <p className="m-0 text-sm text-muted">Write both parts the way you’d say them. There’s no fixed list of triggers: {assistant?.displayName ?? 'your assistant'} sets it up.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="au-when" className="text-xs font-bold tracking-wide text-muted">WHEN</label>
        <textarea id="au-when" rows={2} className={textarea} value={when} placeholder="Describe what should start it, in your own words" onChange={(e) => setWhen(e.target.value)} data-testid="setup-when" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">For example:</span>
          {['An email arrives from a customer asking about billing', 'Someone asks a question in #support nobody answers for 30 minutes', 'The first business day of every month'].map((ex) => (
            <button key={ex} type="button" onClick={() => setWhen(ex)} className="min-h-8 rounded-full border border-border bg-white px-3 text-ink-soft hover:bg-hover">{ex}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-bold tracking-wide text-muted">THEN</span>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="au-agent" className="text-sm font-semibold">Ask</label>
          <select id="au-agent" className="h-10 rounded-[10px] border border-border bg-white px-2 text-sm" value={chosen ? chosen.id : NO_AGENT} onChange={(e) => setAgentId(e.target.value)} data-testid="setup-then-agent">
            {assistant && <option value={assistant.id}>{assistant.displayName} (your Chief of Staff)</option>}
            {choices.filter((a) => !a.self).map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
            <option value={NO_AGENT}>No agent, just do it</option>
          </select>
        </div>
        <label htmlFor="au-then" className="sr-only">{chosen ? `Your request to ${chosen.displayName}` : 'What should happen'}</label>
        <textarea id="au-then" rows={2} className={textarea} value={then} onChange={(e) => setThen(e.target.value)} data-testid="setup-then"
          placeholder={chosen ? `Ask ${chosen.displayName} the way you would in Chat` : 'Describe a simple action, like forwarding or labeling'} />
        <span className="text-xs text-muted">{chosen ? `Write it as a normal request. ${chosen.displayName} runs it and tells you what it did.` : 'For simple steps like forwarding, labeling or adding a calendar hold.'}</span>
      </div>
      {modelReady === false ? (
        <p className="m-0 rounded-xl bg-warn-bg p-3 text-sm text-ink-soft" data-testid="setup-no-model">
          {assistant?.displayName ?? 'Your assistant'} needs a model before it can set up automations.{' '}
          {org.role === 'owner' || org.role === 'admin' ? <a href={adminAddress('agents')} className="font-medium text-primary-deep underline">Choose one in Admin › Agents</a> : 'Ask an admin of the workspace to choose one.'}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={create} disabled={!when.trim() || !then.trim() || chat.running} testid="setup-create">{chat.running ? 'Setting it up…' : 'Create automation'}</PrimaryButton>
        </div>
      )}
      {(answer || chat.error) && (
        <div className="rounded-xl bg-panel p-3 text-sm leading-relaxed" aria-live="polite" data-testid="setup-assistant-answer">
          {answer && <p className="m-0 whitespace-pre-wrap">{answer.replace(/\*\*(.+?)\*\*/g, '$1')}</p>}
          {chat.error && <p className="m-0 text-danger">{chat.error}</p>}
        </div>
      )}
    </div>
  );
}

function IdeasList({ onPick }: { onPick: (idea: Idea) => void }) {
  return (
    <aside aria-labelledby="ideas-h" className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
      <h2 id="ideas-h" className="m-0 text-lg font-semibold">Ideas to start from</h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {IDEAS.map((idea) => (
          <li key={idea.when} className="flex flex-col gap-2 rounded-2xl border border-hairline bg-white p-4 text-sm leading-relaxed">
            <span className="self-start rounded-md bg-track px-2 py-0.5 text-xs font-semibold text-ink-soft">{idea.tag}{idea.agent ? '' : ' · no agent'}</span>
            <span><b>When</b> {idea.when.charAt(0).toLowerCase() + idea.when.slice(1)}</span>
            <span>{idea.agent === 'Omni' ? <b className="text-primary-deep">@Omni </b> : idea.agent === 'assistant' ? <b className="text-primary-deep">@your Chief of Staff </b> : null}{idea.then}</span>
            <button type="button" className="self-start text-sm font-medium text-primary-deep hover:underline" onClick={() => onPick({ when: idea.when, agent: idea.agent ?? NO_AGENT, then: idea.then })}>Use this</button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
