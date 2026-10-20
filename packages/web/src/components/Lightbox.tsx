// The chrome every full-window overlay shares (#232).
//
// It started as three copies of the same markup — image, video, and then the
// diagram zoom this file was extracted for. What differs between them is only
// what the overlay can *do*: an uploaded file has Open external and Download,
// an inline diagram has no file behind it and offers Copy source instead. So
// the shell owns the backdrop, the button row, the caption and the two ways
// out (Escape, click outside), and the caller passes its own buttons in.
import { useEffect, useRef, type ReactNode } from 'react';
import { useBackToClose } from '../lib/useBackToClose';

/** One overlay button. Callers only vary the glyph and what it does. */
export function LightboxButton({
  testId,
  title,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-testid={testId}
      className="flex h-8 min-w-8 items-center justify-center rounded-lg bg-white/15 px-2 text-white hover:bg-white/30"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function LightboxShell({
  testId,
  actions,
  caption,
  onClose,
  children,
}: {
  /** Root test id; the close button gets `${testId}-close`. */
  testId: string;
  actions?: ReactNode;
  caption?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  useBackToClose(onClose); // the Android shell's Escape

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Take focus off whatever opened this. It matters for the diagram overlay
    // (#232), which is opened by a click *inside* an iframe: leave focus there
    // and every later keystroke, Escape included, is delivered to that frame
    // and this listener never hears it.
    root.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={root}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/75 outline-none"
      onMouseDown={onClose}
    >
      <div className="absolute top-4 right-5 flex gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
        {actions}
        <LightboxButton testId={`${testId}-close`} title="Close" onClick={onClose}>
          ✕
        </LightboxButton>
      </div>
      {/* `contents` so the content still lays out as a direct flex child —
          this wrapper exists only to keep a click on the content from
          reaching the backdrop's close handler. */}
      <div className="contents" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
      {caption !== undefined && (
        <span
          className="mt-3 max-w-[80vw] truncate text-xs text-white/70"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {caption}
        </span>
      )}
    </div>
  );
}
