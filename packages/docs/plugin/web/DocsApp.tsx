// The app as shown in ChatGPT: the library of files, or one document, Markdown document, presentation or
// spreadsheet open in its editor, or a stored PDF or video in the viewer.
// Which file is open is shared with the server, so the model's tools act on it and "open my plan" in the
// composer switches the editor to it.
import { useEffect, useRef, useState } from 'react';
import { DeckWorkbench } from './DeckWorkbench.tsx';
import { Editor } from './Editor.tsx';
import { FileViewer, PICTURE_CHANGED_EVENT } from './FileViewer.tsx';
import { runImageJob } from './imageJobs.ts';
import { Library } from './Library.tsx';
import { MarkdownWorkbench } from './MarkdownWorkbench.tsx';
import { SheetWorkbench } from './SheetWorkbench.tsx';
import type { AppState, Host, LibraryKind, OpenFile } from './host.ts';

/** How often the app asks the server what changed (the model's edits, a file opened by a tool). */
const POLL_MS = 2500;

type Shown = { kind: LibraryKind; id: string } | null;

export function DocsApp({ host }: { host: Host }) {
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const [remote, setRemote] = useState<OpenFile | null>(null);
  const current = useRef<Shown>(null);

  // What showed the app decides what it opens with; then stay in step with the server.
  useEffect(() => {
    const off = host.onInitial((s) => {
      if (s.open !== undefined) {
        current.current = s.open ? { kind: s.open.kind, id: s.open.id } : null;
        setShown(current.current);
      }
    });
    const t = setTimeout(() => setShown((d) => (d === undefined ? null : d)), 1500);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [host]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await host.call<AppState>('app_state');
        // Taken with the state, so they are this page's to do even if it is on its way out.
        for (const job of s.jobs ?? []) void runImageJob(host, job, (id) => window.dispatchEvent(new CustomEvent(PICTURE_CHANGED_EVENT, { detail: id })));
        if (stop) return;
        setRemote(s.open);
        if (s.open && s.open.id !== current.current?.id) {
          current.current = { kind: s.open.kind, id: s.open.id };
          setShown(current.current);
        }
      } catch {
        // Try again next tick.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [host]);

  const open = async (file: Shown) => {
    current.current = file;
    setShown(file);
    try {
      await host.call('set_open_file', file ? { kind: file.kind, id: file.id } : {});
    } catch {
      // The next cursor report sets it.
    }
  };

  if (shown === undefined) return <div className="page-loading">Loading…</div>;
  if (!shown) return <Library host={host} onOpen={(f) => void open(f)} />;
  if (shown.kind === 'file') return <FileViewer key={shown.id} host={host} id={shown.id} onBack={() => void open(null)} />;
  if (shown.kind === 'deck') return <DeckWorkbench key={shown.id} host={host} id={shown.id} remote={remote} onBack={() => void open(null)} />;
  if (shown.kind === 'sheet') return <SheetWorkbench key={shown.id} host={host} id={shown.id} remote={remote} onBack={() => void open(null)} onOpen={(f) => void open(f)} />;
  if (shown.kind === 'markdown') return <MarkdownWorkbench key={shown.id} host={host} id={shown.id} remote={remote} onBack={() => void open(null)} />;
  return <Editor key={shown.id} host={host} id={shown.id} remote={remote} onBack={() => void open(null)} />;
}
