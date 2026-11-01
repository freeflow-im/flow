// Importing a file's bytes into an account, whatever they are: a Word document, PowerPoint presentation, Excel
// workbook, CSV or Markdown file becomes a file the app edits; a PDF, video, picture or web page is stored as
// it is and shown in the viewer, and any other plain text file (YAML, JSON, a config or source file) as it is
// too, edited in the text editor. Used by the plugin's import_file (a file attached in the chat) and by both
// assistants' import_file for a file at a web address.
import { CsvError, MAX_CSV_CHARS } from '../shared/csv.ts';
import { validateDeck } from '../shared/deck.ts';
import { validateDoc } from '../shared/doc.ts';
import { markdownTitle, MAX_MARKDOWN_CHARS, newMarkdownDoc } from '../shared/markdown.ts';
import { fileTypeOf, HTML_TYPE, isHtmlName, MAX_TEXT_EDIT_BYTES, MAX_VIDEO_BYTES, videoTypeOf, type SheetMeta, type StoredFile } from '../shared/types.ts';
import { importDocx, isDocx } from './docxImport.ts';
import { looksLikeText, type FileStore } from './files.ts';
import type { ImageStore } from './images.ts';
import { isPdf, MAX_PDF_BYTES } from './pdfMarkdown.ts';
import { importPptx, isPptx } from './pptxImport.ts';
import { validateWorkbook, type SheetStore } from './sheets.ts';
import { importExcel, ImportError } from './xlsxImport.ts';

/** A file that cannot be imported, with a reason to tell the user. */
export class ImportFileError extends Error {}

/** The largest file that can be imported: videos and PDFs are stored as they are, so they may be bigger. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export { MAX_PDF_BYTES };
export function importLimit(name: string | undefined): number {
  if (name && videoTypeOf(name)) return MAX_VIDEO_BYTES;
  return /\.pdf$/i.test(name ?? '') ? MAX_PDF_BYTES : MAX_IMPORT_BYTES;
}

/** The image type from its first bytes (attachments and web addresses do not give a reliable type). */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** The text of a text file (UTF-8, without a byte order mark); refuses bytes that are not text. */
function textOf(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ImportFileError('This file is not a text file.');
  return bytes.toString('utf8').replace(/^﻿/, '');
}

/**
 * The name to import a file from the web under: the title the assistant gave, with the extension of the name
 * the address gave (which says what a text file is), or that name when there is no title.
 */
export function webImportName(fetchedName: string, title: string | undefined): string | undefined {
  const t = title?.trim().replace(/[\\/\u0000-\u001f]/g, '_');
  if (!t) return fetchedName || undefined;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(fetchedName)?.[0] ?? '';
  return t.toLowerCase().endsWith(ext.toLowerCase()) ? t : `${t}${ext}`;
}

export interface ImportStores {
  sheets: SheetStore;
  images: ImageStore;
  files: FileStore;
}

/** What an import made: a document, Markdown file, presentation or spreadsheet (`sheet`), or a stored file (`file`). */
export type Imported = { sheet: SheetMeta; file?: undefined; warnings: string[] } | { file: StoredFile; sheet?: undefined; warnings: string[] };

/**
 * Import a file for a user. The kind comes from the bytes where they tell (the name is not trusted for that),
 * and from the name for the text formats. Pictures inside a Word or PowerPoint file are stored for the account.
 */
export async function importBytes(stores: ImportStores, userId: string, bytes: Buffer, name: string | undefined, title: string | undefined): Promise<Imported> {
  const baseTitle = (title?.trim() || name?.replace(/\.[^.]+$/, '').trim() || '').slice(0, 200);
  const storeImage = (type: string, data: Buffer) => stores.images.create(userId, type, data);
  const stored = async (filename: string, type: string): Promise<Imported> => ({ file: await stores.files.create(userId, filename, type, bytes), warnings: [] });
  // A PDF, a video, an image or a web page is kept as it is and shown in the app's viewer.
  const fileName = (name ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
  const videoType = videoTypeOf(fileName);
  if (videoType) {
    if (bytes.length > MAX_VIDEO_BYTES) throw new ImportFileError(`This video is too large to import (${MAX_VIDEO_BYTES / 1024 / 1024} MB maximum).`);
    return stored(fileName, videoType);
  }
  if (isPdf(bytes)) {
    if (bytes.length > MAX_PDF_BYTES) throw new ImportFileError(`This PDF is too large to import (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`);
    return stored(/\.pdf$/i.test(fileName) ? fileName : `${fileName || baseTitle || 'document'}.pdf`, 'application/pdf');
  }
  if (bytes.length > MAX_IMPORT_BYTES) throw new ImportFileError(`This file is too large to import (${MAX_IMPORT_BYTES / 1024 / 1024} MB maximum).`);
  // A web page (by its name, or by how it starts) is kept as it is too, and shown in a sandboxed frame.
  if (isHtmlName(fileName) || /^\s*(<!doctype html|<html[\s>])/i.test(bytes.subarray(0, 1024).toString('utf8').replace(/^﻿/, ''))) {
    textOf(bytes);
    return stored(isHtmlName(fileName) ? fileName : `${fileName || baseTitle || 'page'}.html`, HTML_TYPE);
  }
  const imageType = sniffImageType(bytes);
  if (imageType) return stored(/\.(png|jpe?g|gif|webp)$/i.test(fileName) ? fileName : `${fileName || baseTitle || 'image'}.${IMAGE_EXT[imageType]}`, imageType);
  try {
    if (await isDocx(bytes)) {
      const { doc, warnings } = await importDocx(bytes, storeImage);
      const problem = validateDoc(doc);
      if (problem) throw new ImportFileError(problem);
      return { sheet: await stores.sheets.createDoc(userId, baseTitle || 'Imported document', doc), warnings };
    }
    if (await isPptx(bytes)) {
      const { deck, warnings } = await importPptx(bytes, storeImage);
      const problem = validateDeck(deck);
      if (problem) throw new ImportFileError(problem);
      return { sheet: await stores.sheets.createDeck(userId, baseTitle || 'Imported presentation', deck), warnings };
    }
    // Text formats are told by their name: a CSV file stays a CSV file and a Markdown file a Markdown file.
    if (/\.csv$/i.test(name ?? '')) {
      const csv = textOf(bytes);
      if (csv.length > MAX_CSV_CHARS) throw new ImportFileError('This file is too large to import (10 MB maximum).');
      return { sheet: await stores.sheets.createCsv(userId, baseTitle || 'Imported CSV', csv), warnings: [] };
    }
    if (/\.(md|markdown)$/i.test(name ?? '')) {
      const text = textOf(bytes);
      if (text.length > MAX_MARKDOWN_CHARS) throw new ImportFileError('This file is too large to import (5 MB maximum).');
      return { sheet: await stores.sheets.createMarkdown(userId, title?.trim().slice(0, 200) || markdownTitle(text, fileName), newMarkdownDoc(text)), warnings: [] };
    }
    if (/\.xlsx?$/i.test(name ?? '') || bytes.subarray(0, 2).toString('latin1') === 'PK' || bytes[0] === 0xd0) {
      const { workbook, warnings } = await importExcel(bytes);
      const problem = validateWorkbook(workbook);
      if (problem) throw new ImportFileError(problem);
      return { sheet: await stores.sheets.create(userId, baseTitle || 'Imported spreadsheet', workbook), warnings };
    }
  } catch (e) {
    if (e instanceof ImportError || e instanceof CsvError) throw new ImportFileError(e.message);
    throw e;
  }
  // Any other text (YAML, JSON, a config or source file) is kept as it is, to read and edit as text.
  if (bytes.length <= MAX_TEXT_EDIT_BYTES && looksLikeText(bytes)) {
    const named = fileName || `${baseTitle || 'text'}.txt`;
    return stored(named, fileTypeOf(named) ?? 'text/plain');
  }
  throw new ImportFileError(
    `This type of file${name ? ` (${fileName})` : ''} cannot be imported. Only Word documents (.docx), PowerPoint presentations (.pptx), Excel workbooks (.xlsx), CSV files (.csv), Markdown files (.md), PDFs (.pdf), web pages (.html), videos (.mp4, .mov, .webm), images (PNG, JPEG, GIF, WebP) and plain text files (.txt, .yaml, .json, ...) can be imported.`,
  );
}
