// Markdown documents: a file the user edits as Markdown text and sees rendered GitHub-style. Stored like
// the other kinds (server/sheets.ts, kind "markdown") as JSON holding the text.

export interface MarkdownDoc {
  version: 1;
  /** The Markdown source, exactly as typed. */
  text: string;
}

/** Largest Markdown text accepted by a save or an import, in characters. */
export const MAX_MARKDOWN_CHARS = 5 * 1024 * 1024;

export function newMarkdownDoc(text = ''): MarkdownDoc {
  return { version: 1, text };
}

/** Structural validation of an uploaded Markdown document; returns a problem or null. */
export function validateMarkdownDoc(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return 'Document must be an object';
  const d = doc as MarkdownDoc;
  if (d.version !== 1) return 'Unsupported document version';
  if (typeof d.text !== 'string') return 'Document text must be a string';
  if (d.text.length > MAX_MARKDOWN_CHARS) return 'Document text is too long (5 MB maximum)';
  return null;
}

/** A title for an imported Markdown file: its first heading, or the file name without its extension. */
export function markdownTitle(text: string, fileName: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(text.slice(0, 2000));
  const fromHeading = m?.[1].trim();
  if (fromHeading) return fromHeading.slice(0, 200);
  return fileName.replace(/\.(md|markdown)$/i, '').trim() || 'Imported Markdown';
}
