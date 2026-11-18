// Step 2, the person's assistant: their "Chief of Staff" (docs/specs/onboarding.md §1, agents.md §1.1). It introduces
// itself in a scripted chat (no model call: the workspace may have no model yet), typed out a letter at a time, and asks
// for a name and a picture. Picking a name names the assistant, which gives it its address and mailbox; picking a picture
// sets one of the eight presets.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { AGENT_AVATAR_PRESETS, agentAvatarUrl, type AgentAvatarPreset } from '@flow/shared/assistant';
import { suite } from '../suite';
import { setupApi } from './api';
import { ASSISTANT_NAMES } from './lib';
import { ErrorText, lead, PrimaryButton, StepHeading } from './ui';

/** One part of the script: a line typed out, or a block (choices) shown once the text before it is typed. */
type Part = { key: string; text: string; bold?: string } | { key: string; block: 'names' | 'pictures' | 'continue' } | { key: string; reply: string };

/** The script so far, for where the person is: a name picked (`name`), a picture picked (`picture`). */
export function scriptFor(p: { firstName: string; name: string | null; picture: boolean }): Part[] {
  const parts: Part[] = [
    { key: 'hello', text: `Hi ${p.firstName}, I’m your Chief of Staff. I work only for you, and I’m right here in every app: Mail, Chat, Files and Calendar.` },
    { key: 'know', text: 'A few things to know about me:' },
    { key: 'l1', bold: 'I see what you see', text: ': your mail, files, chats and calendar, nothing more.' },
    { key: 'l2', bold: 'Only you can talk to me.', text: ' Teammates can’t message me or read our chats.' },
    { key: 'l3', bold: 'I get things done on my own', text: ' and tell you what I did.' },
    { key: 'l4', bold: 'I sign my own work,', text: ' so everyone can tell who did what.' },
    { key: 'ask', text: 'First, what would you like to call me? Pick one or type a name below.' },
    { key: 'names', block: 'names' },
  ];
  if (p.name) parts.push({ key: 'reply', reply: p.name }, { key: 'look', text: `${p.name} it is. Now pick a look for me:` }, { key: 'pictures', block: 'pictures' });
  if (p.name && p.picture) parts.push({ key: 'next', text: 'Love it.' }, { key: 'continue', block: 'continue' });
  return parts;
}

const lengthOf = (part: Part) => ('text' in part ? (part.bold ?? '').length + part.text.length : 1);
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function AssistantStep({ org, stepOf, onDone }: { org: WorkspaceDTO; stepOf: string; onDone: () => void }) {
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const firstName = (me.data?.displayName ?? '').split(' ')[0] || 'there';
  const [name, setName] = useState<string | null>(null);
  const [picture, setPicture] = useState<AgentAvatarPreset | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const parts = useMemo(() => scriptFor({ firstName, name, picture: !!picture }), [firstName, name, picture]);
  const total = parts.reduce((n, p) => n + lengthOf(p), 0);
  // How much of the script is typed out, a letter a tick; all of it at once for a person who asks for less motion.
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return setTyped(total);
    if (typed >= total) return;
    const t = window.setTimeout(() => setTyped((n) => Math.min(total, n + 2)), 24);
    return () => window.clearTimeout(t);
  }, [typed, total]);

  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [typed]);

  const pickName = async (n: string) => {
    const clean = n.trim().slice(0, 80);
    if (!clean || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setupApi.nameAssistant(org.id, clean);
      setName(clean);
      setDraft('');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  const pickPicture = async (preset: AgentAvatarPreset) => {
    setError(null);
    setPicture(preset);
    await setupApi.setAvatar(org.id, preset).catch((err) => setError(err));
  };

  // Each part's typed share.
  let left = typed;
  const shown = parts.map((part) => {
    const len = lengthOf(part);
    const n = Math.max(0, Math.min(len, left));
    left -= len;
    return { part, n, started: n > 0, done: n >= len };
  });

  const title = name ?? 'Chief of Staff';
  return (
    <section className="flex min-w-0 flex-[1_1_100%] flex-col gap-7">
      <StepHeading stepOf={stepOf} title="Meet your Chief of Staff">
        <p className={lead}>Everyone in the workspace gets one. Yours lives in the button at the bottom of every app: Mail, Chat, Files and Calendar. Open it any time to ask for help or hand something off.</p>
      </StepHeading>

      <div role="dialog" aria-label={title} className="flex h-[620px] w-full max-w-[560px] flex-col overflow-hidden rounded-[18px] border border-hairline bg-white shadow-[0_20px_48px_rgba(16,24,40,0.16)]" data-testid="setup-assistant-panel">
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          {picture ? <img src={agentAvatarUrl(picture)} alt="" width={28} height={28} className="rounded-lg" /> : <span aria-hidden="true" className="h-7 w-7 rounded-lg bg-track" />}
          <span className="font-semibold">{title}</span>
        </div>
        <div ref={list} aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
          {shown.map(({ part, n, started, done }) => {
            if (!started) return null;
            if ('reply' in part) {
              return <p key={part.key} className="m-0 self-end rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[15px] text-white">{part.reply}</p>;
            }
            if ('block' in part) {
              if (part.block === 'names') {
                return (
                  <div key={part.key} role="group" aria-label="Suggested names" className="flex flex-wrap gap-2">
                    {ASSISTANT_NAMES.map((n) => (
                      <button key={n} type="button" aria-pressed={name === n} disabled={saving} onClick={() => void pickName(n)} data-testid={`setup-name-${n}`}
                        className={`min-h-11 rounded-full border px-4 text-[15px] font-medium ${name === n ? 'border-primary bg-primary text-white' : 'border-border bg-white text-ink hover:bg-hover'}`}>{n}</button>
                    ))}
                  </div>
                );
              }
              if (part.block === 'pictures') {
                return (
                  <div key={part.key} role="group" aria-label="Pictures" className="flex flex-wrap gap-2.5">
                    {AGENT_AVATAR_PRESETS.map((p) => (
                      <button key={p} type="button" aria-label={`Picture: ${p}`} aria-pressed={picture === p} onClick={() => void pickPicture(p)} data-testid={`setup-picture-${p}`}
                        className={`h-12 w-12 overflow-hidden rounded-xl p-0 ${picture === p ? 'ring-2 ring-primary ring-offset-2' : ''}`}>
                        <img src={agentAvatarUrl(p)} alt="" width={48} height={48} />
                      </button>
                    ))}
                  </div>
                );
              }
              return (
                <div key={part.key}>
                  <PrimaryButton onClick={onDone} testid="setup-assistant-continue">Continue</PrimaryButton>
                </div>
              );
            }
            const full = (part.bold ?? '') + part.text;
            const text = full.slice(0, n);
            const bold = text.slice(0, (part.bold ?? '').length);
            const rest = text.slice(bold.length);
            const listItem = /^l\d$/.test(part.key);
            return (
              <p key={part.key} className={`m-0 text-[15px] leading-relaxed ${listItem ? 'pl-4' : ''}`}>
                {listItem && '• '}
                {bold && <b>{bold}</b>}
                {rest}
                {!done && <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle" />}
              </p>
            );
          })}
          <ErrorText error={error} />
        </div>
        <form
          className="flex gap-2 border-t border-hairline p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name) void pickName(draft);
          }}
        >
          <label htmlFor="cos-msg" className="sr-only">Message {title}</label>
          <input id="cos-msg" className="h-11 min-w-0 flex-1 rounded-[10px] border border-border px-3 text-[15px]" value={draft} disabled={!!name || saving}
            placeholder={name ? `${name} is set up` : 'Type a name for me…'} onChange={(e) => setDraft(e.target.value)} data-testid="setup-name-input" />
          <button type="submit" disabled={!!name || !draft.trim() || saving} className="h-11 rounded-[10px] bg-primary px-4 font-semibold text-white disabled:opacity-50">Send</button>
        </form>
      </div>
      {name && !picture && (
        <button type="button" className="self-start text-sm text-muted underline" onClick={onDone}>Skip the picture</button>
      )}
    </section>
  );
}
