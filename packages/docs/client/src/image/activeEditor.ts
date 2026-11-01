// The image editor the user has open, if any, so the assistant edits in it (and the user watches) instead of
// behind it. Nothing here loads the editor: only its types are used.
import type { AspEditorHandle } from '@ascentsparksoftware/react-image-editor';

let active: { fileId: string; handle: AspEditorHandle } | null = null;

/** Called by the surface that shows an editor, with null when it closes. */
export function setActiveImageEditor(editor: { fileId: string; handle: AspEditorHandle } | null): void {
  active = editor;
}

/** The open editor's handle when it is editing this stored file. */
export function activeImageEditor(fileId: string): AspEditorHandle | null {
  return active?.fileId === fileId ? active.handle : null;
}
