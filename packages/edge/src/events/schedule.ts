// A schedule's `every` (platform.md §5.2, "Schedules are subscriptions on `schedule.tick`") as a recurrence, and its next
// instant: the scheduled messages' own next-occurrence logic (org/lib/recurrence.ts), so a schedule keeps local wall-clock
// time across a DST change the same way. `monthly@31 09:00` follows cron and skips the months without a 31st.
import { SCHEDULE_EVERY, type Recurrence } from '@flow/shared';
import { isValidTimezone, nextOccurrence } from '../org/lib/recurrence';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** `hourly`, `daily@HH:MM`, `weekly@DAY HH:MM`, `monthly@D HH:MM`, as a recurrence; null when it is none of them. */
export function recurrenceOf(every: string): Recurrence | null {
  const e = every.trim().toUpperCase();
  if (!SCHEDULE_EVERY.test(e)) return null;
  if (e === 'HOURLY') return { type: 'hourly', minute: 0 };
  const [kind, rest] = e.split('@') as [string, string];
  const hm = /(\d\d):(\d\d)$/.exec(rest)!;
  const hour = Number(hm[1]);
  const minute = Number(hm[2]);
  if (kind === 'DAILY') return { type: 'daily', hour, minute };
  if (kind === 'WEEKLY') return { type: 'weekly', weekday: DAYS.indexOf(rest.slice(0, 3)), hour, minute };
  return { type: 'cron', expression: `${minute} ${hour} ${Number(rest.split(' ')[0])} * *` };
}

/** The first instant strictly after `after` (ms) at which the schedule fires, in ms; null for a bad schedule or zone. */
export function nextScheduleAt(every: string, timezone: string, after: number): number | null {
  const r = recurrenceOf(every);
  if (!r || !isValidTimezone(timezone)) return null;
  return nextOccurrence(r, timezone, new Date(after))?.getTime() ?? null;
}
