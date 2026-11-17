// Setup's plain parts (docs/specs/onboarding.md): which steps a person sees, the workspace address, the two ready-made
// automations, and the request a written automation becomes for the person's assistant.
import type { MemberRole, SubscriptionDTO } from '@flow/shared';

export const STEPS = [
  { n: 1, label: 'Workspace' },
  { n: 2, label: 'Domain' },
  { n: 3, label: 'Chief of Staff' },
  { n: 4, label: 'Omni' },
  { n: 5, label: 'Team' },
  { n: 6, label: 'Automations' },
] as const;
export type StepNumber = (typeof STEPS)[number]['n'];
/** The last step, where the ready-made automations are made the first time it is reached. */
export const LAST_STEP: StepNumber = 6;

/**
 * The steps a person goes through (§1): an owner or admin all of them, the Domain step only when the workspace has a
 * domain of its own to set up; everyone else their assistant and automations.
 */
export function stepsFor(role: MemberRole | string | null, ownDomain = false): StepNumber[] {
  const admin = role === 'owner' || role === 'admin' || role === null;
  if (!admin) return [3, 6];
  return ownDomain ? [1, 2, 3, 4, 5, 6] : [1, 3, 4, 5, 6];
}

/** The step after `n` among `steps`, or null after the last. */
export function nextStep(steps: StepNumber[], n: StepNumber): StepNumber | null {
  return steps.find((s) => s > n) ?? null;
}

/** The step before `n` that can still be visited (never step 1 once the workspace exists). */
export function previousStep(steps: StepNumber[], n: StepNumber): StepNumber | null {
  const earlier = steps.filter((s) => s < n && s !== 1);
  return earlier[earlier.length - 1] ?? null;
}

/**
 * A workspace's address name for its name: lowercase ASCII letters and digits (accents dropped), everything else one
 * `-`, no `-` at either end, at most 40 characters (the server's slug rule).
 */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** A domain as a person types it: trimmed, lowercase, no scheme or path; null when it is not one. */
export function cleanDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : null;
}

/** The names offered for the assistant. */
export const ASSISTANT_NAMES = ['Ada', 'Juno', 'Max', 'Sage'] as const;

// ---- the ready-made automations (§3) ---------------------------------------------------------------------------------

export type ReadyMade = 'briefing' | 'prep';
export const READY_MADE: Record<ReadyMade, { name: string; when: string; then: (agent: string) => string }> = {
  briefing: {
    name: 'Daily Briefing',
    when: 'Every weekday at 7:30 AM',
    then: (agent) => `@${agent} please help me prep for my day based on my calendar, recent conversations and open tasks.`,
  },
  prep: {
    name: 'Meeting Prep',
    when: 'Whenever a meeting with someone outside the team is added to my calendar',
    then: (agent) => `@${agent} please look into who I’m meeting, pull our recent threads and open items, and add a short prep note to the invite.`,
  },
};

/** The body POST /v1/events/subscriptions takes for one ready-made automation, waking the person's assistant. */
export function readyMadeBody(which: ReadyMade, assistantAccountId: string, timezone: string) {
  if (which === 'briefing') {
    return {
      name: READY_MADE.briefing.name,
      delivery: 'wake' as const,
      consumer: assistantAccountId,
      schedule: { every: 'weekdays@07:30', timezone },
      action: { kind: 'wake' as const, prompt: 'Help me prep for my day: look at my calendar for today, my recent conversations and mail, and my open tasks, then write me a short briefing.' },
    };
  }
  return {
    name: READY_MADE.prep.name,
    delivery: 'wake' as const,
    consumer: assistantAccountId,
    filter: { types: ['calendar.event.added'] },
    action: {
      kind: 'wake' as const,
      prompt: 'A meeting was added to my calendar: {{data}}. If nobody outside our workspace is invited, stop there and do nothing. Otherwise look into who I am meeting, pull our recent threads and open items with them, and add a short prep note to the invite.',
    },
  };
}

/** The ready-made automation a subscription is, by its name; null for any other. */
export function readyMadeOf(sub: Pick<SubscriptionDTO, 'name'>): ReadyMade | null {
  if (sub.name === READY_MADE.briefing.name) return 'briefing';
  if (sub.name === READY_MADE.prep.name) return 'prep';
  return null;
}

// ---- a written automation (§4) -----------------------------------------------------------------------------------------

/** What the person's assistant is asked, to make an automation from the person's own words. */
export function automationRequest(p: { when: string; agent: { name: string; accountId: string } | null; then: string; timezone: string }): string {
  const who = p.agent
    ? `wake ${p.agent.name} (account id ${p.agent.accountId}) with this request: "${p.then.trim()}"`
    : `do this, with no agent: "${p.then.trim()}" (use a post action if it is a message to a channel; otherwise wake yourself to do it)`;
  return [
    'Please make me an automation with your create_subscription tool.',
    `WHEN: ${p.when.trim()}`,
    `THEN: ${who}.`,
    `If WHEN is a time, use a schedule in my time zone (${p.timezone}); otherwise filter on the event types that match it, and put any condition you cannot filter on at the start of the prompt.`,
    'Name it in a few words. Then tell me in one or two sentences what you made: when it runs and what it does.',
  ].join('\n');
}

/** Ideas the person can start from (the design's side list): `agent` is who does it, `assistant` being the person's own. */
export const IDEAS: { tag: string; when: string; agent: 'assistant' | 'Omni' | null; then: string }[] = [
  { tag: 'Email', when: 'An email arrives at support@ asking for a refund', agent: 'Omni', then: 'please look up the order and draft a reply. Check with me in Chat before refunding anything over $500.' },
  { tag: 'Chat', when: 'Someone mentions me in #eng while I’m in a meeting', agent: 'assistant', then: 'please sum up the thread for me and let them know when I’m free.' },
  { tag: 'Timer', when: 'It’s Friday at 4 PM', agent: 'Omni', then: 'please write a recap of what the team shipped this week and post it in #general.' },
  { tag: 'Email', when: 'An email from our accountant arrives', agent: null, then: 'Forward it to me and label it Finance.' },
];

/** The browser's time zone, for schedules. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
