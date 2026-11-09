// The Automations section (platform.md §5.2, phase 2.5; docs/specs/workspace-admin.md §3.5), moved here from Chat's
// admin panel: the event-bus subscriptions the caller consumes or owns, their wake jobs, and a form for a new one — wake
// an agent or post a message, when an event happens or on a schedule. Every member sees it; the server decides what each
// may create (a wake needs the agent's sponsor, or an owner or admin).
import { useCallback, useEffect, useState } from 'react';
import type { AgentJobDTO, ChannelDTO, CreateSubscriptionBody, SubscriptionDTO, WorkspaceMemberDTO } from '@flow/shared';
import { request } from '../../api';

/** The suite's API with the session cookie, in the shape Chat's bound api had. */
const useBoundApi = () => ({ api: request });

export const EVENT_TYPE_SUGGESTIONS = [
  'chat.message.created',
  'chat.thread.reply',
  'chat.reaction.added',
  'chat.channel.created',
  'chat.member.joined',
  'mail.received',
  'sharing.granted',
] as const;

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_NAMES: Record<Weekday, string> = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };

export interface AutomationDraft {
  trigger: 'event' | 'schedule';
  /** When an event happens. */
  type: string;
  channelId: string;
  text: string;
  /** On a schedule. */
  freq: 'hourly' | 'daily' | 'weekly' | 'monthly';
  time: string;
  day: Weekday;
  date: number;
  timezone: string;
  /** The action. */
  action: 'wake' | 'post';
  agent: string;
  prompt: string;
  runIn: string;
  postChannel: string;
  body: string;
  /** Also act on events the consumer itself caused. */
  includeSelf: boolean;
  /** '' until edited: the default sentence stands in. */
  name: string;
}

export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const emptyDraft = (): AutomationDraft => ({
  trigger: 'event', type: 'chat.message.created', channelId: '', text: '',
  freq: 'daily', time: '09:00', day: 'MON', date: 1, timezone: browserTimezone(),
  action: 'wake', agent: '', prompt: '', runIn: '', postChannel: '', body: '', includeSelf: false, name: '',
});

/** The schedule's `every` as the server accepts it: `hourly`, `daily@HH:MM`, `weekly@DAY HH:MM`, `monthly@D HH:MM`. */
export function everyOf(d: Pick<AutomationDraft, 'freq' | 'time' | 'day' | 'date'>): string {
  if (d.freq === 'hourly') return 'hourly';
  if (d.freq === 'daily') return `daily@${d.time}`;
  if (d.freq === 'weekly') return `weekly@${d.day} ${d.time}`;
  return `monthly@${d.date} ${d.time}`;
}

/** `every` in words: "every day at 09:00". */
export function everyInWords(every: string): string {
  const m = /^(hourly|daily|weekly|monthly)(?:@(.*))?$/i.exec(every);
  if (!m) return every;
  const [, kind, rest = ''] = m;
  if (kind!.toLowerCase() === 'hourly') return 'every hour';
  if (kind!.toLowerCase() === 'daily') return `every day at ${rest}`;
  const [first, at] = rest.split(' ');
  if (kind!.toLowerCase() === 'weekly') return `every ${WEEKDAY_NAMES[first!.toUpperCase() as Weekday] ?? first} at ${at}`;
  return `on day ${first} of every month at ${at}`;
}

type Names = { member: (accountId: string) => string; channel: (id: string) => string };

/** The sentence a new automation is named by until someone edits it. */
export function defaultName(d: AutomationDraft, names: Names): string {
  const what = d.action === 'wake' ? `Wake ${d.agent ? names.member(d.agent) : 'an agent'}` : `Post in ${d.postChannel ? names.channel(d.postChannel) : 'a channel'}`;
  const when = d.trigger === 'schedule'
    ? everyInWords(everyOf(d))
    : `on ${d.type.trim() || 'an event'}${d.channelId ? ` in ${names.channel(d.channelId)}` : ''}`;
  return `${what} ${when}`.slice(0, 100);
}

/** The exact body POST /v1/events/subscriptions takes (`CreateSubscriptionBody`). */
export function buildSubscriptionBody(d: AutomationDraft, names: Names): CreateSubscriptionBody {
  const name = (d.name.trim() || defaultName(d, names)).slice(0, 100);
  const filter: CreateSubscriptionBody['filter'] = d.trigger === 'event'
    ? { types: [d.type.trim()], ...(d.channelId ? { channelId: d.channelId } : {}), ...(d.text.trim() ? { text: d.text.trim() } : {}) }
    : {};
  const self = d.includeSelf ? { includeSelf: true } : {};
  const schedule = d.trigger === 'schedule' ? { schedule: { every: everyOf(d), timezone: d.timezone.trim() || 'UTC' } } : {};
  if (d.action === 'wake') {
    return {
      name, filter, delivery: 'wake', consumer: d.agent,
      action: { kind: 'wake', prompt: d.prompt.trim(), ...(d.runIn ? { channelId: d.runIn } : {}), ...self },
      ...schedule,
    };
  }
  return { name, filter, delivery: 'post', action: { kind: 'post', channelId: d.postChannel, body: d.body.trim(), ...self }, ...schedule };
}

/** One line on what a subscription listens for. */
export function filterSummary(sub: SubscriptionDTO, names: Names): string {
  if (sub.schedule) return `${everyInWords(sub.schedule.every)} (${sub.schedule.timezone})`;
  const f = sub.filter;
  const parts = [f.types?.length ? f.types.join(', ') : 'every event'];
  if (f.channelId) parts.push(`in ${names.channel(f.channelId)}`);
  if (f.text) parts.push(`matching “${f.text}”`);
  if (f.actorKind && f.actorKind !== 'any') parts.push(`by a ${f.actorKind}`);
  if (f.self) parts.push('about me');
  if (f.ref) parts.push(`on ${f.ref.app}/${f.ref.kind}/${f.ref.id}`);
  return parts.join(' ');
}

/** One line on what a subscription does when it matches. */
export function actionSummary(sub: SubscriptionDTO, names: Names): string {
  const own = sub.action?.includeSelf ? ', including your own events' : '';
  return actionLine(sub, names) + own;
}

function actionLine(sub: SubscriptionDTO, names: Names): string {
  const a = sub.action;
  if (sub.delivery === 'wake' && a?.kind === 'wake') {
    return `Wake ${names.member(sub.consumer)}${a.channelId ? ` in ${names.channel(a.channelId)}` : ''}: “${a.prompt}”`;
  }
  if (sub.delivery === 'post' && a?.kind === 'post') return `Post in ${names.channel(a.channelId)}: “${a.body}”`;
  if (sub.delivery === 'socket') return 'Socket: pokes the open app';
  if (sub.delivery === 'webhook') return 'Webhook';
  return 'Pull: read when the consumer likes';
}

const when = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
};

const inputCls = 'rounded border border-hairline bg-white px-2 py-1 text-sm disabled:opacity-50';
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'failed');

export function AutomationsSection({
  workspaceId,
  members,
  channels,
}: {
  workspaceId: string;
  members: WorkspaceMemberDTO[];
  channels: ChannelDTO[];
}) {
  const { api } = useBoundApi();
  const [subs, setSubs] = useState<SubscriptionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const names: Names = {
    member: (accountId) => members.find((m) => m.accountId === accountId)?.displayName ?? 'an agent',
    channel: (id) => {
      const c = channels.find((x) => x.id === id);
      return c?.name ? `#${c.name}` : 'a channel';
    },
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ subscriptions: SubscriptionDTO[] }>('GET', `/v1/events/subscriptions?workspace=${encodeURIComponent(workspaceId)}`);
      setSubs(r.subscriptions);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="automations" className="mb-6">
      <AutomationForm workspaceId={workspaceId} members={members} channels={channels} names={names} onCreated={load} />
      <div className="rounded-lg border border-hairline p-4">
        <h3 className="mb-3 text-sm font-bold">Your automations</h3>
        {error && <p data-testid="automations-error" className="mb-2 text-xs text-red-600">{error}</p>}
        {subs === null ? (
          !error && <p className="text-sm text-muted">Loading…</p>
        ) : subs.length === 0 ? (
          <p data-testid="automations-empty" className="text-sm text-muted">No automations yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {subs.map((s) => (
              <SubscriptionRow key={s.id} sub={s} workspaceId={workspaceId} names={names} onDeleted={load} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SubscriptionRow({ sub, workspaceId, names, onDeleted }: { sub: SubscriptionDTO; workspaceId: string; names: Names; onDeleted: () => Promise<void> }) {
  const { api } = useBoundApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AgentJobDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const ws = `workspace=${encodeURIComponent(workspaceId)}`;

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', `/v1/events/subscriptions/${encodeURIComponent(sub.id)}?${ws}`);
      await onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      setConfirming(false);
    }
  };

  const toggleJobs = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    try {
      const r = await api<{ jobs: AgentJobDTO[] }>('GET', `/v1/events/jobs?subscription=${encodeURIComponent(sub.id)}&${ws}`);
      setJobs(r.jobs);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <li data-testid={`automation-${sub.id}`} className="py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold">{sub.name}</div>
          <div data-testid={`automation-filter-${sub.id}`} className="text-xs text-muted">{filterSummary(sub, names)}</div>
          <div data-testid={`automation-action-${sub.id}`} className="text-xs text-ink-soft">{actionSummary(sub, names)}</div>
          <div className="text-xs text-faint">
            {sub.delivery} · cursor {sub.cursor}
            {sub.parkedAt && <span data-testid={`automation-parked-${sub.id}`} className="text-red-600"> · parked {when(sub.parkedAt)}</span>}
          </div>
        </div>
        <div className="shrink-0">
          {confirming ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs text-muted">Delete?</span>
              <button
                data-testid={`automation-delete-confirm-${sub.id}`}
                className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void remove()}
              >
                Yes
              </button>
              <button className="text-xs text-muted hover:underline" disabled={busy} onClick={() => setConfirming(false)}>
                No
              </button>
            </span>
          ) : (
            <button
              data-testid={`automation-delete-${sub.id}`}
              className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {sub.delivery === 'wake' && (
        <div className="mt-1">
          <button data-testid={`automation-jobs-${sub.id}`} className="text-xs text-accent-deep hover:underline" onClick={() => void toggleJobs()}>
            {open ? '▾' : '▸'} Recent jobs
          </button>
          {open && (
            jobs === null ? (
              <p className="text-xs text-muted">Loading…</p>
            ) : jobs.length === 0 ? (
              <p className="text-xs text-muted">No jobs yet.</p>
            ) : (
              <table className="mt-1 w-full text-xs">
                <thead>
                  <tr className="text-left text-faint">
                    <th className="pr-3 font-semibold">State</th>
                    <th className="pr-3 font-semibold">Attempts</th>
                    <th className="pr-3 font-semibold">Created</th>
                    <th className="font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} data-testid={`automation-job-${j.id}`}>
                      <td className="pr-3">{j.state}</td>
                      <td className="pr-3">{j.attempts}</td>
                      <td className="pr-3">{when(j.createdAt)}</td>
                      <td>{j.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}
    </li>
  );
}

function AutomationForm({
  workspaceId,
  members,
  channels,
  names,
  onCreated,
}: {
  workspaceId: string;
  members: WorkspaceMemberDTO[];
  channels: ChannelDTO[];
  names: Names;
  onCreated: () => Promise<void>;
}) {
  const { api } = useBoundApi();
  const [d, setD] = useState<AutomationDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => setD((cur) => ({ ...cur, [key]: value }));

  // A wake names the agent's account; an agent whose row carries none cannot be chosen.
  const agents = members.filter((m) => m.isAgent && m.accountId);
  const mine = channels.filter((c) => c.isMember && c.name && !c.archivedAt);
  const ready = (d.trigger === 'schedule' || d.type.trim() !== '')
    && (d.action === 'wake' ? d.agent !== '' && d.prompt.trim() !== '' : d.postChannel !== '' && d.body.trim() !== '');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/v1/events/subscriptions?workspace=${encodeURIComponent(workspaceId)}`, buildSubscriptionBody(d, names));
      setD(emptyDraft());
      await onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const channelOptions = (
    <>
      {mine.map((c) => (
        <option key={c.id} value={c.id}>#{c.name}</option>
      ))}
    </>
  );

  return (
    <form
      data-testid="automation-form"
      className="mb-4 rounded-lg border border-hairline p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-bold">New automation</h3>
      <div className="mb-3 flex gap-4">
        <label className="flex items-center gap-1.5">
          <input data-testid="automation-trigger-event" type="radio" name="trigger" checked={d.trigger === 'event'} onChange={() => set('trigger', 'event')} />
          When an event happens
        </label>
        <label className="flex items-center gap-1.5">
          <input data-testid="automation-trigger-schedule" type="radio" name="trigger" checked={d.trigger === 'schedule'} onChange={() => set('trigger', 'schedule')} />
          On a schedule
        </label>
      </div>

      {d.trigger === 'event' ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Event type</span>
            <input data-testid="automation-type" className={inputCls} list="automation-type-suggestions" value={d.type} onChange={(e) => set('type', e.target.value)} />
            <datalist id="automation-type-suggestions">
              {EVENT_TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">In channel (optional)</span>
            <select data-testid="automation-channel" className={inputCls} value={d.channelId} onChange={(e) => set('channelId', e.target.value)}>
              <option value="">Any channel</option>
              {channelOptions}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Containing text (optional)</span>
            <input data-testid="automation-text" className={inputCls} value={d.text} onChange={(e) => set('text', e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Every</span>
            <select data-testid="automation-freq" className={inputCls} value={d.freq} onChange={(e) => set('freq', e.target.value as AutomationDraft['freq'])}>
              <option value="hourly">Hour</option>
              <option value="daily">Day</option>
              <option value="weekly">Week</option>
              <option value="monthly">Month</option>
            </select>
          </label>
          {d.freq === 'weekly' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">On</span>
              <select data-testid="automation-day" className={inputCls} value={d.day} onChange={(e) => set('day', e.target.value as Weekday)}>
                {WEEKDAYS.map((w) => (
                  <option key={w} value={w}>{WEEKDAY_NAMES[w]}</option>
                ))}
              </select>
            </label>
          )}
          {d.freq === 'monthly' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Day of month</span>
              <select data-testid="automation-date" className={inputCls} value={d.date} onChange={(e) => set('date', Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          {d.freq !== 'hourly' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">At</span>
              <input data-testid="automation-time" type="time" className={inputCls} value={d.time} onChange={(e) => set('time', e.target.value || '09:00')} />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Timezone</span>
            <input data-testid="automation-timezone" className={inputCls} value={d.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </label>
        </div>
      )}

      <div className="mb-3 flex gap-4 border-t border-hairline pt-3">
        <label className="flex items-center gap-1.5">
          <input data-testid="automation-action-wake" type="radio" name="action" checked={d.action === 'wake'} onChange={() => set('action', 'wake')} />
          Wake an agent
        </label>
        <label className="flex items-center gap-1.5">
          <input data-testid="automation-action-post" type="radio" name="action" checked={d.action === 'post'} onChange={() => set('action', 'post')} />
          Post a message
        </label>
      </div>

      {d.action === 'wake' ? (
        <div className="mb-3 grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Agent</span>
              <select data-testid="automation-agent" className={inputCls} value={d.agent} onChange={(e) => set('agent', e.target.value)}>
                <option value="">Choose an agent…</option>
                {agents.map((m) => (
                  <option key={m.userId} value={m.accountId}>{m.displayName}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Run in channel (optional)</span>
              <select data-testid="automation-run-in" className={inputCls} value={d.runIn} onChange={(e) => set('runIn', e.target.value)}>
                <option value="">The agent's own channel</option>
                {channelOptions}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Prompt</span>
            <textarea data-testid="automation-prompt" rows={3} className={inputCls} value={d.prompt} onChange={(e) => set('prompt', e.target.value)} />
            <span className="text-xs text-faint">
              {'{{type}}'}, {'{{ref}}'}, {'{{channel}}'}, {'{{actor}}'} and {'{{data}}'} are replaced with the event's.
            </span>
          </label>
        </div>
      ) : (
        <div className="mb-3 grid gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Post in</span>
            <select data-testid="automation-post-channel" className={inputCls} value={d.postChannel} onChange={(e) => set('postChannel', e.target.value)}>
              <option value="">Choose a channel…</option>
              {channelOptions}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Message</span>
            <textarea data-testid="automation-body" rows={3} className={inputCls} value={d.body} onChange={(e) => set('body', e.target.value)} />
          </label>
        </div>
      )}

      <div className="mb-3 flex flex-col gap-1">
        <label className="flex items-center gap-1.5">
          <input data-testid="automation-include-self" type="checkbox" checked={d.includeSelf} onChange={(e) => set('includeSelf', e.target.checked)} />
          Also fire on my own events
        </label>
        <span className="text-xs text-muted">
          Automations skip events you cause yourself, so they cannot trigger each other in a loop. Tick this to include them.
        </span>
      </div>

      <label className="mb-3 flex flex-col gap-1">
        <span className="text-xs text-muted">Name</span>
        <input data-testid="automation-name" className={inputCls} maxLength={100} value={d.name || defaultName(d, names)} onChange={(e) => set('name', e.target.value)} />
      </label>
      {error && <p data-testid="automation-form-error" className="mb-2 text-xs text-red-600">{error}</p>}
      <button
        data-testid="automation-create"
        type="submit"
        className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-deep disabled:opacity-50"
        disabled={busy || !ready}
      >
        Create automation
      </button>
    </form>
  );
}
