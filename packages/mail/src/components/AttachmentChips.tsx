// A list row's attachments, as Gmail shows them under the subject: a few rounded chips (the file's icon and name) and
// "+N" for the rest. A chip opens that file in the preview overlay (AttachmentPreview) without opening the message, and
// its click and keys are its own, not the row's. How many chips fit is by the list's width (the list is a size container,
// `@container`), so a narrow list shows fewer, and the stacked list none at all below 240px (the row's paperclip says it).
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { AttachmentSummary } from '../api';
import { fileSize } from '../lib/format';
import { cn } from '../lib/utils';
import { FileIcon } from './FileIcon';

/** The most chips a row shows; the rest are "+N". */
export const MAX_CHIPS = 3;

// The width bands, as whole class names so Tailwind sees them: chip i is shown from its band up, and "+N" is the one for
// the number of chips shown at that width.
const BANDS = {
  stacked: {
    row: 'hidden @min-[240px]:flex',
    chip: ['flex', 'hidden @min-[400px]:flex', 'hidden @min-[560px]:flex'],
    more: ['flex @min-[400px]:hidden', 'hidden @min-[400px]:flex @min-[560px]:hidden', 'hidden @min-[560px]:flex'],
  },
  dense: {
    row: 'flex',
    chip: ['flex', 'hidden @min-[720px]:flex', 'hidden @min-[900px]:flex'],
    more: ['flex @min-[720px]:hidden', 'hidden @min-[720px]:flex @min-[900px]:hidden', 'hidden @min-[900px]:flex'],
  },
};
/** The stacked list's paperclip for a row with chips: shown only where the chips are not (under 240px). */
export const CHIPS_PAPERCLIP = '@min-[240px]:hidden';

export function AttachmentChips({ files, dense, onOpen, className }: { files: AttachmentSummary[]; dense?: boolean | undefined; onOpen(index: number): void; className?: string }) {
  const bands = BANDS[dense ? 'dense' : 'stacked'];
  const shown = files.slice(0, MAX_CHIPS);
  // A chip's click and Enter/Space are its own: the row neither opens nor takes the key (App.tsx skips a handled key).
  const own = (i: number) => ({
    onClick: (e: ReactMouseEvent) => {
      e.stopPropagation();
      onOpen(i);
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      onOpen(i);
    },
    // Not a drag of the row.
    onDragStart: (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    draggable: false,
  });
  return (
    <div className={cn('min-w-0 items-center gap-2 overflow-hidden', bands.row, className)} role="group" aria-label={`${files.length} attachment${files.length === 1 ? '' : 's'}`}>
      {shown.map((a, i) => (
        <button
          key={a.index}
          type="button"
          {...own(i)}
          title={`${a.filename} (${fileSize(a.size)})`}
          aria-label={`Preview ${a.filename || 'attachment'}, ${fileSize(a.size)}`}
          className={cn(
            'h-8 min-w-0 shrink items-center gap-2 rounded-full border border-[#dadce0] bg-white pr-3 pl-2 text-[13px] font-medium text-[#3c4043] outline-none hover:bg-[#f1f3f4] focus-visible:ring-2 focus-visible:ring-primary/40',
            dense ? 'max-w-[200px]' : 'max-w-[180px]',
            bands.chip[i],
          )}
        >
          <FileIcon file={a} />
          <span className="min-w-0 truncate">{a.filename || 'attachment'}</span>
        </button>
      ))}
      {shown.map((_, i) =>
        files.length > i + 1 ? (
          <button
            key={`more-${i}`}
            type="button"
            {...own(i + 1)}
            title={files.slice(i + 1).map((a) => a.filename).join(', ')}
            aria-label={`${files.length - i - 1} more attachment${files.length - i - 1 === 1 ? '' : 's'}`}
            className={cn('h-8 shrink-0 items-center rounded-full border border-[#dadce0] bg-white px-2.5 text-[13px] font-medium text-[#3c4043] outline-none hover:bg-[#f1f3f4] focus-visible:ring-2 focus-visible:ring-primary/40', bands.more[i])}
          >
            +{files.length - i - 1}
          </button>
        ) : null,
      )}
    </div>
  );
}
