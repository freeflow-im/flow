// The Scratch pad tile on the home page: a menu of the scratch pads in ~/.config/mcp-docs, last
// changed first, and New scratchpad, which makes one ("Scratch pad.md", then one named for the day) and opens it.
// A scratch pad outside the open folder moves the window to that folder, as Open file by path… does, with its
// breadcrumbs leading back to the folder shown here (listing.ts' returnTo).
// On the web the scratch pads are the Markdown documents in the Scratch pads folder of the user's files.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { scratchPadName, titleBase } from '../../../shared/docNames.ts';
import { api } from '../api.ts';

/** The web's folder of scratch pads, at the top of the user's files. */
const WEB_SCRATCH_FOLDER = 'Scratch pads';

/** The web's scratch pads, last changed first (none before the folder is made). */
async function webPads(): Promise<{ name: string; id: string }[]> {
  const { docs } = await api.library(WEB_SCRATCH_FOLDER).catch(() => ({ docs: [] }));
  return docs
    .filter((d) => d.kind === 'markdown')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((d) => ({ name: d.title, id: d.id }));
}

/** A new scratch pad on the web, in its folder (made the first time): its id. */
async function newWebPad(): Promise<string> {
  const pads = await webPads();
  if (!pads.length) await api.createFolder('', WEB_SCRATCH_FOLDER).catch(() => {}); // There already, but empty.
  const titles = new Set(pads.map((p) => p.name));
  const title = titleBase(scratchPadName((n) => titles.has(titleBase(n))));
  return (await api.createMarkdown(title, '', WEB_SCRATCH_FOLDER)).doc.id;
}

export function ScratchPadTile({ local, folder, onError }: { local: boolean; folder: string; onError(message: string): void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pads, setPads] = useState<{ name: string; id?: string }[] | null>(null);

  useEffect(() => {
    if (!open) return;
    (local ? api.scratchPads().then((r) => r.pads) : webPads()).then(
      (list) => setPads(list),
      () => setPads([]),
    );
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  const openPad = (name?: string, id?: string) => {
    setOpen(false);
    if (!local) {
      (id ? Promise.resolve(id) : newWebPad()).then(
        (pad) => navigate(`/md/${pad}`),
        (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    api.openScratchPad(name, folder).then(
      (res) => res.file !== undefined && navigate(`/open?file=${encodeURIComponent(res.file)}`),
      (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <div className="tile-box">
      <button
        className="new-sheet-tile help-tile scratch-tile"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3h9l3 3v15H6zM9 10h6M9 14h6M9 18h3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="help-tile-title">Scratch pad</span>
        <span className="help-tile-sub">
          Jot something down <span aria-hidden="true">▾</span>
        </span>
      </button>
      {open && (
        <div className="dropdown tile-menu" role="menu">
          {pads?.map((p) => (
            <button key={p.id ?? p.name} role="menuitem" onClick={() => openPad(p.name, p.id)}>
              {p.name}
            </button>
          ))}
          {!!pads?.length && <div className="menu-sep" role="separator" />}
          <button role="menuitem" onClick={() => openPad()}>
            New scratchpad
          </button>
        </div>
      )}
    </div>
  );
}
