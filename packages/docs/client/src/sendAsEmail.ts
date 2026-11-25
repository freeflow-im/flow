// File > Send as email (components/OrganizationActions.tsx): the open file as Mail's composer adds a file from Docs.
import type { MailDocsFile } from '@flow/suite-bar';

const DOC_KINDS: readonly string[] = ['doc', 'sheet', 'deck', 'markdown', 'whiteboard'];

/** A document by its kind (Mail downloads it as Word, Excel, PowerPoint or Markdown); anything else as the stored file it is. */
export function mailDocsFileOf(file: { id: string; title: string; folder?: string; shared?: true; kind?: string; format?: string; type?: string; size?: number }): MailDocsFile {
  const base = { id: file.id, name: file.title, folder: file.folder ?? '', shared: !!file.shared };
  if (file.kind && DOC_KINDS.includes(file.kind)) return { ...base, kind: file.kind as MailDocsFile['kind'], ...(file.format ? { format: file.format } : {}) };
  return { ...base, kind: 'file', ...(file.type ? { type: file.type } : {}), ...(typeof file.size === 'number' ? { size: file.size } : {}) };
}
