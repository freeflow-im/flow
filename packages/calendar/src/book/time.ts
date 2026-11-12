// Dates and times for the guest's page, always in the zone the guest picked (never the browser's unless it is that one).
// A date is `YYYY-MM-DD`, a month `YYYY-MM`, as the API takes them.

const pad = (n: number) => String(n).padStart(2, '0');

export function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The date an instant falls on in a zone. */
export function dateIn(ms: number, zone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** A month's grid, Sunday first: null for the cells before the 1st. */
export function monthCells(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [...Array.from({ length: first }, () => null), ...Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)];
}

export const monthTitle = (month: string) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${month}-01T00:00:00Z`));
export const dayTitle = (date: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${date}T00:00:00Z`));
export const timeIn = (iso: string | number, zone: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(typeof iso === 'number' ? iso : Date.parse(iso));
export const fullWhen = (start: string, end: string, zone: string) =>
  `${timeIn(start, zone)} – ${timeIn(end, zone)}, ${new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: zone }).format(Date.parse(start))}`;

/** "Pacific Time – Los Angeles (9:50 AM)": a zone as the picker shows it. */
export function zoneLabel(zone: string, now = Date.now()): string {
  let generic = '';
  try { generic = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? ''; } catch { /* an old runtime */ }
  const city = zone.split('/').pop()!.replace(/_/g, ' ');
  return `${generic && !generic.startsWith('GMT') ? `${generic} – ` : ''}${city} (${timeIn(now, zone)})`;
}

/** Every zone the runtime knows, the guest's own first among them. */
export function allZones(current: string): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { /* an old runtime */ }
  return [...new Set([current, ...all])].sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
}

const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');

/** An .ics with the meeting, for "Add to calendar" (the invitation mail carries the real one). */
export function icsOf(b: { id: string; title: string; ownerName: string; start: string; end: string; location: string | null }): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FreeFlow//Booking//EN', 'BEGIN:VEVENT', `UID:${b.id}@freeflow-booking`, `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(b.start)}`, `DTEND:${icsTime(b.end)}`, `SUMMARY:${icsText(`${b.title} with ${b.ownerName}`)}`, ...(b.location ? [`LOCATION:${icsText(b.location)}`] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

export function googleLink(b: { title: string; ownerName: string; start: string; end: string; location: string | null }): string {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: `${b.title} with ${b.ownerName}`, dates: `${icsTime(b.start)}/${icsTime(b.end)}`, ...(b.location ? { location: b.location } : {}) });
  return `https://calendar.google.com/calendar/render?${p}`;
}
