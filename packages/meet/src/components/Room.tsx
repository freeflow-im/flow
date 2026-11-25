// A meeting room (/meet/<code>). A member of the room's organization joins as themselves; anyone else with the link
// joins as a guest with a name (phase 3, ruling R2). Both go through the check screen first, except a huddle opened from
// Chat, which joins straight in. Then everyone is in a grid (a shared screen large, with people in a strip), with the
// controls (mic, camera, share, people, chat, leave) and a side panel with People and Chat tabs (the Chat tab is Chat's
// own page in a frame: lib/chat.ts). Built on the RealtimeKit core SDK with our own
// layout (docs/specs/meetings.md, P2); remote audio plays from an <audio> per person.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import RealtimeKitClient, { type RecordingState, type RTKParticipant, type RTKSelf } from '@cloudflare/realtimekit';
import { playJoinChime } from '../lib/chime';
import { Check, ChevronLeft, Circle, Link2, Lock, LockOpen, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Square, Users, Video, VideoOff, X } from 'lucide-react';
import type { MeetingDTO, MeetingPreviewDTO } from '@flow/shared';
import { agentIdOf, api, isGuestId, MeetApiError, meetingUrl, signInUrl } from '../api';
import { SendAgent } from './SendAgent';
import { CheckScreen, type JoinChoice } from './CheckScreen';
import { guestChat, memberChat, unseenAfter, type RoomChat } from '../lib/chat';
import { ALIVE, guestKey, lastPeer, notePeer, readRejoin, REPLACES, withoutReplaced } from '../lib/rejoin';
import { ChatFrame } from './ChatFrame';
import { AutoClose } from './AutoClose';
import { useMediaQuery, useResizableWidth } from '../hooks/layout';

type Client = Awaited<ReturnType<typeof RealtimeKitClient.init>>;
type Person = RTKParticipant | RTKSelf;

/** Who is joining which room: a member (`meeting` set) or a guest (only the link's preview). */
interface Entry {
  meeting: MeetingDTO | null;
  preview: MeetingPreviewDTO | null;
}

/** The room as the call screen needs it, the same for a member and a guest. */
export interface RoomInfo {
  /** What the server calls the room by: its code. */
  ref: string;
  title: string;
  host: boolean;
  guest: boolean;
  /** The member's view of the room (null for a guest): huddle or not, locked or not. */
  meeting: MeetingDTO | null;
  /** The conversation on the Chat tab (phase 3b), or none. */
  chat: RoomChat | null;
}

type Panel = 'people' | 'chat';

type Phase =
  | { kind: 'loading' }
  | { kind: 'check'; entry: Entry }
  | { kind: 'joining'; media?: boolean }
  | { kind: 'in'; client: Client; info: RoomInfo; replaces: string | null }
  | { kind: 'left' }
  | { kind: 'error'; message: string; signIn?: boolean };

function joinError(e: unknown): string {
  if (e instanceof MeetApiError) {
    if (e.status === 404) return 'This meeting was not found. Check the link.';
    if (e.status === 503) return 'Meet is not set up on this server yet.';
    if (e.status === 429) return 'Too many tries from here. Wait a few minutes, then reload.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const isOutsider = (e: unknown) => e instanceof MeetApiError && (e.status === 401 || e.status === 403 || e.status === 404);

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

/**
 * The connections that a newer connection of the same person replaced (lib/rejoin.ts): old connection → the new one.
 * `replaces` is this page's own old connection, when this browser was in the room a moment ago: the page tells the room,
 * and tells each person who comes in while RealtimeKit still has the old one.
 */
function useReplaced(client: Client, replaces: string | null): ReadonlyMap<string, string> {
  const [replaced, setReplaced] = useState<ReadonlyMap<string, string>>(() => new Map(replaces ? [[replaces, client.self.id]] : []));
  useEffect(() => {
    const people = client.participants;
    const onMessage = (m: { type: string; payload: unknown }) => {
      const said = readRejoin(m.type, m.payload);
      if (!said) return;
      if (said.kind === 'replaces') {
        // This page is the one named, and it is still open (the room in two tabs): say so, and stay drawn.
        if (said.peerId === client.self.id) return void people.broadcastMessage(ALIVE, { peerId: said.peerId }).catch(() => {});
        setReplaced((cur) => new Map(cur).set(said.peerId, said.by));
      } else {
        setReplaced((cur) => {
          if (!cur.has(said.peerId)) return cur;
          const next = new Map(cur);
          next.delete(said.peerId);
          return next;
        });
      }
    };
    const tell = () => {
      if (replaces && people.joined.toArray().some((p) => p.id === replaces)) {
        void people.broadcastMessage(REPLACES, { peerId: replaces, by: client.self.id }).catch(() => {});
      }
    };
    people.on('broadcastedMessage', onMessage);
    people.joined.on('participantJoined', tell);
    tell();
    return () => {
      people.off('broadcastedMessage', onMessage);
      people.joined.off('participantJoined', tell);
    };
  }, [client, replaces]);
  return replaced;
}

/**
 * The room's recording, as RealtimeKit tells everyone in it (ruling R7: a badge for all while it is on). The server starts
 * and stops it (ruling R8), so this only listens.
 */
export function useRecordingState(client: Client): RecordingState {
  const [state, setState] = useState<RecordingState>(client.recording.recordingState);
  useEffect(() => {
    const onUpdate = (s: RecordingState) => setState(s);
    client.recording.on('recordingUpdate', onUpdate);
    setState(client.recording.recordingState);
    return () => void client.recording.off('recordingUpdate', onUpdate);
  }, [client]);
  return state;
}

/** Whether a recording is running or about to (the badge shows, the button offers Stop). */
export const isRecording = (s: RecordingState) => s === 'RECORDING' || s === 'STARTING' || s === 'PAUSED';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

const AVATAR_COLORS = ['#b06000', '#1558b0', '#188038', '#9334e6', '#c5221f', '#1e2a4a'];
const colorOf = (id: string) => AVATAR_COLORS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length]!;

/**
 * A participant's picture when they have no video: the one RealtimeKit has for them (the server gives it a public
 * address, edge avatarLinks.ts), else their initials on a color, also when the picture fails to load.
 */
export function Avatar({ person, className }: { person: Pick<Person, 'name' | 'id' | 'customParticipantId'> & { picture?: string }; className: string }) {
  const [broken, setBroken] = useState(false);
  const picture = person.picture && /^https?:\/\//.test(person.picture) && !broken ? person.picture : null;
  if (picture) {
    return <img src={picture} alt="" aria-hidden="true" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`${className} rounded-full object-cover`} />;
  }
  return (
    <span className={`${className} flex items-center justify-center rounded-full font-semibold text-white`} style={{ background: colorOf(person.customParticipantId ?? person.id) }} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
}

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
        <Avatar person={person} className={small ? 'size-12 text-base' : 'size-20 text-3xl'} />
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

function ControlButton({ label, on, danger, dot, onClick, children }: { label: string; on?: boolean; danger?: boolean; dot?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`relative flex size-12 cursor-pointer items-center justify-center rounded-full border-0 text-white ${danger ? 'bg-[#ea4335] hover:bg-[#d93025]' : on ? 'bg-[#8ab4f8] text-[#202124]' : 'bg-[#3c4043] hover:bg-[#4a4f55]'}`}
    >
      {children}
      {dot && <span data-testid="chat-dot" className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-[#8ab4f8] ring-2 ring-[#202124]" aria-hidden="true" />}
    </button>
  );
}

function PanelTab({ label, selected, dot, onClick }: { label: string; selected: boolean; dot?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`relative cursor-pointer rounded-full border-0 px-3 py-1.5 text-sm font-semibold ${selected ? 'bg-primary/10 text-primary' : 'bg-transparent text-muted hover:bg-black/5'}`}
    >
      {label}
      {dot && <span className="absolute right-0.5 top-1 size-2 rounded-full bg-primary" aria-hidden="true" />}
    </button>
  );
}

function InRoom({ client, info, replaces, onLeft }: { client: Client; info: RoomInfo; replaces: string | null; onLeft: () => void }) {
  useRoomUpdates(client);
  const replaced = useReplaced(client, replaces);
  const [panel, setPanel] = useState<Panel | null>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  // Messages posted while the Chat tab is closed: the dot on the Chat button.
  const [unseen, setUnseen] = useState(0);
  const chatOpen = panel === 'chat';
  // The side panel is as wide as the person drags it (on a phone it fills the screen instead).
  const wide = useMediaQuery('(min-width: 640px)');
  const panelWidth = useResizableWidth('meet.panelWidth', 340, 280, 760, 'left');
  useEffect(() => {
    if (chatOpen) setUnseen(0);
  }, [chatOpen]);
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    void navigator.clipboard.writeText(meetingUrl(info.ref)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    });
  };
  const [mediaError, setMediaError] = useState<string | null>(null);
  // A host locks a meeting so no new guests come in; a huddle never has guests, so it has no lock.
  const canLock = info.host && !info.guest && !!info.meeting && !info.meeting.channelId;
  const [locked, setLocked] = useState(info.meeting?.locked ?? false);
  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    api.setLocked(info.ref, next).catch((e: unknown) => {
      setLocked(!next);
      setMediaError(`Could not ${next ? 'lock' : 'unlock'} the meeting: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const sdkRecording = useRecordingState(client);
  // RealtimeKit can take several seconds to report a recording our server started: until it reports anything, the room
  // shows what the server said (started, or already running), so the button offers Stop at once.
  const [expected, setExpected] = useState<RecordingState | null>(null);
  useEffect(() => setExpected(null), [sdkRecording]);
  const recording: RecordingState = sdkRecording === 'IDLE' && expected ? expected : sdkRecording;
  const recordingOn = isRecording(recording);
  // Waiting on our server's answer, so a second click does not start or stop twice.
  const [recordingBusy, setRecordingBusy] = useState(false);
  const toggleRecording = () => {
    if (recordingBusy || recording === 'STOPPING') return;
    setRecordingBusy(true);
    setMediaError(null);
    const stopping = recordingOn;
    (stopping ? api.stopRecording(info.ref) : api.startRecording(info.ref))
      .then(() => setExpected(stopping ? null : 'STARTING'))
      .catch((e: unknown) => {
        if (e instanceof MeetApiError && e.code === 'already_recording') return setExpected('RECORDING');
        setMediaError(`Could not ${stopping ? 'stop' : 'start'} recording: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setRecordingBusy(false));
  };
  const self = client.self;
  // A connection its own person replaced is not drawn or heard while RealtimeKit still has it (lib/rejoin.ts).
  const others = withoutReplaced(self, client.participants.joined.toArray() as RTKParticipant[], replaced);
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
        {!info.guest && (
          <>
            <a href={import.meta.env.BASE_URL} className="flex items-center gap-1 text-sm text-[#e8eaed] no-underline hover:text-white">
              <ChevronLeft size={18} aria-hidden="true" />
              Meet
            </a>
            <span className="h-5 w-px bg-[#5f6368]" />
          </>
        )}
        <h1 className="m-0 truncate text-base font-semibold">{info.title}</h1>
        <span className="text-sm text-[#bdc1c6]">{minutes < 1 ? 'Just joined' : `${minutes} min`}</span>
        {recordingOn && (
          <span role="status" className="flex items-center gap-1.5 rounded-full bg-[#3c1e1e] px-2.5 py-0.5 text-sm text-[#f28b82]">
            <span className="size-2 rounded-full bg-[#ea4335]" aria-hidden="true" />
            {recording === 'STARTING' ? 'Recording starts…' : 'Recording'}
          </span>
        )}
        {locked && !canLock && (
          <span className="flex items-center gap-1 text-sm text-[#bdc1c6]">
            <Lock size={14} aria-hidden="true" />
            Locked
          </span>
        )}
        {canLock && (
          <button
            type="button"
            onClick={toggleLock}
            aria-pressed={locked}
            title={locked ? 'Let guests join again' : 'Stop new guests from joining. People in your organization can still join.'}
            className="ml-auto flex h-9 cursor-pointer items-center gap-2 rounded-full border border-[#5f6368] bg-transparent px-4 text-sm text-[#e8eaed] hover:bg-[#303134]"
          >
            {locked ? <Lock size={16} aria-hidden="true" /> : <LockOpen size={16} aria-hidden="true" />}
            {locked ? 'Locked' : 'Lock'}
          </button>
        )}
        {/* The room's link is its invitation: a member joins as themselves, anyone else as a guest (unless locked). */}
        <button
          type="button"
          onClick={copyLink}
          title={info.meeting?.channelId ? "Copy this huddle's link for the people in its conversation" : "Copy this meeting's link to send to anyone"}
          className={`${canLock ? '' : 'ml-auto '}flex h-9 cursor-pointer items-center gap-2 rounded-full border border-[#5f6368] bg-transparent px-4 text-sm text-[#e8eaed] hover:bg-[#303134]`}
        >
          {copied ? <Check size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
          {copied ? 'Link copied' : 'Copy link'}
        </button>
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

        {/* The side panel. With a chat it stays mounted while closed (off screen), so the chat keeps listening for the
            dot and opens where it was. */}
        {panel && wide && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panel"
            title="Drag to resize, double-click to reset"
            className="group relative z-10 -mx-[5px] w-[10px] flex-none cursor-col-resize touch-none self-stretch"
            {...panelWidth.handleProps}
          >
            <div className="absolute inset-y-4 left-[4px] w-[2px] rounded-full bg-transparent transition-colors group-hover:bg-white/50 group-active:bg-white/80" />
          </div>
        )}
        {(panel || info.chat) && (
          <aside
            style={panel && wide ? { width: panelWidth.width } : undefined}
            className={panel ? 'relative flex w-[340px] flex-none flex-col overflow-hidden rounded-xl bg-white text-ink max-sm:fixed max-sm:inset-0 max-sm:z-20 max-sm:w-auto max-sm:rounded-none' : 'invisible fixed -left-[10000px] top-0 flex h-[600px] w-[340px] flex-col'}
            aria-label={panel === 'chat' ? 'Chat' : 'People'}
            aria-hidden={!panel}
          >
            <div className="flex flex-none items-center gap-1 border-b border-hairline px-2 py-1.5" role="tablist">
              <PanelTab label={`People (${everyone.length})`} selected={panel === 'people'} onClick={() => setPanel('people')} />
              {info.chat && <PanelTab label="Chat" selected={chatOpen} onClick={() => setPanel('chat')} dot={unseen > 0} />}
              <button type="button" aria-label="Close the panel" title="Close" onClick={() => setPanel(null)} className="ml-auto flex size-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted hover:bg-black/5">
                <X size={18} />
              </button>
            </div>
            {info.chat && <ChatFrame chat={info.chat} shown={chatOpen} onPosted={(data) => setUnseen((n) => unseenAfter(n, data, chatOpen))} />}
            {panel === 'people' && (
            <ul className="m-0 flex list-none flex-col gap-2.5 overflow-auto p-4">
              {everyone.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 text-[15px]">
                  <Avatar person={p} className="size-7 flex-none text-[11px]" />
                  <span className="min-w-0 flex-1 truncate">
                    {p === self ? `${p.name} (you)` : p.name}
                    {isGuestId(p.customParticipantId) && <span className="ml-1.5 text-xs text-muted">Guest</span>}
                  </span>
                  {agentIdOf(p.customParticipantId) && <span className="flex-none text-xs text-muted">Agent</span>}
                  {agentIdOf(p.customParticipantId) && !info.guest ? (
                    <button
                      type="button"
                      onClick={() => void api.recallAgent(info.ref, agentIdOf(p.customParticipantId)!).catch((e: unknown) => setMediaError(`Could not send ${p.name} away: ${e instanceof Error ? e.message : String(e)}`))}
                      className="cursor-pointer rounded-full border border-hairline bg-transparent px-2.5 py-0.5 text-xs text-muted hover:bg-black/5"
                    >
                      Send away
                    </button>
                  ) : (
                    !p.audioEnabled && <MicOff size={15} className="text-muted" aria-label="Muted" />
                  )}
                </li>
              ))}
            </ul>
            )}
            {panel === 'people' && !info.guest && info.meeting && (
              <SendAgent
                meeting={info.meeting}
                present={new Set(everyone.map((p) => agentIdOf(p.customParticipantId)).filter((id): id is string => !!id))}
                onError={setMediaError}
              />
            )}
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
        {/* Anyone in the room who is a member can record (ruling R8); a guest sees the badge only. */}
        {!info.guest && (
          <ControlButton
            label={recordingOn ? 'Stop recording' : 'Record (saves the video and a transcript to Docs › Meetings)'}
            on={recordingOn}
            onClick={toggleRecording}
          >
            {recordingOn ? <Square size={20} fill="currentColor" /> : <Circle size={22} />}
          </ControlButton>
        )}
        <ControlButton label="People" on={panel === 'people'} onClick={() => toggle('people')}>
          <Users size={22} />
        </ControlButton>
        {info.chat && (
          <ControlButton label={unseen > 0 ? `Chat (${unseen} new)` : 'Chat'} on={chatOpen} onClick={() => toggle('chat')} dot={unseen > 0}>
            <MessageSquare size={22} />
          </ControlButton>
        )}
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
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const client = useRef<Client | null>(null);
  const info = useRef<RoomInfo | null>(null);
  const last = useRef<{ entry: Entry; choice: JoinChoice } | null>(null);
  const mounted = useRef(true);

  const join = useCallback(async (entry: Entry, choice: JoinChoice) => {
    last.current = { entry, choice };
    setPhase({ kind: 'joining' });
    try {
      let room: RoomInfo;
      let authToken: string;
      if (entry.meeting) {
        const r = await api.join(entry.meeting.code);
        room = { ref: r.meeting.code, title: r.meeting.title, host: r.host, guest: false, meeting: r.meeting, chat: memberChat(r.meeting) };
        authToken = r.authToken;
      } else {
        const r = await api.joinAsGuest(entry.preview!.code, choice.name ?? '', guestKey());
        room = { ref: r.code, title: r.title, host: false, guest: true, meeting: null, chat: guestChat(r) };
        authToken = r.authToken;
      }
      if (!mounted.current) return;
      document.title = `${room.title} · FreeFlow Meet`;
      // The browser may now ask for the microphone or camera; the page says so instead of only "Joining…".
      setPhase({ kind: 'joining', media: choice.audio || choice.video });
      const c = await RealtimeKitClient.init({ authToken, defaults: { audio: choice.audio, video: choice.video } });
      await c.join();
      if (!mounted.current) return void c.leave().catch(() => {});
      client.current = c;
      info.current = room;
      // This browser's connection from before, if it was in the room a moment ago and never said it left.
      const before = lastPeer(room.ref);
      notePeer(room.ref, c.self.id);
      setPhase({ kind: 'in', client: c, info: room, replaces: before && before !== c.self.id ? before : null });
      // A chime says the join has finished (lib/chime.ts).
      void playJoinChime();
    } catch (e) {
      if (mounted.current) setPhase({ kind: 'error', message: joinError(e) });
    }
  }, []);

  // Who is opening the link: a member of its organization, or a guest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meeting = await api.get(meetingRef);
        if (cancelled) return;
        document.title = `${meeting.title} · FreeFlow Meet`;
        // A huddle opened from Chat goes straight in: the person already chose to call.
        if (meeting.channelId) return void join({ meeting, preview: null }, { audio: true, video: false });
        const preview = await api.preview(meeting.code).catch(() => null);
        if (!cancelled) setPhase({ kind: 'check', entry: { meeting, preview } });
      } catch (e) {
        if (!isOutsider(e)) throw e;
        const preview = await api.preview(meetingRef);
        if (cancelled) return;
        document.title = `${preview.title} · FreeFlow Meet`;
        if (!preview.guestsAllowed) {
          setPhase({ kind: 'error', message: 'This call is only for the people in its conversation. Sign in to join it.', signIn: true });
        } else setPhase({ kind: 'check', entry: { meeting: null, preview } });
      }
    })().catch((e: unknown) => {
      if (!cancelled) setPhase({ kind: 'error', message: joinError(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [meetingRef, join]);

  // Closing or reloading the tab leaves too. RealtimeKit is told, so the others lose this tile at once: without it the
  // old connection stays until RealtimeKit times it out, and a person who comes straight back shows twice. Our server
  // hears it at once as well (a huddle's roster in Chat).
  useEffect(() => {
    mounted.current = true;
    const onClose = () => {
      const c = client.current;
      if (!c?.self.roomJoined) return;
      void c.leave().catch(() => {});
      if (info.current && !info.current.guest) api.leaveOnClose(info.current.ref);
    };
    window.addEventListener('pagehide', onClose);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', onClose);
      const c = client.current;
      if (c?.self.roomJoined) {
        void c.leave().catch(() => {});
        if (info.current && !info.current.guest) void api.leave(info.current.ref).catch(() => {});
      }
    };
  }, []);

  if (phase.kind === 'in')
    return (
      <InRoom
        client={phase.client}
        replaces={phase.replaces}
        info={phase.info}
        onLeft={() => {
          if (!phase.info.guest) void api.leave(phase.info.ref).catch(() => {});
          client.current = null;
          setPhase({ kind: 'left' });
        }}
      />
    );
  if (phase.kind === 'check') {
    const { meeting, preview } = phase.entry;
    return (
      <CheckScreen
        code={meeting?.code ?? preview!.code}
        title={meeting?.title ?? preview!.title}
        people={preview?.people ?? []}
        guest={!meeting}
        locked={!meeting && !!preview?.locked}
        onJoin={(choice) => void join(phase.entry, choice)}
      />
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#202124] p-6 text-center text-[#e8eaed]">
      {phase.kind === 'loading' && <p className="m-0 text-lg">Opening the meeting…</p>}
      {phase.kind === 'joining' && (
        <>
          <p className="m-0 text-lg">Joining…</p>
          {phase.media && <p className="m-0 max-w-sm text-sm text-[#bdc1c6]">If your browser asks, allow the microphone and camera.</p>}
        </>
      )}
      {phase.kind === 'error' && (
        <>
          <p role="alert" className="m-0 max-w-md text-lg">
            {phase.message}
          </p>
          {phase.signIn ? (
            <a href={signInUrl(meetingRef)} className="text-[#8ab4f8]">
              Sign in
            </a>
          ) : (
            last.current?.entry.meeting !== null && (
              <a href={import.meta.env.BASE_URL} className="text-[#8ab4f8]">
                Back to Meet
              </a>
            )
          )}
        </>
      )}
      {phase.kind === 'left' && (
        <>
          <p className="m-0 text-lg">You left the meeting.</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => last.current && void join(last.current.entry, last.current.choice)}
              className="h-10 cursor-pointer rounded-full border-0 bg-primary px-5 font-semibold text-white hover:bg-primary-deep"
            >
              Rejoin
            </button>
            {!last.current || last.current.entry.meeting ? (
              <a href={import.meta.env.BASE_URL} className="flex h-10 items-center rounded-full border border-[#5f6368] px-5 text-[#e8eaed] no-underline">
                Back to Meet
              </a>
            ) : null}
          </div>
          <AutoClose fallbackUrl={!last.current || last.current.entry.meeting ? import.meta.env.BASE_URL : null} />
        </>
      )}
    </div>
  );
}
