// The image editor over the page, for a picture that is inside something: a slide, a document, a cell. Such a
// picture is never rewritten. Save hands the edited picture to the page, which stores it as a new image and
// puts it where the old one was, so undo there brings the old one back.
import { useEffect, useRef, useState } from 'react';
import type { AspBackgroundRemovalLoader } from '@ascentsparksoftware/react-image-editor';
import { EDITABLE_IMAGE_TYPES } from '../../../shared/types.ts';
import { IMAGE_DIALOG_CLASS } from './dialogOpen.ts';
import { ImageFileEditor, type PictureSizes } from './ImageFileEditor.tsx';

/** The picture at an address, as bytes: ours with the session, anyone else's only if their server allows it. */
async function fetchPicture(src: string): Promise<Blob> {
  const own = src.startsWith('/') || src.startsWith('data:');
  let res: Response;
  try {
    res = await fetch(src, own ? { credentials: 'same-origin' } : { mode: 'cors' });
  } catch {
    throw new Error('This picture is on another site that does not let it be edited here. Download it and insert it again to edit it.');
  }
  if (!res.ok) throw new Error(`Could not read the picture (${res.status}).`);
  const blob = await res.blob();
  if (!EDITABLE_IMAGE_TYPES.includes(blob.type)) throw new Error(blob.type === 'image/gif' ? 'A GIF cannot be edited (it would lose its animation).' : 'Only PNG, JPEG and WebP pictures can be edited.');
  return blob;
}

export function ImageEditDialog({ src, name, onSave, onClose, backgroundRemovalLoader }: { /** See ImageEditorHost: the page passes it where the model can be loaded. */ backgroundRemovalLoader?: AspBackgroundRemovalLoader; /** The picture's address. */ src: string; /** What to call it in messages. */ name: string; /** The edited picture, to store and put in place; the dialog closes when this resolves. */ onSave(image: Blob, sizes: PictureSizes): Promise<void>; onClose(): void }) {
  const [source, setSource] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    setSource(null);
    setError(null);
    fetchPicture(src).then(
      (blob) => !stop && setSource(blob),
      (e: Error) => !stop && setError(e.message),
    );
    return () => {
      stop = true;
    };
  }, [src]);

  // The dialog takes the keyboard from the page: a Backspace meant for a layer of the picture must not reach
  // a document's editor, which still has the picture's block selected.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement && !root.current?.contains(document.activeElement)) document.activeElement.blur();
    root.current?.focus();
  }, []);

  return (
    <div ref={root} tabIndex={-1} className={IMAGE_DIALOG_CLASS} role="dialog" aria-modal="true" aria-label="Edit image">
      <div className="image-edit-dialog-panel">
        {source ? (
          <ImageFileEditor
            file={{ id: src, filename: name, type: source.type }}
            embedded
            store={{
              load: async () => source,
              replace: async (image, sizes) => {
                await onSave(image, sizes);
                onClose();
              },
            }}
            backgroundRemovalLoader={backgroundRemovalLoader}
            onClose={onClose}
          />
        ) : (
          <div className="image-edit-dialog-wait">
            {error ? <div className="form-error">{error}</div> : <div className="muted">Loading…</div>}
            {error && (
              <button className="btn" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
