// A zip file's contents, listed and opened read-only on its file page (server/zipView.ts, client ZipBrowser).
import type { Deck } from './deck.ts';
import type { Doc } from './doc.ts';
import type { Workbook } from './types.ts';

/** A file inside a zip: its path there ("docs/plan.md"), its size unpacked and when it was last changed (a time with no zone, as zips keep it). */
export interface ZipEntry {
  path: string;
  size: number;
  modified: string;
}

/** A Word, Excel or PowerPoint file inside a zip, converted to be shown (its pictures inline). */
export type ZipOfficeView = { kind: 'doc'; doc: Doc; warnings: string[] } | { kind: 'deck'; deck: Deck; warnings: string[] } | { kind: 'sheet'; workbook: Workbook; warnings: string[] };

export const isZipName = (name: string): boolean => /\.zip$/i.test(name);

/** How a file inside a zip is shown, by its name; 'other' is shown as text when it turns out to be text. */
export type ZipEntryKind = 'pdf' | 'image' | 'video' | 'html' | 'markdown' | 'csv' | 'office' | 'other';
export function zipEntryKind(name: string): ZipEntryKind {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  if (/\.(mp4|m4v|mov|webm|ogv)$/i.test(name)) return 'video';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.csv$/i.test(name)) return 'csv';
  if (/\.(docx|pptx|xlsx?)$/i.test(name)) return 'office';
  return 'other';
}
