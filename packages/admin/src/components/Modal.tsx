// A dialog over the page (the Members page's Add member form and an external agent's connection steps): a title, the
// content, closed by its ✕, Escape or a click outside. The first form control takes the focus.
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, onClose, children, testid, wide }: { title: string; onClose(): void; children: ReactNode; testid?: string; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=file]), textarea, select')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testid ? `${testid}-backdrop` : undefined}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} rounded-xl border border-hairline bg-white p-5 shadow-xl`} data-testid={testid}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="rounded-md p-1 text-muted hover:bg-hover" onClick={onClose} data-testid={testid ? `${testid}-close` : undefined}>
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
