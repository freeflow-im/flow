// A meeting room (/meet/<code>): joins straight in, mic on and camera off, then shows everyone in a grid (a shared screen
// large, with people in a strip), the controls (mic, camera, share, people, leave) and a People panel. Built on the
// RealtimeKit core SDK with our own layout (docs/specs/meetings.md, P2); remote audio plays from an <audio> per person.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import RealtimeKitClient, { type RTKParticipant, type RTKSelf } from '@cloudflare/realtimekit';
import { ChevronLeft, Mic, MicOff, MonitorUp, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
import type { MeetingJoinDTO } from '@flow/shared';
import { api, MeetApiError } from '../api';

type Client = Awaited<ReturnType<typeof RealtimeKitClient.init>>;
type Person = RTKParticipant | RTKSelf;
type Phase = { kind: 'joining'; media?: boolean } | { kind: 'in'; client: Client; info: MeetingJoinDTO } | { kind: 'left' } | { kind: 'error'; message: string };

function joinError(e: unknown): string {
  if (e instanceof MeetApiError) {
    if (e.status === 404) return 'This meeting was not found. It may belong to an organization you are not in.';
    if (e.status === 503) return 'Meet is not set up on this server yet.';
    if (e.status === 401) return 'Sign in to join this meeting.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Joins the room and keeps the phase; `attempt` rejoins after a leave. */
function useMeeting(meetingRef: string, attempt: number): [Phase, (p: Phase) => void] {
  const [phase, setPhase] = useState<Phase>({ kind: 'joining' });
  useEffect(() => {
    let cancelled = false;
    let client: Client | null = null;
    setPhase({ kind: 'joining' });
    (async () => {
      const info = await api.join(meetingRef);
      if (cancelled) return;
      document.title = `${info.meeting.title} · FreeFlow Meet`;
      // The browser may now ask for the microphone; the page says so instead of only "Joining…".
      setPhase({ kind: 'joining', media: true });
      client = await RealtimeKitClient.init({ authToken: info.authToken, defaults: { audio: true, video: false } });
      if (cancelled) return;
      await client.join();
      if (cancelled) return void client.leave().catch(() => {});
      setPhase({ kind: 'in', client, info });
    })().catch((e: unknown) => {
      if (!cancelled) setPhase({ kind: 'error', message: joinError(e) });
    });
    return () => {
      cancelled = true;
      if (client?.self.roomJoined) void client.leave().catch(() => {});
    };
  }, [meetingRef, attempt]);
  return [phase, setPhase];
}

/** Draws again whenever anything in the room changes (people, their media, who is speaking). */
function useRoomUpdates(client: Client): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const joined = client.participants.joined;
    const onAny = () => bump();
    joined.on('*', onAny);
    client.self.on('*', onAny);
    client.participants.on('activeSpeaker', onAny);
    return () => {
      joined.off('*', onAny);
      client.self.off('*', onAny);
      client.participants.off('activeSpeaker', onAny);
    };
  }, [client]);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

const AVATAR_COLORS = ['#b06000', '#1558b0', '#188038', '#9334e6', '#c5221f', '#1e2a4a'];
const colorOf = (id: string) => AVATAR_COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length]!;

function Tile({ person, self, speaking, small }: { person: Person; self: boolean; speaking: boolean; small?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el || !person.videoEnabled) return;
    person.registerVideoElement(el);
    return () => person.deregisterVideoElement(el);
  }, [person, person.videoEnabled]);
  useEffect(() => {
    const el = audio.current;
    if (!el || self) return;
    el.srcObject = person.audioEnabled && person.audioTrack ? new MediaStream([person.audioTrack]) : null;
    if (el.srcObject) void el.play().catch(() => {});
  }, [person, self, person.audioEnabled, person.audioTrack]);
  const label = self ? 'You' : person.name;
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-[#3c4043] ${small ? 'aspect-video w-48 flex-none' : 'min-h-0 min-w-0'} ${speaking ? 'shadow-[inset_0_0_0_3px_#8ab4f8]' : ''}`}
    >
      {person.videoEnabled ? (
        <video ref={video} autoPlay playsInline muted className={`size-full object-cover ${self ? '-scale-x-100' : ''}`} />
      ) : (
        <span
          className={`flex items-center justify-center rounded-full font-semibold text-white ${small ? 'size-12 text-base' : 'size-20 text-3xl'}`}
          style={{ background: colorOf(person.customParticipantId ?? person.id) }}
          aria-hidden="true"
        >
          {initials(person.name)}
        </span>
      )}
      {!self && <audio ref={audio} autoPlay />}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white">
        {!person.audioEnabled && <MicOff size={13} className="text-[#f28b82]" aria-label="Muted" />}
        {label}
      </span>
    </div>
  );
}

function ScreenShare({ person }: { person: Person }) {
  const ref = useRef<HTMLVideoElement>(null);
  const track = person.screenShareTracks?.video;
  useEffect(() => {
    if (ref.current) ref.current.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-black">
      <video ref={ref} autoPlay playsInline muted className="size-full object-contain" />
      <span className="absolute left-2 top-2 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white">{person.name}’s screen</span>
    </div>
  );
}

function ControlButton({ label, on, danger, onClick, children }: { label: string; on?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex size-12 cursor-pointer items-center justify-center rounded-full border-0 text-white ${danger ? 'bg-[#ea4335] hover:bg-[#d93025]' : on ? 'bg-[#8ab4f8] text-[#202124]' : 'bg-[#3c4043] hover:bg-[#4a4f55]'}`}
    >
      {children}
    </button>
  );
}

function InRoom({ client, info, onLeft }: { client: Client; info: MeetingJoinDTO; onLeft: () => void }) {
  useRoomUpdates(client);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const self = client.self;
  const others = client.participants.joined.toArray() as RTKParticipant[];
  const everyone: Person[] = [self, ...others];
  const speaker = client.participants.lastActiveSpeaker;
  const presenter = everyone.find((p) => p.screenShareEnabled);
  const cols = everyone.length <= 1 ? 1 : everyone.length <= 4 ? 2 : everyone.length <= 9 ? 3 : 4;
  const rows = Math.ceil(everyone.length / cols);

  useEffect(() => {
    const onLeave = () => onLeft();
    self.on('roomLeft', onLeave);
    return () => void self.off('roomLeft', onLeave);
  }, [self, onLeft]);

  const act = (what: string, fn: () => Promise<void>) => {
    setMediaError(null);
    fn().catch((e: unknown) => setMediaError(`Could not ${what}: ${e instanceof Error ? e.message : String(e)}`));
  };

  const started = useMemo(() => Date.now(), []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const minutes = Math.floor((now - started) / 60_000);

  return (
    <div className="flex h-full flex-col bg-[#202124] text-[#e8eaed]">
      <header className="flex h-14 flex-none flex-wrap items-center gap-3 px-5">
        <a href={import.meta.env.BASE_URL} className="flex items-center gap-1 text-sm text-[#e8eaed] no-underline hover:text-white">
          <ChevronLeft size={18} aria-hidden="true" />
          Meet
        </a>
        <span className="h-5 w-px bg-[#5f6368]" />
        <h1 className="m-0 truncate text-base font-semibold">{info.meeting.title}</h1>
        <span className="text-sm text-[#bdc1c6]">{minutes < 1 ? 'Just joined' : `${minutes} min`}</span>
      </header>

      {mediaError && (
        <p role="alert" className="mx-5 mb-2 mt-0 rounded-lg bg-[#3c1e1e] px-3 py-2 text-sm text-[#f28b82]">
          {mediaError}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <section className="flex min-w-0 flex-1 flex-col gap-2.5" aria-label="People in the meeting">
          {presenter ? (
            <>
              <ScreenShare person={presenter} />
              <div className="flex flex-none gap-2.5 overflow-x-auto">
                {everyone.map((p) => (
                  <Tile key={p.id} person={p} self={p === self} speaking={p.id === speaker && p.audioEnabled} small />
                ))}
              </div>
            </>
          ) : (
            // Every cell fits the window: equal rows and columns share the stage, and each video fills its cell.
            <div className="grid min-h-0 flex-1 gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {everyone.map((p) => (
                <Tile key={p.id} person={p} self={p === self} speaking={p.id === speaker && p.audioEnabled} />
              ))}
            </div>
          )}
        </section>

        {peopleOpen && (
          <aside className="flex w-[300px] flex-none flex-col overflow-hidden rounded-xl bg-white text-ink" aria-label="People">
            <h2 className="m-0 border-b border-hairline px-4 py-3 text-sm font-semibold">People ({everyone.length})</h2>
            <ul className="m-0 flex list-none flex-col gap-2.5 overflow-auto p-4">
              {everyone.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 text-[15px]">
                  <span className="flex size-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: colorOf(p.customParticipantId ?? p.id) }} aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {p === self ? `${p.name} (you)` : p.name}
                  </span>
                  {!p.audioEnabled && <MicOff size={15} className="text-muted" aria-label="Muted" />}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <footer className="flex h-20 flex-none flex-wrap items-center justify-center gap-2.5 px-5">
        <ControlButton label={self.audioEnabled ? 'Mute' : 'Unmute'} danger={!self.audioEnabled} onClick={() => act('change the microphone', () => (self.audioEnabled ? self.disableAudio() : self.enableAudio()))}>
          {self.audioEnabled ? <Mic size={22} /> : <MicOff size={22} />}
        </ControlButton>
        <ControlButton label={self.videoEnabled ? 'Turn camera off' : 'Turn camera on'} danger={!self.videoEnabled} onClick={() => act('change the camera', () => (self.videoEnabled ? self.disableVideo() : self.enableVideo()))}>
          {self.videoEnabled ? <Video size={22} /> : <VideoOff size={22} />}
        </ControlButton>
        <ControlButton label={self.screenShareEnabled ? 'Stop sharing' : 'Share screen'} on={self.screenShareEnabled} onClick={() => act('share the screen', () => (self.screenShareEnabled ? self.disableScreenShare() : self.enableScreenShare()))}>
          <MonitorUp size={22} />
        </ControlButton>
        <ControlButton label="People" on={peopleOpen} onClick={() => setPeopleOpen((o) => !o)}>
          <Users size={22} />
        </ControlButton>
        <button
          type="button"
          onClick={() => void client.leave().finally(onLeft)}
          className="ml-3 flex h-12 cursor-pointer items-center gap-2 rounded-full border-0 bg-danger px-6 text-[15px] font-semibold text-white hover:bg-[#b3261e]"
        >
          <PhoneOff size={18} aria-hidden="true" />
          Leave
        </button>
      </footer>
    </div>
  );
}

export function Room({ meetingRef }: { meetingRef: string }) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useMeeting(meetingRef, attempt);

  if (phase.kind === 'in') return <InRoom client={phase.client} info={phase.info} onLeft={() => setPhase({ kind: 'left' })} />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#202124] p-6 text-center text-[#e8eaed]">
      {phase.kind === 'joining' && (
        <>
          <p className="m-0 text-lg">Joining…</p>
          {phase.media && <p className="m-0 max-w-sm text-sm text-[#bdc1c6]">If your browser asks, allow the microphone. You join with the mic on and the camera off.</p>}
        </>
      )}
      {phase.kind === 'error' && (
        <>
          <p role="alert" className="m-0 max-w-md text-lg">
            {phase.message}
          </p>
          <a href={import.meta.env.BASE_URL} className="text-[#8ab4f8]">
            Back to Meet
          </a>
        </>
      )}
      {phase.kind === 'left' && (
        <>
          <p className="m-0 text-lg">You left the meeting.</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="h-10 cursor-pointer rounded-full border-0 bg-primary px-5 font-semibold text-white hover:bg-primary-deep">
              Rejoin
            </button>
            <a href={import.meta.env.BASE_URL} className="flex h-10 items-center rounded-full border border-[#5f6368] px-5 text-[#e8eaed] no-underline">
              Back to Meet
            </a>
          </div>
        </>
      )}
    </div>
  );
}
