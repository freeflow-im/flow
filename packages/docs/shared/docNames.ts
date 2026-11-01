// A document's title in the desktop app is its file's name, extension and all ("Plan.docx", "notes.md"): the
// app never hides an extension. On the web a document has no file, and its title no extension. What is made from
// a title (an export, a PDF, a copy, the title inside an Office file) takes it without the document's extension.

const DOC_EXT = /\.(docx|pptx|xlsx|csv|md|markdown|ffdoc|ffslides|ffsheet)$/i;

/** A document's title without its file's extension. */
export const titleBase = (title: string): string => title.replace(DOC_EXT, '').trim() || title;

/** The name of a file of type `ext` (no dot) made from a document titled `title`. */
export const nameWithExt = (title: string, ext: string): string => `${titleBase(title)}.${ext}`;

const SCRATCH_NAME = 'Scratch pad';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A new scratch pad's name: "Scratch pad.md", then the day it was made ("Scratch pad-oct05.md", "Scratch pad-oct05-2.md"). */
export function scratchPadName(taken: (name: string) => boolean, now = new Date()): string {
  if (!taken(`${SCRATCH_NAME}.md`)) return `${SCRATCH_NAME}.md`;
  const day = `${SCRATCH_NAME}-${MONTHS[now.getMonth()]}${String(now.getDate()).padStart(2, '0')}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${day}.md` : `${day}-${n}.md`;
    if (!taken(name)) return name;
  }
}
