import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Modal({ title, children, onClose, className }: { title: string; children: ReactNode; onClose: () => void; /** For a dialog that is not the usual narrow prompt. */ className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function PromptModal(props: {
  title: string;
  label: string;
  initial: string;
  confirmText: string;
  validate?: (v: string) => string | null;
  /** Longest value allowed; 200 when not given. */
  maxLength?: number;
  placeholder?: string;
  onConfirm: (v: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = async () => {
    const problem = props.validate?.(value) ?? (value.trim() ? null : `${props.label} cannot be empty.`);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await props.onConfirm(value.trim());
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{props.label}</span>
          <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} maxLength={props.maxLength ?? 200} placeholder={props.placeholder} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {props.confirmText}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmModal(props: {
  title: string;
  message: ReactNode;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p className="modal-message">{props.message}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          ref={ref}
          className={`btn ${props.danger ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onConfirm();
              props.onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {props.confirmText}
        </button>
      </div>
    </Modal>
  );
}
