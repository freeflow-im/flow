// A dev-only stand-in for the guest scheduler's APIs (docs/specs/guest-scheduler.md §3): the owner's /v1/calendar/scheduler
// and the public /v1/book/*, in memory. The page is on from the start at /calendar/book/demo-demo-demo. Slots are the
// weekly hours in the page's zone less what was booked here; the edge Worker's are also less the owner's calendars.
type Weekly = Record<string, [number, number][]>;
interface Config {
  enabled: boolean; title: string; description: string; durations: number[]; defaultDuration: number; timezone: string; weekly: Weekly;
  minNoticeMin: number; horizonDays: number; bufferBeforeMin: number; bufferAfterMin: number; maxPerDay: number | null; incrementMin: number | null;
  busyCalendarIds: string[] | null; targetCalendarId: string | null; location: { kind: 'text' | 'none'; value: string };
}
interface Booking { id: string; manage: string; start: number; duration: number; name: string; email: string; note: string | null; tz: string; status: 'booked' | 'cancelled'; reschedules: number }

const DAY = 86_400_000;
const WORK: [number, number][] = [[540, 1020]];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n: number) => String(n).padStart(2, '0');

function offset(ms: number, zone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}
const at = (date: string, minute: number, zone: string) => { const local = Date.parse(`${date}T00:00:00Z`) + minute * 60_000; const first = local - offset(local, zone); return local - offset(first, zone); };
const dateIn = (ms: number, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

export function createSchedulerMock() {
  let token = 'demo-demo-demo';
  let config: Config = {
    enabled: true, title: '30 Minute Meet', description: '', durations: [30, 45, 60], defaultDuration: 30, timezone: 'America/Los_Angeles',
    weekly: { sun: [], mon: WORK, tue: WORK, wed: WORK, thu: WORK, fri: WORK, sat: [] }, minNoticeMin: 240, horizonDays: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
    maxPerDay: null, incrementMin: null, busyCalendarIds: null, targetCalendarId: null, location: { kind: 'text', value: 'https://meet.example/ann' },
  };
  const bookings: Booking[] = [];
  const err = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });
  const horizon = () => at(dateIn(Date.now() + config.horizonDays * DAY, config.timezone), 1440, config.timezone);
  const slots = (from: number, to: number, duration: number, except?: string) => {
    const out: number[] = [];
    const step = (config.incrementMin ?? Math.min(30, ...config.durations)) * 60_000, dur = duration * 60_000;
    const earliest = Math.max(from, Date.now() + config.minNoticeMin * 60_000), last = horizon();
    for (let t = from - DAY; t < to + DAY; t += DAY) {
      const date = dateIn(t, config.timezone);
      for (const [a, b] of config.weekly[DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!] ?? []) {
        for (let s = at(date, a, config.timezone); s + dur <= at(date, b, config.timezone); s += step) {
          if (s < earliest || s >= to || s + dur > last || out.includes(s)) continue;
          if (bookings.some((x) => x.status === 'booked' && x.id !== except && s < x.start + x.duration * 60_000 && x.start < s + dur)) continue;
          out.push(s);
        }
      }
    }
    return out.sort((x, y) => x - y);
  };
  const page = () => ({
    ownerName: 'Ann Lee', title: config.title, description: config.description, durations: config.durations, defaultDuration: config.defaultDuration,
    location: config.location.kind === 'none' ? { kind: 'none', label: null } : /^https?:/.test(config.location.value) ? { kind: 'link', label: null } : { kind: 'text', label: config.location.value },
    ownerTimezone: config.timezone, horizonEnd: new Date(horizon()).toISOString(),
  });
  const view = (b: Booking) => ({
    id: b.id, status: b.status, start: new Date(b.start).toISOString(), end: new Date(b.start + b.duration * 60_000).toISOString(), duration: b.duration, guestName: b.name, timezone: b.tz,
    title: config.title, ownerName: 'Ann Lee', location: config.location.kind === 'text' ? config.location.value : null,
    canReschedule: b.status === 'booked' && b.reschedules < 5 && b.start > Date.now(), canCancel: b.status === 'booked' && b.start > Date.now(),
  });
  const days = (q: URLSearchParams, except?: string) => {
    const tz = q.get('tz') || config.timezone, month = q.get('month')!, duration = Number(q.get('duration') ?? config.defaultDuration);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const from = at(`${month}-01`, 0, tz), to = at(`${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`, 0, tz);
    return { status: 200, json: { month, timezone: tz, duration, days: [...new Set(slots(from, to, duration, except).map((s) => dateIn(s, tz)))] } };
  };
  const daySlots = (q: URLSearchParams, except?: string) => {
    const tz = q.get('tz') || config.timezone, date = q.get('date')!, duration = Number(q.get('duration') ?? config.defaultDuration);
    return { status: 200, json: { date, timezone: tz, duration, slots: slots(at(date, 0, tz), at(date, 1440, tz), duration, except).map((s) => new Date(s).toISOString()) } };
  };
  const taken = (start: number, duration: number, tz: string, except?: string) => {
    if (slots(start, start + 1, duration, except).includes(start)) return null;
    const date = dateIn(start, tz);
    return { status: 409, json: { error: { code: 'slot_taken', message: 'That time is no longer free; pick another' }, slots: slots(at(date, 0, tz), at(date, 1440, tz), duration, except).map((s) => new Date(s).toISOString()) } };
  };

  return (method: string, url: URL, body: any): { status: number; json: unknown } | null => {
    const p = url.pathname, q = url.searchParams;
    if (p === '/v1/calendar/scheduler') {
      if (method === 'PATCH') config = { ...config, ...body, weekly: { ...config.weekly, ...(body?.weekly ?? {}) } };
      return { status: 200, json: { page: config, token, url: `${url.origin}/calendar/book/${token}` } };
    }
    if (p === '/v1/calendar/scheduler/rotate') { token = Math.random().toString(36).slice(2, 14).replace(/(.{4})(?=.)/g, '$1-'); return { status: 200, json: { page: config, token, url: `${url.origin}/calendar/book/${token}` } }; }
    if (p === '/v1/calendar/scheduler/bookings') return { status: 200, json: { bookings: bookings.map((b) => ({ id: b.id, eventId: `e-${b.id}`, status: b.status, start: new Date(b.start).toISOString(), end: new Date(b.start + b.duration * 60_000).toISOString(), duration: b.duration, guestName: b.name, guestEmail: b.email, note: b.note, guestTimezone: b.tz, reschedules: b.reschedules })) } };
    let m = /^\/v1\/book\/m\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (m) {
      const b = bookings.find((x) => x.manage === m![1]);
      if (!b) return err(404, 'not_found', 'This booking link does not exist or is turned off');
      if (!m[2]) return { status: 200, json: { booking: view(b), page: page() } };
      if (m[2] === '/days') return days(q, b.id);
      if (m[2] === '/slots') return daySlots(q, b.id);
      if (m[2] === '/cancel') { b.status = 'cancelled'; return { status: 200, json: { booking: view(b) } }; }
      if (m[2] === '/reschedule') {
        const start = Date.parse(body.start);
        const no = taken(start, body.duration, body.tz, b.id);
        if (no) return no;
        Object.assign(b, { start, duration: body.duration, tz: body.tz, reschedules: b.reschedules + 1 });
        return { status: 200, json: { booking: view(b) } };
      }
    }
    m = /^\/v1\/book\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (m) {
      if (m[1]!.replace(/-/g, '').toLowerCase() !== token.replace(/-/g, '') || !config.enabled) return err(404, 'not_found', 'This booking link does not exist or is turned off');
      if (!m[2] && method === 'GET') return { status: 200, json: { page: page() } };
      if (m[2] === '/days') return days(q);
      if (m[2] === '/slots') return daySlots(q);
      if (!m[2] && method === 'POST') {
        const start = Date.parse(body.start);
        const no = taken(start, body.duration, body.tz);
        if (no) return no;
        const b: Booking = { id: Math.random().toString(36).slice(2), manage: Math.random().toString(36).slice(2).padEnd(22, 'x').slice(0, 22), start, duration: body.duration, name: body.name, email: body.email, note: body.note ?? null, tz: body.tz, status: 'booked', reschedules: 0 };
        bookings.push(b);
        return { status: 201, json: { booking: view(b), manageUrl: `/calendar/book/m/${b.manage}` } };
      }
    }
    return null;
  };
}
