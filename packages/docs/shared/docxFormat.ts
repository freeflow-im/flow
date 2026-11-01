// What a Word file (.docx) the desktop app edits in place can hold. The writer (docDocx in
// server/docxExport.ts) keeps the document's text, block styles, lists, marks, pictures, breaks, rules and page
// setup; a video has no place in a Word file (it is written as a link to it), so a document with one is
// stored in the app's own format instead.
import type { Doc, DocJSON } from './doc.ts';

/** The first thing in the document a Word file cannot keep (named for the user), or null when it can be saved as one. */
export function docxProblem(doc: Doc): string | null {
  const hasVideo = (n: DocJSON): boolean => n.type === 'video' || !!n.content?.some(hasVideo);
  return hasVideo(doc.content) ? 'Videos' : null;
}
