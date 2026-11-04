// A preview (/preview/<id>?workspace=, server/previews.ts): a file shown read-only in Docs' own views, with no menus,
// toolbars or panels, to sit in a frame in FreeFlow Mail's attachment overlay. The overlay has the name, Download and
// Save to Docs; this page only draws the file. Escape (and ← / → where they do not move around in the file) is handed
// to the page around it, which closes or steps through the attachments.
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, type PreviewInfo, type PreviewView } from '../api.ts';
import { ReadOnlyDeck, ReadOnlyDoc, ReadOnlySheet } from '../components/ZipBrowser.tsx';
import { MarkdownPreview } from '../markdown/MarkdownPreview.tsx';
import { PdfView } from '../pdf/PdfView.tsx';

const loadMermaid = () => import('mermaid');

const READ_ONLY = 'This is a preview. Save it to Docs to edit it.';

/** The message the overlay listens for: a key pressed in this frame. */
export const PREVIEW_KEY_MESSAGE = 'freeflow-preview-key';

export function PreviewPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const workspace = params.get('workspace');
  const [loaded, setLoaded] = useState<{ preview: PreviewInfo; view: PreviewView } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError(null);
    api.openPreview(id, workspace).then(
      (r) => {
        if (!current) return;
        setLoaded(r);
        document.title = r.preview.filename;
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [id, workspace]);

  // In a frame of the suite's own page: the keys that page acts on. A spreadsheet and a document keep their arrows.
  const kind = loaded?.view.kind;
  useEffect(() => {
    if (window.parent === window) return;
    const onKey = (e: KeyboardEvent) => {
      const arrows = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (kind === 'pdf' || kind === 'deck' || kind === 'markdown');
      if (e.key !== 'Escape' && !arrows) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      window.parent.postMessage({ type: PREVIEW_KEY_MESSAGE, key: e.key }, window.location.origin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind]);

  return (
    <div className="preview-page">
      {error ? (
        <div className="preview-message">{error}</div>
      ) : !loaded ? (
        <div className="preview-message">Opening…</div>
      ) : (
        <PreviewBody preview={loaded.preview} view={loaded.view} workspace={workspace} />
      )}
    </div>
  );
}

function PreviewBody({ preview, view, workspace }: { preview: PreviewInfo; view: PreviewView; workspace: string | null }) {
  switch (view.kind) {
    case 'doc':
      return <ReadOnlyDoc doc={view.doc} />;
    case 'deck':
      return <ReadOnlyDeck deck={view.deck} />;
    case 'sheet':
      return <ReadOnlySheet workbook={view.workbook} refusal={READ_ONLY} />;
    case 'markdown':
      return (
        <div className="zip-markdown">
          <MarkdownPreview text={view.text} loadMermaid={loadMermaid} />
        </div>
      );
    case 'pdf':
      return <PdfView url={workspace ? `${view.url}?workspace=${encodeURIComponent(workspace)}` : view.url} title={preview.filename} />;
    case 'file':
      return <div className="preview-message">No preview available for “{preview.filename}”.</div>;
  }
}
