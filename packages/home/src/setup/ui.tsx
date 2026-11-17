// Setup's small pieces (docs/specs/onboarding.md): the mark, a step's heading, buttons, avatars and the side card.
import type { ReactNode } from 'react';

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 text-lg font-bold">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h10M4 17h6" /></svg>
      </span>
      FreeFlow
    </div>
  );
}

/** A step's top: "Step 2 of 5", its title and what it is for. */
export function StepHeading({ stepOf, title, children }: { stepOf: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm font-semibold text-primary-deep">{stepOf}</p>
      <h1 className="m-0 text-[32px] font-bold leading-tight tracking-tight sm:text-[40px]">{title}</h1>
      {children}
    </div>
  );
}

export const lead = 'm-0 max-w-[580px] text-[17px] leading-relaxed text-muted';
export const input = 'h-12 w-full rounded-[10px] border border-border bg-white px-3.5 text-base text-ink focus:border-primary focus:outline-none';
export const textarea = 'w-full rounded-[10px] border border-border bg-white px-3.5 py-2.5 text-[15px] leading-relaxed text-ink focus:border-primary focus:outline-none';

export function PrimaryButton({ children, onClick, disabled, testid, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; testid?: string; type?: 'button' | 'submit' }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      className="inline-flex h-12 items-center justify-center gap-2.5 rounded-[10px] bg-primary px-7 font-semibold text-white hover:bg-primary-deep disabled:cursor-default disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled, testid }: { children: ReactNode; onClick?: () => void; disabled?: boolean; testid?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-testid={testid} className="inline-flex h-11 items-center justify-center rounded-[10px] border border-border bg-white px-4 font-semibold text-ink hover:bg-hover disabled:opacity-50">
      {children}
    </button>
  );
}

export function TextButton({ children, onClick, testid }: { children: ReactNode; onClick: () => void; testid?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testid} className="min-h-11 bg-transparent px-1 text-[15px] font-medium text-primary-deep hover:underline">
      {children}
    </button>
  );
}

/** A person's round mark, or an agent's rounded square: the design's one rule for telling them apart. */
export function Mark({ name, agent, src, size = 40, tint }: { name: string; agent?: boolean; src?: string | null; size?: number; tint?: [string, string] }) {
  const [bg, fg] = tint ?? (agent ? ['#ede9fe', '#5b21b6'] : ['#dbeafe', '#1e40af']);
  const radius = agent ? Math.round(size * 0.28) : size / 2;
  if (src) return <img src={src} alt="" width={size} height={size} style={{ borderRadius: radius }} className="flex-none object-cover" />;
  const initials = name.trim().slice(0, agent && name.length > 1 ? 2 : 1);
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: radius, background: bg, color: fg, fontSize: size * 0.38 }} className="inline-flex flex-none items-center justify-center font-bold">
      {initials.charAt(0).toUpperCase() + initials.slice(1)}
    </span>
  );
}

export function SideCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className="flex min-w-0 flex-[1_1_360px] flex-col gap-4 rounded-2xl border border-hairline bg-white p-6">
      {children}
    </aside>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="m-0 text-sm text-danger">{error instanceof Error ? error.message : String(error)}</p>;
}
