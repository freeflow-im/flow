// A picture in a Markdown document named by a path relative to the document (`images/chart.png`, as on
// GitHub) is the stored file at that path, read from the document's folder (`GET /api/files/at`).
import { joinFolder } from '../../../shared/folders.ts';

/** Where an editable preview keeps a picture's address as written, since its `src` is rewritten (WysiwygPreview.tsx). */
export const SOURCE_ATTR = 'data-md-src';

/** The root a document is in (the FreeFlow suite: an organization's, and whether it is its shared files), which its pictures are read from too. */
export interface ImageRoot {
  workspaceId?: string;
  shared?: true;
}

/** The query fields that name a document's root, for /api/files requests about its pictures. */
export function rootFields(root: ImageRoot | undefined): Record<string, string> {
  return { ...(root?.workspaceId && { workspace: root.workspaceId }), ...(root?.workspaceId && root.shared && { shared: '1' }) };
}

/** Where the preview loads the picture `src` from, for a document in `folder`; `src` itself when it is not a
 * relative path, or when it leads out of the top folder. */
export function imageSrc(src: string | undefined, folder: string, root?: ImageRoot): string | undefined {
  if (!src || /^[a-z][a-z0-9+.-]*:|^[/#?]/i.test(src)) return src;
  let path: string;
  try {
    path = decodeURIComponent(src.replace(/[?#].*$/, ''));
  } catch {
    return src;
  }
  const parts = folder ? folder.split('/') : [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return src;
      parts.pop();
    } else parts.push(p);
  }
  const name = parts.pop();
  if (!name) return src;
  return `/api/files/at?${new URLSearchParams({ folder: parts.reduce(joinFolder, ''), name, ...rootFields(root) })}`;
}
