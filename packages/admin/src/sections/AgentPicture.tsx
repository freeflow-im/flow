// An agent's picture (agents.md §1.1, §1.3): one of the eight presets, or an upload. Used for the person's assistant, for
// each of their other agents, and in the Create agent form, where the choice waits until the agent is made.
import { AGENT_AVATAR_PRESETS, agentAvatarUrl, type AgentAvatarPreset } from '@flow/shared/assistant';

export type PictureChoice = { preset: AgentAvatarPreset } | { file: File } | null;

const tile = 'size-12 rounded-xl border-2 p-0.5';

/**
 * The tiles and the upload button. `current` is the picture shown as chosen (an address); `onPreset` and `onFile` take a
 * choice; `onNone` clears it (left out, no "No picture" link).
 */
export function PicturePicker({ current, busy, onPreset, onFile, onNone, testid }: {
  current: string | null;
  busy?: boolean;
  onPreset(p: AgentAvatarPreset): void;
  onFile(f: File): void;
  onNone?: () => void;
  testid: string;
}) {
  const uploaded = current && !AGENT_AVATAR_PRESETS.some((p) => agentAvatarUrl(p) === current) ? current : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Picture">
        {AGENT_AVATAR_PRESETS.map((p) => {
          const url = agentAvatarUrl(p);
          const on = current === url;
          return (
            <button key={p} type="button" role="radio" aria-checked={on} aria-label={p} disabled={busy} onClick={() => onPreset(p)} className={`${tile} ${on ? 'border-primary' : 'border-transparent hover:border-hairline'}`} data-testid={`${testid}-${p}`}>
              <img src={url} alt="" className="size-full rounded-lg" />
            </button>
          );
        })}
        {uploaded && (
          <span className={`${tile} border-primary`} title="Your upload" data-testid={`${testid}-upload-current`}>
            <img src={uploaded} alt="" className="size-full rounded-lg object-cover" />
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-md border border-border px-3 py-1 text-sm hover:bg-hover">
          {busy ? 'Saving…' : 'Upload a picture'}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} data-testid={`${testid}-file`} />
        </label>
        {current && onNone && (
          <button type="button" className="text-sm text-primary hover:underline" disabled={busy} onClick={onNone} data-testid={`${testid}-none`}>No picture</button>
        )}
      </div>
    </div>
  );
}

/** What the picker shows as chosen before the agent exists: a preset's address, or the upload's preview. */
export function choiceUrl(choice: PictureChoice, preview: string | null): string | null {
  if (!choice) return null;
  return 'preset' in choice ? agentAvatarUrl(choice.preset) : preview;
}
