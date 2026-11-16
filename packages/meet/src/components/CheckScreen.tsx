// The check screen (docs/specs/meetings.md §2.3, phase 3): before joining by a link, see your camera, choose mic and
// camera, and see who is already in. A guest also types a name (ruling R2: then straight in, no waiting room). A huddle
// opened from Chat skips it.
import { useEffect, useRef, useState } from 'react';
import { Lock, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { signInUrl } from '../api';

export interface JoinChoice {
  audio: boolean;
  video: boolean;
  /** A guest's name; a member joins as themselves. */
  name?: string;
}

const NAME_KEY = 'flow.meet.guestName';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not kept: the guest types it again next time.
  }
}

/** "No one is here yet", "Ann is here", "Ann and Ben are here", "Ann and 2 others are here". */
export function whoIsHere(people: string[]): string {
  if (people.length === 0) return 'No one is here yet';
  if (people.length === 1) return `${people[0]} is here`;
  if (people.length === 2) return `${people[0]} and ${people[1]} are here`;
  return `${people[0]} and ${people.length - 1} others are here`;
}

/** Shows the camera while it is chosen, and lets it go when it is not (or when the screen closes). */
function useCameraPreview(on: boolean): { ref: React.RefObject<HTMLVideoElement | null>; error: string | null } {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: true })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => !cancelled && setError('The camera is not available. Check the browser’s permission for this site.'));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (ref.current) ref.current.srcObject = null;
    };
  }, [on]);
  return { ref, error };
}

function Toggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex size-12 cursor-pointer items-center justify-center rounded-full border-0 text-white ${on ? 'bg-[#3c4043] hover:bg-[#4a4f55]' : 'bg-[#ea4335] hover:bg-[#d93025]'}`}
    >
      {children}
    </button>
  );
}

export function CheckScreen({
  code,
  title,
  people,
  guest,
  locked,
  onJoin,
}: {
  code: string;
  title: string;
  people: string[];
  guest: boolean;
  locked: boolean;
  onJoin: (choice: JoinChoice) => void;
}) {
  const [audio, setAudio] = useState(true);
  const [video, setVideo] = useState(false);
  const [name, setName] = useState(rememberedName);
  const camera = useCameraPreview(video);
  const blocked = guest && locked;
  const ready = !blocked && (!guest || name.trim().length > 0);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (guest) rememberName(name.trim());
    onJoin({ audio, video, ...(guest ? { name: name.trim() } : {}) });
  };

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[#202124] p-6 text-[#e8eaed]">
      <form onSubmit={join} className="flex w-full max-w-4xl flex-wrap items-center justify-center gap-8">
        <div className="flex w-full max-w-[520px] flex-col items-center gap-3">
          <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-[#3c4043]">
            {video ? (
              <video ref={camera.ref} autoPlay playsInline muted className="size-full -scale-x-100 object-cover" />
            ) : (
              <span className="text-sm text-[#bdc1c6]">Camera is off</span>
            )}
          </div>
          {camera.error && (
            <p role="alert" className="m-0 text-sm text-[#f28b82]">
              {camera.error}
            </p>
          )}
          <div className="flex gap-3">
            <Toggle label={audio ? 'Turn microphone off' : 'Turn microphone on'} on={audio} onClick={() => setAudio((a) => !a)}>
              {audio ? <Mic size={22} /> : <MicOff size={22} />}
            </Toggle>
            <Toggle label={video ? 'Turn camera off' : 'Turn camera on'} on={video} onClick={() => setVideo((v) => !v)}>
              {video ? <Video size={22} /> : <VideoOff size={22} />}
            </Toggle>
          </div>
        </div>

        <div className="flex w-full max-w-[300px] flex-col gap-4">
          <div>
            <h1 className="m-0 text-2xl font-normal">{title}</h1>
            <p className="m-0 mt-1 text-sm text-[#bdc1c6]">{whoIsHere(people)}</p>
          </div>
          {blocked ? (
            <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-[#3c4043] px-3 py-2.5 text-sm">
              <Lock size={16} className="mt-0.5 flex-none" aria-hidden="true" />
              This meeting is locked. Ask the host to let guests in, then reload this page.
            </p>
          ) : (
            guest && (
              <label className="flex flex-col gap-1.5 text-sm">
                Your name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  autoFocus
                  autoComplete="name"
                  placeholder="Your name"
                  className="h-11 rounded-lg border border-[#5f6368] bg-transparent px-3 text-[15px] text-[#e8eaed] outline-none focus:border-[#8ab4f8]"
                />
              </label>
            )
          )}
          <button
            type="submit"
            disabled={!ready}
            className="h-11 cursor-pointer rounded-full border-0 bg-[#8ab4f8] px-6 text-[15px] font-semibold text-[#202124] hover:bg-[#aecbfa] disabled:cursor-default disabled:opacity-50"
          >
            Join now
          </button>
          {guest && (
            <p className="m-0 text-sm text-[#bdc1c6]">
              In this organization?{' '}
              <a href={signInUrl(code)} className="text-[#8ab4f8]">
                Sign in
              </a>{' '}
              to join as yourself.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
