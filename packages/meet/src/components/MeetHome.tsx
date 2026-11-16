// Meet's home (/meet/): start a meeting now, copy a link for later, and the organization's meetings running now.
// A meeting opens in its own tab (App.tsx).
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link2, Video } from 'lucide-react';
import type { LiveMeetingDTO } from '@flow/shared';
import { api, meetingUrl } from '../api';
import { useOrganizations } from '../hooks/organization';
import { MeetSuiteBar } from './MeetSuiteBar';

const LIVE_REFRESH_MS = 15_000;

/** Opens a tab at once (a tab opened after an await is blocked as a pop-up), then sends it to the room. */
function openRoom(make: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank');
  return make().then(
    (url) => {
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    },
    (err: unknown) => {
      tab?.close();
      throw err;
    },
  );
}

function minutesSince(iso: string | null): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 1 ? 'just started' : `${min} min`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

function LiveRow({ meeting }: { meeting: LiveMeetingDTO }) {
  const names = meeting.people.map((p) => p.name.split(' ')[0]);
  return (
    <li className="flex flex-wrap items-center gap-4 rounded-xl border border-[#c6dafc] bg-[#f3f8fe] px-4 py-3.5">
      <span className="size-2.5 rounded-full bg-ok" aria-hidden="true" />
      <div className="min-w-[200px] flex-1">
        <div className="text-[15px] font-semibold">{meeting.title}</div>
        <div className="text-xs text-muted">
          {names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} in` : 'In progress'}
          {meeting.startedAt ? ` · ${minutesSince(meeting.startedAt)}` : ''}
        </div>
      </div>
      <div className="flex" aria-hidden="true">
        {meeting.people.slice(0, 4).map((p, i) => (
          <span key={p.userId ?? i} className={`flex size-[30px] items-center justify-center rounded-full border-2 border-[#f3f8fe] bg-primary-deep text-[12px] font-semibold text-white ${i ? '-ml-2' : ''}`}>
            {initials(p.name)}
          </span>
        ))}
      </div>
      <a href={meetingUrl(meeting.code)} target="_blank" rel="noopener" className="flex h-9 items-center rounded-full bg-primary px-[18px] text-sm font-semibold text-white no-underline hover:bg-primary-deep">
        Join
      </a>
    </li>
  );
}

export function MeetHome() {
  const { active, ready } = useOrganizations();
  const enabled = useQuery({ queryKey: ['meet', 'enabled'], queryFn: api.enabled, staleTime: 5 * 60_000 });
  const live = useQuery({
    queryKey: ['meet', 'live', active?.id],
    queryFn: () => api.live(active!.id),
    enabled: !!active && enabled.data === true,
    refetchInterval: LIVE_REFRESH_MS,
  });
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => openRoom(async () => meetingUrl((await api.create(active!.id)).code)),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const copyLink = useMutation({
    mutationFn: async () => {
      const url = meetingUrl((await api.create(active!.id)).code);
      await navigator.clipboard.writeText(url);
    },
    onSuccess: () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const off = enabled.data === false;
  const canAct = !!active && enabled.data === true && !start.isPending && !copyLink.isPending;

  return (
    <div className="flex min-h-full flex-col">
      <MeetSuiteBar />
      <main className="mx-auto box-border flex w-full max-w-[1200px] flex-1 flex-wrap gap-8 p-8">
        <section className="flex max-w-[340px] flex-[1_1_300px] flex-col gap-4">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.3px]">Meet</h1>
          <p className="m-0 text-[15px] leading-[22px] text-muted">Video meetings for your organization. Start one and send the link to a teammate.</p>
          {off ? (
            <p className="m-0 rounded-lg border border-warn-border bg-warn-bg p-3 text-sm text-ink-soft">Meet is not set up on this server yet.</p>
          ) : (
            <div className="flex flex-col gap-1 rounded-xl border border-border p-2 shadow-[0_2px_6px_rgba(60,64,67,0.12)]">
              <button
                type="button"
                disabled={!canAct}
                onClick={() => {
                  setError(null);
                  start.mutate();
                }}
                className="flex h-12 cursor-pointer items-center gap-3 rounded-lg border-0 bg-primary px-3 text-[15px] font-semibold text-white hover:bg-primary-deep disabled:cursor-default disabled:opacity-60"
              >
                <Video size={20} aria-hidden="true" />
                {start.isPending ? 'Starting…' : 'Start a meeting now'}
              </button>
              <button
                type="button"
                disabled={!canAct}
                onClick={() => {
                  setError(null);
                  copyLink.mutate();
                }}
                className="flex h-11 cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-3 text-[15px] text-ink hover:bg-hover disabled:cursor-default disabled:opacity-60"
              >
                <Link2 size={20} className="text-muted" aria-hidden="true" />
                {copied ? 'Link copied' : copyLink.isPending ? 'Making a link…' : 'Copy a link for later'}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-sm text-danger">
              {error}
            </p>
          )}
        </section>

        <section className="flex min-w-0 flex-[999_1_560px] flex-col gap-2">
          <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.6px] text-muted">Live now</h2>
          {!ready || (live.isLoading && !off) ? (
            <p className="m-0 text-sm text-muted">Loading…</p>
          ) : live.data && live.data.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {live.data.map((m) => (
                <LiveRow key={m.id} meeting={m} />
              ))}
            </ul>
          ) : (
            <p className="m-0 rounded-xl border border-hairline p-4 text-sm text-muted">No meetings are running in {active?.name ?? 'your organization'} right now.</p>
          )}
        </section>
      </main>
    </div>
  );
}
