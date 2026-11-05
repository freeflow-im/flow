// The page before any calendar is connected: iCloud and Fastmail (with an app password), any other CalDAV server by its
// address, and Google, coming soon.
import { CalendarDays, Lock, Server } from 'lucide-react';

export type ConnectKind = 'icloud' | 'fastmail' | 'other';
const OPTIONS: { kind: ConnectKind | 'google'; name: string; note: string }[] = [
  { kind: 'icloud', name: 'iCloud', note: 'With an app-specific password' },
  { kind: 'fastmail', name: 'Fastmail', note: 'With an app password' },
  { kind: 'other', name: 'Other CalDAV', note: 'Nextcloud, Radicale, Baïkal, SOGo, Zimbra, Synology…' },
  { kind: 'google', name: 'Google Calendar', note: 'Coming soon' },
];

export function ConnectCalendar({ onAdd }: { onAdd(kind: ConnectKind): void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <CalendarDays className="size-8" strokeWidth={1.5} />
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-ink">Connect your calendar</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted">See and change the calendars you already have, right beside your mail, chats and documents.</p>
        <ul className="flex flex-col gap-2 text-left">
          {OPTIONS.map((o) => (
            <li key={o.kind}>
              <button type="button" disabled={o.kind === 'google'} onClick={() => o.kind !== 'google' && onAdd(o.kind)}
                className="flex w-full items-center justify-between rounded-xl border border-hairline px-4 py-3 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
                <span className="shrink-0 whitespace-nowrap font-medium text-ink">{o.name}</span>
                <span className="ml-3 text-right text-[13px] text-muted">{o.note}</span>
              </button>
            </li>
          ))}
        </ul>
        <ul className="mt-8 space-y-3 text-left text-[14px] text-muted">
          <li className="flex gap-3"><Server className="mt-0.5 size-4 shrink-0" />Your calendars stay with your provider. FreeFlow keeps a copy in step with them over CalDAV.</li>
          <li className="flex gap-3"><Lock className="mt-0.5 size-4 shrink-0" />Your password is stored encrypted, only for your account, and you can remove it at any time.</li>
        </ul>
      </div>
    </div>
  );
}
