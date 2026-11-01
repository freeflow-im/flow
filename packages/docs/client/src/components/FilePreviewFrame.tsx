// The preview of a file by the pointer in the file list: the file's own page (the editor, or the stored
// file's viewer) loaded in a frame and drawn small. The page is told it is a preview (?preview=1, see
// isPreview), so it leaves out its menus, toolbars and side panels and shows only the file. The frame
// takes no focus and no clicks: the list stays where the person is working.
import { useState } from 'react';

/** What the preview is drawn in: 396 × 297 points, 4:3. */
const BOX_W = 396;
const BOX_H = 297;

export function FilePreviewFrame({ href, title, text }: { href: string; title: string; /** Text and cells, which are laid out narrower so they can still be read small; slides and pictures get a wide page. */ text?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const PAGE_W = text ? 800 : 1200;
  const PAGE_H = (PAGE_W * BOX_H) / BOX_W;
  const PREVIEW_SCALE = BOX_W / PAGE_W;
  return (
    <div className="file-preview-frame" style={{ width: BOX_W, height: BOX_H }}>
      <iframe
        src={`${href}${href.includes('?') ? '&' : '?'}preview=1`}
        title={`Preview of ${title}`}
        tabIndex={-1}
        inert
        style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${PREVIEW_SCALE})`, visibility: loaded ? 'visible' : 'hidden' }}
        // The page draws the file a moment after it loads; the wait keeps the half-drawn page out of sight.
        onLoad={() => window.setTimeout(() => setLoaded(true), 350)}
      />
      {!loaded && <div className="spinner file-preview-wait" />}
    </div>
  );
}

/** Whether this page is a file's preview inside the file list (FilePreviewFrame). */
export const isPreview = (): boolean => new URLSearchParams(window.location.search).get('preview') === '1' && window.parent !== window;
