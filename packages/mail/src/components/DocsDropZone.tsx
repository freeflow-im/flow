// Where a Docs file dragged from the side panel can land outside a composer (docs/specs/side-panel.md §7): the open
// conversation, which answers it with the file. The composer takes its own drops first (ComposeForm.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { hasFlowRef, readFlowRef, whenDragEnds } from '@flow/suite-bar';
import { docsFileOfRef } from '../lib/docsLink';
import type { DocsFile } from '../lib/docsFiles';
import { cn } from '../lib/utils';

export function DocsDropZone({ label, onDrop, className, children }: { label: string; onDrop: ((file: DocsFile) => void) | null; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  // The highlight goes when the drag is over, wherever it ends (a composer inside takes its own drops).
  useEffect(() => (over ? whenDragEnds(() => setOver(false)) : undefined), [over]);
  if (!onDrop) return <div className={className}>{children}</div>;
  return (
    <div
      className={cn('relative', className)}
      onDragOverCapture={(e) => {
        // Over a composer, the drop is the composer's (it adds the file to what is being written): no reply highlight.
        if ((e.target as Element | null)?.closest?.('[data-composer]')) setOver(false);
      }}
      onDragOver={(e) => {
        if (!hasFlowRef(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const ref = readFlowRef(e.dataTransfer);
        if (ref?.app !== 'docs') return;
        e.preventDefault();
        onDrop(docsFileOfRef(ref));
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-20 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-selected-blue/80 text-sm font-medium text-primary">
          {label}
        </div>
      )}
    </div>
  );
}
