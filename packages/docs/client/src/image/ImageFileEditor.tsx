// A stored picture being edited: the image editor over the file's bytes, with Save (over the file, keeping the
// version before for one revert), Save a copy (a new file next to it) and Close. Where the bytes come from and
// go is the page's business (`store`): the app's own API on the file page, the plugin's tools in its viewer.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AspBackgroundRemovalLoader, AspEditorHandle } from '@ascentsparksoftware/react-image-editor';
import { ConfirmModal } from '../components/Modal.tsx';
import { setActiveImageEditor } from './activeEditor.ts';
import { editedCopyName, editSize } from './limits.ts';
import { hasTransparency, pngName } from './transparency.ts';

const ImageEditorHost = lazy(() => import('./ImageEditorHost.tsx'));

/** The picture's size in pixels as it was opened and as it is saved (null when it could not be told). */
export interface PictureSizes {
  before: { width: number; height: number } | null;
  after: { width: number; height: number } | null;
}

/** Reading and writing the picture being edited. */
export interface EditedImageStore {
  load(): Promise<Blob>;
  /** Save the edited picture in place of the one opened. A file keeps its type; an embedded picture may change it. */
  replace(image: Blob, sizes: PictureSizes): Promise<void>;
  /** Save the edited picture as a new file with this name, next to the file. Not for an embedded picture. */
  create?(name: string, image: Blob): Promise<void>;
}

export function ImageFileEditor({
  file,
  store,
  onClose,
  backgroundRemovalLoader,
  embedded = false,
}: {
  file: { id: string; filename: string; type: string };
  store: EditedImageStore;
  onClose(): void;
  /** See ImageEditorHost. */
  backgroundRemovalLoader?: AspBackgroundRemovalLoader;
  /** The picture is inside a slide, a document or a cell, not a file: there is only Save, which puts the edited picture there. */
  embedded?: boolean;
}) {
  const [source, setSource] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Said when the picture is too large to be edited at its own size. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [ready, setReady] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const handle = useRef<AspEditorHandle | null>(null);
  /** The picture's size as it was opened. */
  const opened = useRef<{ width: number; height: number } | null>(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    let stop = false;
    (async () => {
      const blob = await storeRef.current.load();
      const bitmap = await createImageBitmap(blob);
      const size = editSize(bitmap.width, bitmap.height);
      const was = `${bitmap.width} × ${bitmap.height}`;
      opened.current = { width: size.width, height: size.height };
      bitmap.close();
      if (stop) return;
      if (size.reduced) setNotice(`This picture (${was}) is larger than the editor works with. It is edited, and saved, at ${size.width} × ${size.height}.`);
      // The editor is told the file's type, whatever the browser made of the response.
      setSource(blob.type === file.type ? blob : new Blob([blob], { type: file.type }));
    })().catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [file.id, file.type]);

  // While the editor is open the assistant's transform_image edits in it instead of the file.
  const onReady = useCallback(
    (h: AspEditorHandle) => {
      handle.current = h;
      setActiveImageEditor({ fileId: file.id, handle: h });
      setReady(true);
    },
    [file.id],
  );
  useEffect(() => () => setActiveImageEditor(null), [file.id]);

  const run = async (what: 'save' | 'copy') => {
    const h = handle.current;
    if (!h || busy) return;
    setBusy(what);
    setError(null);
    try {
      // A JPEG cannot be see-through: where the edit made the picture transparent (a removed background, the
      // corners of a straightened photo) it is saved as a PNG next to the JPEG, which stays as it was.
      const sizes: PictureSizes = { before: opened.current, after: h.engine.getOutputSize() };
      const png = file.type === 'image/jpeg' ? await h.engine.exportImage('png', 100, ['png']) : null;
      if (png && (await hasTransparency(png))) {
        // An embedded picture is stored anew whatever it is, so it simply becomes a PNG.
        if (embedded || !store.create) await store.replace(png, sizes);
        else await store.create(what === 'save' ? pngName(file.filename) : editedCopyName(file.filename, 'image/png'), png);
      } else {
        const blob = await h.exportBlob();
        if (what === 'save' || !store.create) await store.replace(blob, sizes);
        else await store.create(editedCopyName(file.filename), blob);
      }
      // The page shows what was saved, which usually takes this editor away; if it stays, it can be used again.
      setBusy(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const close = () => {
    const engine = handle.current?.engine;
    if (engine && (engine.canUndo || engine.hasCropRegion())) setConfirmClose(true);
    else onClose();
  };

  return (
    <div className="image-editor">
      <div className="html-editor-bar">
        <span className="muted">{error ? <span className="form-error">{error}</span> : (notice ?? (embedded ? 'Save puts the edited picture in place of this one. Undo brings this one back.' : file.type === 'image/jpeg' ? 'Save replaces the picture; the version before it is kept. With a transparent background it is saved as a PNG next to this JPEG.' : 'Save replaces the picture; the version before it is kept.'))}</span>
        <span className="html-editor-space" />
        <button className="btn" disabled={busy !== null} onClick={close}>
          Close
        </button>
        {!embedded && store.create && (
          <button className="btn" disabled={!ready || busy !== null} onClick={() => void run('copy')} title="Keep this picture as it is and save the edited one as a new file next to it">
            {busy === 'copy' ? 'Saving…' : 'Save a copy'}
          </button>
        )}
        <button className="btn primary" disabled={!ready || busy !== null} onClick={() => void run('save')}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="image-editor-stage">
        {source ? (
          <Suspense fallback={<div className="muted">Loading the editor…</div>}>
            <ImageEditorHost source={source} type={file.type} onReady={onReady} onError={setError} backgroundRemovalLoader={backgroundRemovalLoader} />
          </Suspense>
        ) : (
          !error && <div className="muted">Loading…</div>
        )}
      </div>
      {confirmClose && <ConfirmModal title="Close without saving?" message="The changes to this picture have not been saved." confirmText="Discard changes" danger onConfirm={onClose} onClose={() => setConfirmClose(false)} />}
    </div>
  );
}
