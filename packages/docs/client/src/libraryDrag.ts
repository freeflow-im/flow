// A file of the home page's list being dragged, for the suite's folder tree (components/DocsNav.tsx) to take: the list
// (FileLibrary) and the tree are separate components, and a page's drag carries no object, so the list says here what
// it is dragging, and from which root, and the tree asks. A file dropped on a folder of the tree moves there
// (api.moveToFolder), within its root: another root is a change of who can see it (Share with organization), which is
// the file's menu, not a drag.

/** A root of the tree: the organization's shared files, or the user's own. */
export type DragRoot = 'org' | 'me';

export interface DraggedFile {
  kind: string;
  id: string;
  title: string;
  /** The folder it is in ('' the top). */
  folder: string;
  root: DragRoot;
}

/** The window event after the tree moved a file: the list shows its folder again. */
export const FILE_MOVED = 'docs:file-moved';

let current: DraggedFile | null = null;

export const draggedFile = (): DraggedFile | null => current;
export function setDraggedFile(file: DraggedFile | null): void {
  current = file;
  if (file && typeof window !== 'undefined' && !listening) {
    // A drag is over at any drop in the page, after its handlers ran: a row moved out of the list is gone before its
    // own dragend, which would have said so.
    listening = true;
    const over = () => setTimeout(() => (current = null));
    window.addEventListener('drop', over, true);
    window.addEventListener('dragend', over, true);
  }
}
let listening = false;

/** Whether a folder of the tree (its root and path, '' the top) takes the file: one of its root, not the folder it is in. */
export function takesDrop(file: DraggedFile | null, root: DragRoot, path: string): file is DraggedFile {
  return !!file && file.root === root && file.folder !== path;
}
