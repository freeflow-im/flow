// The guest scheduler's mail to a guest (docs/specs/guest-scheduler.md §1, §3.5): booked, moved or cancelled, with the
// guest's own link to cancel or reschedule. It goes from the platform's sender (mail.ts `sendMail`), named for the owner and
// with the owner's address as Reply-To. When the calendar side sent the guest no invitation (no mailbox sends as the owner),
// it carries the invitation itself (`ics`), so the meeting still lands in the guest's calendar.
import type { OutgoingMail } from '../mail';

export interface BookingMailInput {
  kind: 'booked' | 'moved' | 'cancelled';
  to: { name: string; email: string };
  owner: { name: string; email: string };
  title: string;
  start: number;
  end: number;
  /** The guest's zone, for the times in the mail; the page's when the guest gave none. */
  zone: string;
  location: string | null;
  manageUrl: string | null;
  /** An iTIP message (METHOD:REQUEST or CANCEL) to attach, when the calendar side sent none. */
  ics?: string | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' } as Record<string, string>)[c]};`);

/** "Monday, 16 November 2026, 09:00–09:30 (America/Los_Angeles)". */
export function whenText(start: number, end: number, zone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start);
  const time = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(ms);
  return `${day}, ${time(start)} – ${time(end)} (${zone.replace(/_/g, ' ')})`;
}

export function bookingMail(m: BookingMailInput): OutgoingMail {
  const when = whenText(m.start, m.end, m.zone);
  const head = m.kind === 'booked' ? 'Your meeting is booked' : m.kind === 'moved' ? 'Your meeting has moved' : 'Your meeting is cancelled';
  const subject = `${m.kind === 'booked' ? 'Booked' : m.kind === 'moved' ? 'Moved' : 'Cancelled'}: ${m.title} with ${m.owner.name}`;
  const lines = [
    `Hi ${m.to.name},`, '',
    `${head}: ${m.title} with ${m.owner.name}.`, '',
    `When: ${when}`,
    ...(m.location && m.kind !== 'cancelled' ? [`Where: ${m.location}`] : []),
    ...(m.manageUrl && m.kind !== 'cancelled' ? ['', `To cancel or reschedule: ${m.manageUrl}`] : []),
    ...(m.ics && m.kind !== 'cancelled' ? ['', 'The attached invitation adds it to your calendar.'] : []),
    '', `Reply to this email to reach ${m.owner.name}.`,
  ];
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">
<p>Hi ${esc(m.to.name)},</p>
<p><strong>${esc(head)}</strong>: ${esc(m.title)} with ${esc(m.owner.name)}.</p>
<p>When: ${esc(when)}${m.location && m.kind !== 'cancelled' ? `<br>Where: ${esc(m.location)}` : ''}</p>
${m.manageUrl && m.kind !== 'cancelled' ? `<p><a href="${esc(m.manageUrl)}">Cancel or reschedule</a></p>` : ''}
<p style="color:#6b7280">Reply to this email to reach ${esc(m.owner.name)}.</p></div>`;
  return {
    to: m.to.email, subject, text: lines.join('\n'), html, fromName: `${m.owner.name} via FreeFlow`, replyTo: m.owner.email,
    ...(m.ics ? { attachments: [{ filename: m.kind === 'cancelled' ? 'cancel.ics' : 'invite.ics', type: `text/calendar; method=${m.kind === 'cancelled' ? 'CANCEL' : 'REQUEST'}; charset=utf-8`, content: Buffer.from(m.ics, 'utf8').toString('base64') }] } : {}),
  };
}
