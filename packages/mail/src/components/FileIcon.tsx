// A small icon for an attachment by its kind (lib/preview.ts `fileKind`), as Gmail draws them: a red PDF badge, Word's
// blue W, Excel's green X, PowerPoint's orange P, a red picture or film, and plain icons for the rest.
import { File, FileArchive, FileText, Film, Image, Music } from 'lucide-react';
import { fileKind } from '../lib/preview';
import { cn } from '../lib/utils';

const BADGE: Partial<Record<ReturnType<typeof fileKind>, { label: string; color: string }>> = {
  pdf: { label: 'PDF', color: 'bg-[#ea4335]' },
  word: { label: 'W', color: 'bg-[#4285f4]' },
  excel: { label: 'X', color: 'bg-[#0f9d58]' },
  powerpoint: { label: 'P', color: 'bg-[#f4511e]' },
};

export function FileIcon({ file, className }: { file: { filename: string; mimeType: string }; className?: string }) {
  const kind = fileKind(file);
  const badge = BADGE[kind];
  if (badge) {
    return (
      <span aria-hidden className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] font-bold leading-none text-white', badge.label.length > 1 ? 'text-[6.5px] tracking-[-.02em]' : 'text-[10px]', badge.color, className)}>
        {badge.label}
      </span>
    );
  }
  const Icon = kind === 'image' ? Image : kind === 'video' ? Film : kind === 'audio' ? Music : kind === 'archive' ? FileArchive : kind === 'text' ? FileText : File;
  const color = kind === 'image' || kind === 'video' ? 'text-[#d93025]' : kind === 'audio' ? 'text-[#9334e6]' : kind === 'text' ? 'text-[#4285f4]' : 'text-muted';
  return <Icon aria-hidden className={cn('size-4 shrink-0', color, className)} />;
}
