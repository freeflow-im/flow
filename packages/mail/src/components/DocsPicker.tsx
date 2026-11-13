// "From Docs…" in the composer's attach menu: a dialog that finds files in Docs by name (or lists the ones opened last,
// before anything is typed), lets the person tick one or more, and hands them to the composer to attach (lib/docsFiles.ts).
import { useEffect, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import { useOrganizations } from '../hooks/organization';
import { attachedAs, docsFiles, type DocsFile } from '../lib/docsFiles';
import { fileSize } from '../lib/format';
import { cn } from '../lib/utils';
import { FileIcon } from './FileIcon';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const where = (f: DocsFile) => [f.shared ? 'Organization files' : 'My files', ...(f.folder ? f.folder.split('/') : [])].join(' / ');

export function DocsPicker({ onPick, onClose }: { onPick(files: DocsFile[]): void; onClose(): void }) {
  // The organization the suite bar shows (its first, when none was chosen): its My files and its Organization files.
  const { activeId: workspace, ready } = useOrganizations();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<DocsFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, DocsFile>>(new Map());

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const text = q.trim();
    // Typing waits a moment before asking; the recent files are asked for at once.
    const timer = setTimeout(
      () => {
        setError(null);
        (text ? docsFiles.search(text, workspace) : docsFiles.recent(workspace)).then(
          (found) => !stale && setRows(found),
          (e: unknown) => !stale && (setRows([]), setError(e instanceof Error ? e.message : String(e))),
        );
      },
      text ? 200 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, workspace, ready]);

  const toggle = (f: DocsFile) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(f.id)) next.delete(f.id);
      else next.set(f.id, f);
      return next;
    });
  const attach = () => {
    if (!picked.size) return;
    onPick([...picked.values()]);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>Attach from Docs</DialogTitle>
          <DialogDescription>Documents are attached as Word, Excel, PowerPoint or Markdown files.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border px-2.5">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            autoFocus
            aria-label="Search Docs"
            placeholder="Search files by name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && picked.size) {
                e.preventDefault();
                attach();
              }
            }}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <div className="-mx-2 min-h-[200px] flex-1 overflow-y-auto" role="listbox" aria-multiselectable aria-label="Files in Docs">
          {!q.trim() && rows && rows.length > 0 && <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted">Recent</div>}
          {rows === null ? (
            <div className="flex justify-center py-10 text-muted">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="px-2 py-6 text-center text-sm text-danger">{error}</p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{q.trim() ? 'No files match.' : 'Search for a file by its name.'}</p>
          ) : (
            rows.map((f) => {
              const on = picked.has(f.id);
              const as = attachedAs(f);
              return (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(f)}
                  onDoubleClick={() => (on || toggle(f), onPick([...new Map(picked).set(f.id, f).values()]), onClose())}
                  className={cn('flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover', on && 'bg-selected-blue hover:bg-selected-blue')}
                >
                  <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border border-border', on && 'border-primary bg-primary text-white')}>{on && <Check className="size-3" />}</span>
                  <FileIcon file={{ filename: as.name, mimeType: as.type }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{f.name}</span>
                    <span className="block truncate text-xs text-muted">{where(f)}</span>
                  </span>
                  {f.size !== undefined && f.kind === 'file' && <span className="shrink-0 text-xs text-muted">{fileSize(f.size)}</span>}
                </button>
              );
            })
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={attach} disabled={!picked.size}>
            {picked.size > 1 ? `Attach ${picked.size} files` : 'Attach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
