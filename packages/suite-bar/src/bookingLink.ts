// The account menu's booking page row (docs/specs/guest-scheduler.md §4): "Copy booking link" when the person's booking
// page is on, "Create booking page" when it is not, nothing when Calendar does not answer for this account (a guest with no
// calendar, a host without Calendar). Read from the Calendar API each time the menu opens; the last answer shows meanwhile.
import { useEffect, useState } from 'react';

export type BookingLink = { kind: 'on'; url: string } | { kind: 'off' } | null;

/** Where "Create booking page" goes: Calendar, with its Booking page dialog open. */
export const BOOKING_SETTINGS_PATH = '/calendar/?booking=1';

export function useBookingLink(open: boolean, org: string | null): BookingLink {
  const [link, setLink] = useState<BookingLink>(null);
  useEffect(() => {
    if (!open || typeof fetch !== 'function') return;
    let live = true;
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
    const q = new URLSearchParams({ tz: zone, ...(org ? { workspace: org } : {}) });
    fetch(`/v1/calendar/scheduler?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) return null;
        const j = (await res.json()) as { url?: string | null; page?: { enabled?: boolean } };
        return j.page?.enabled && j.url ? ({ kind: 'on', url: j.url } as const) : ({ kind: 'off' } as const);
      })
      .catch(() => null)
      .then((l) => { if (live) setLink(l); });
    return () => { live = false; };
  }, [open, org]);
  return link;
}
