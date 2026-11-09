// The section pages' parts (docs/specs/workspace-admin.md §3): a card with a title, a row with a label on the left and
// a control on the right, and the controls that save as they change, each with its own error line.
import type { ReactNode } from 'react';

export function Card({ title, intro, children, testid }: { title: string; intro?: string; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-xl border border-hairline bg-white p-5" data-testid={testid}>
      <h2 className="text-base font-semibold">{title}</h2>
      {intro && <p className="mt-1 text-xs text-muted">{intro}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** One setting: its name and a line of help on the left, the control on the right; stacked on a narrow screen. */
export function Row({ label, help, children, testid }: { label: string; help?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6" data-testid={testid}>
      <div className="min-w-0 sm:max-w-sm">
        <div className="text-sm font-medium">{label}</div>
        {help && <div className="mt-0.5 text-xs text-muted">{help}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">{children}</div>
    </div>
  );
}

export const ErrorLine = ({ error, testid }: { error: string | null; testid?: string }) => (error ? <p className="text-xs text-danger" data-testid={testid ?? 'error'}>{error}</p> : null);

export function Select<V extends string>({ value, options, disabled, onChange, testid }: { value: V; options: { value: V; label: string }[]; disabled?: boolean; onChange(v: V): void; testid?: string }) {
  return (
    <select className="rounded-md border border-border bg-white px-2 py-1 text-sm disabled:opacity-50" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as V)} data-testid={testid}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, disabled, onChange, label, testid }: { checked: boolean; disabled?: boolean; onChange(v: boolean): void; label: string; testid?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      {label}
    </label>
  );
}

export function Button({ children, onClick, disabled, kind = 'plain', type = 'button', testid }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'plain' | 'primary' | 'danger' | 'link'; type?: 'button' | 'submit'; testid?: string }) {
  const look =
    kind === 'primary' ? 'rounded-md bg-primary px-3 py-1 text-sm font-semibold text-white hover:bg-primary-deep'
    : kind === 'danger' ? 'rounded-md bg-danger px-3 py-1 text-sm font-semibold text-white hover:opacity-90'
    : kind === 'link' ? 'text-sm text-primary hover:underline'
    : 'rounded-md border border-border bg-white px-3 py-1 text-sm hover:bg-hover';
  return (
    <button type={type} className={`${look} disabled:opacity-50`} onClick={onClick} disabled={disabled} data-testid={testid}>
      {children}
    </button>
  );
}

/** A destructive action's inline confirmation: the question, Yes in red, No. */
export function Confirm({ question, busy, onYes, onNo, testid }: { question: string; busy?: boolean; onYes(): void; onNo(): void; testid?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted" data-testid={testid}>
      <span>{question}</span>
      <Button kind="danger" disabled={busy} onClick={onYes} testid={testid ? `${testid}-yes` : undefined}>
        Yes
      </Button>
      <Button kind="link" disabled={busy} onClick={onNo}>
        No
      </Button>
    </span>
  );
}
