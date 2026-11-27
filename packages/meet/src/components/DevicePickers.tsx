// The Camera / Microphone / Speaker pickers (lib/devices.ts), shared by the check screen and the room's device panel.
import { useEffect, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { canPickSpeaker, playTestSound, type DeviceKind, type DeviceLists } from '../lib/devices';

const LABEL: Record<DeviceKind, string> = {
  videoinput: 'Camera',
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
};

function Picker({
  kind,
  options,
  value,
  onChange,
}: {
  kind: DeviceKind;
  options: DeviceLists[DeviceKind];
  value: string | undefined;
  onChange: (kind: DeviceKind, id: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[#bdc1c6]">
      {LABEL[kind]}
      <select
        aria-label={LABEL[kind]}
        value={value ?? ''}
        disabled={options.length === 0}
        onChange={(e) => onChange(kind, e.target.value)}
        className="h-9 w-full min-w-0 cursor-pointer truncate rounded-lg border border-[#5f6368] bg-[#303134] px-2 text-[13px] text-[#e8eaed] outline-none focus:border-[#8ab4f8] disabled:cursor-default disabled:opacity-60"
      >
        {options.length === 0 && <option value="">No {LABEL[kind].toLowerCase()} found</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Three pickers in a row (the Speaker one only where the browser can choose an output). */
export function DevicePickers({
  lists,
  value,
  onChange,
}: {
  lists: DeviceLists;
  /** The device in use for each kind (lib/devices.ts pickDevice). */
  value: Partial<Record<DeviceKind, string>>;
  onChange: (kind: DeviceKind, id: string) => void;
}) {
  const speaker = canPickSpeaker();
  return (
    <div className={`grid w-full gap-3 ${speaker ? 'grid-cols-3' : 'grid-cols-2'}`}>
      <Picker kind="videoinput" options={lists.videoinput} value={value.videoinput} onChange={onChange} />
      <Picker kind="audioinput" options={lists.audioinput} value={value.audioinput} onChange={onChange} />
      {speaker && <Picker kind="audiooutput" options={lists.audiooutput} value={value.audiooutput} onChange={onChange} />}
    </div>
  );
}

/** "Test speaker": a short tone on the chosen speaker (or the default one, where the browser cannot choose). */
export function TestSpeaker({ speaker }: { speaker: string | undefined }) {
  return (
    <button
      type="button"
      onClick={() => void playTestSound(speaker)}
      className="flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-semibold text-[#8ab4f8] hover:underline"
    >
      <Volume2 size={14} aria-hidden="true" />
      Test speaker
    </button>
  );
}

/** A five-step level meter for a microphone track. */
export function MicLevel({ stream }: { stream: MediaStream | null }) {
  const level = useMicLevel(stream);
  const lit = Math.round(level * 5);
  return (
    <span className="flex items-center gap-2 text-xs text-[#bdc1c6]">
      Mic level
      <span className="flex gap-1" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={5} aria-valuenow={lit}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`h-1.5 w-3.5 rounded-full ${i < lit ? 'bg-[#81c995]' : 'bg-[#5f6368]'}`} />
        ))}
      </span>
    </span>
  );
}

function useMicLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    setLevel(0);
    if (!stream || stream.getAudioTracks().length === 0 || typeof AudioContext === 'undefined') return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let last = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (t - last < 80) return;
      last = t;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      // RMS of speech sits around 0.02–0.2; scale so normal talking lights most of the meter.
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
    };
    frame = requestAnimationFrame(tick);
    void ctx.resume().catch(() => {});
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close().catch(() => {});
    };
  }, [stream]);
  return level;
}
