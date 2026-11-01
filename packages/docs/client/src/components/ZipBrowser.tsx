// A zip file's page: what it holds, folder by folder, and any file in it opened read-only. The folder and the
// file are in the address (?dir=docs, ?entry=docs/plan.md), so Back and the breadcrumbs work as in the list.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { csvToWorkbook } from '../../../shared/csv.ts';
import { SLIDE_W, type Deck } from '../../../shared/deck.ts';
import type { Doc } from '../../../shared/doc.ts';
import { MAX_TEXT_EDIT_BYTES, type StoredFile, type Workbook } from '../../../shared/types.ts';
import { zipEntryKind, type ZipEntry, type ZipOfficeView } from '../../../shared/zip.ts';
import { api } from '../api.ts';
import { SlideView } from '../deck/SlideView.tsx';
import { DocController } from '../doc/controller.ts';
import { DocEditor } from '../doc/DocEditor.tsx';
import { Grid } from '../grid/Grid.tsx';
import { MarkdownPreview } from '../markdown/MarkdownPreview.tsx';
import { SheetController } from '../state/controller.ts';
import { useController } from '../state/useController.ts';
import { formatFileSize } from './FileChip.tsx';
import { FolderIcon, formatWhen, kindIcon } from './FileLibrary.tsx';
import { HtmlPreview } from './HtmlPreview.tsx';

const loadMermaid = () => import('mermaid');

const READ_ONLY = 'This file is inside a zip file and opens read-only. Download it to change it.';

export const zipEntryUrl = (id: string, path: string, download = false) => `/api/files/${encodeURIComponent(id)}/zip/entry?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;

const baseName = (path: string) => path.split('/').pop() ?? path;
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

/** The folders and files directly in `dir` ('' for the top) of a zip's files. */
export function zipFolder(entries: ZipEntry[], dir: string): { folders: string[]; files: ZipEntry[] } {
  const prefix = dir ? `${dir}/` : '';
  const folders = new Set<string>();
  const files: ZipEntry[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) files.push(e);
    else folders.add(rest.slice(0, slash));
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return { folders: [...folders].sort(byName), files: files.sort((a, b) => byName(baseName(a.path), baseName(b.path))) };
}

/** The text of bytes that are text (UTF-8, no NULs, hardly any control characters), else null. */
export function textOf(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return null;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) control++;
  }
  return control > text.length / 100 ? null : text;
}

export function ZipBrowser({ file }: { file: StoredFile }) {
  const [params, setParams] = useSearchParams();
  const entryPath = params.get('entry');
  const dir = entryPath != null ? parentOf(entryPath) : (params.get('dir') ?? '');
  const [entries, setEntries] = useState<ZipEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEntries(null);
    setError(null);
    api.zipEntries(file.id).then((r) => setEntries(r.entries), (e: Error) => setError(e.message));
  }, [file.id]);

  const go = (next: { dir?: string; entry?: string }) =>
    setParams(() => {
      const p = new URLSearchParams();
      if (next.entry != null) p.set('entry', next.entry);
      else if (next.dir) p.set('dir', next.dir);
      return p;
    });

  const entry = entryPath != null ? entries?.find((e) => e.path === entryPath) : undefined;
  const parts = dir ? dir.split('/') : [];
  const { folders, files } = useMemo(() => (entries ? zipFolder(entries, dir) : { folders: [], files: [] }), [entries, dir]);

  return (
    <div className="zip-browser">
      <nav className="zip-crumbs" aria-label="Place in the zip file">
        <button className="link" onClick={() => go({})} disabled={!parts.length && entryPath == null}>
          {file.filename}
        </button>
        {parts.map((name, i) => (
          <span key={i}>
            <span className="zip-crumb-sep">/</span>
            <button className="link" onClick={() => go({ dir: parts.slice(0, i + 1).join('/') })} disabled={i === parts.length - 1 && entryPath == null}>
              {name}
            </button>
          </span>
        ))}
        {entryPath != null && (
          <>
            <span className="zip-crumb-sep">/</span>
            <span>{baseName(entryPath)}</span>
            <span className="zip-read-only">Read-only</span>
            <a className="btn zip-entry-download" href={zipEntryUrl(file.id, entryPath, true)} download={baseName(entryPath)} title="Save this file, taken out of the zip">
              Download file
            </a>
          </>
        )}
      </nav>
      {error ? (
        <div className="form-error">{error}</div>
      ) : !entries ? (
        <div className="muted zip-message">Opening the zip file…</div>
      ) : entryPath != null ? (
        entry ? (
          <ZipEntryView key={entry.path} file={file} entry={entry} />
        ) : (
          <div className="muted zip-message">“{entryPath}” is not in this zip file.</div>
        )
      ) : !folders.length && !files.length ? (
        <div className="muted zip-message">{dir ? 'This folder is empty.' : 'This zip file is empty.'}</div>
      ) : (
        <table className="zip-list">
          <thead>
            <tr>
              <th>Name</th>
              <th className="zip-size">Size</th>
              <th className="zip-when">Modified</th>
            </tr>
          </thead>
          <tbody>
            {folders.map((name) => (
              <tr key={`d:${name}`} className="zip-row" onClick={() => go({ dir: dir ? `${dir}/${name}` : name })}>
                <td>
                  <span className="zip-name">
                    <FolderIcon /> {name}
                  </span>
                </td>
                <td className="zip-size muted">—</td>
                <td className="zip-when" />
              </tr>
            ))}
            {files.map((e) => (
              <tr key={e.path} className="zip-row" onClick={() => go({ entry: e.path })}>
                <td>
                  <span className="zip-name">
                    {kindIcon({ kind: 'file', title: baseName(e.path) })} {baseName(e.path)}
                  </span>
                </td>
                <td className="zip-size muted">{formatFileSize(e.size)}</td>
                <td className="zip-when muted">{formatWhen(e.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type Loaded = { kind: 'text' | 'markdown'; text: string } | { kind: 'sheet'; workbook: Workbook; warnings?: string[] } | ZipOfficeView | { kind: 'none'; why: string };

/** One file from the zip, shown as the app shows that kind of file, but not to be changed. */
function ZipEntryView({ file, entry }: { file: StoredFile; entry: ZipEntry }) {
  const url = zipEntryUrl(file.id, entry.path);
  const name = baseName(entry.path);
  const kind = zipEntryKind(name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (kind === 'pdf' || kind === 'image' || kind === 'video' || kind === 'html') return;
    let gone = false;
    const done = (l: Loaded) => !gone && setLoaded(l);
    const failed = (e: unknown) => !gone && setError(e instanceof Error ? e.message : String(e));
    if (kind === 'office') {
      api.zipOfficeView(file.id, entry.path).then((r) => done(r.view), failed);
    } else if (entry.size > MAX_TEXT_EDIT_BYTES) {
      done({ kind: 'none', why: `This file is too large to show here (${formatFileSize(entry.size)}).` });
    } else {
      fetch(url, { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not read the file (${res.status})`);
          const text = textOf(new Uint8Array(await res.arrayBuffer()));
          if (text == null) return done({ kind: 'none', why: 'This type of file can’t be shown here.' });
          const clean = text.replace(/^﻿/, '');
          done(kind === 'markdown' ? { kind: 'markdown', text: clean } : kind === 'csv' ? { kind: 'sheet', workbook: csvToWorkbook(clean) } : { kind: 'text', text: clean });
        })
        .catch(failed);
    }
    return () => {
      gone = true;
    };
  }, [file.id, entry.path, entry.size, kind, url]);

  if (kind === 'pdf') return <iframe className="file-preview" src={url} title={name} />;
  if (kind === 'image')
    return (
      <div className="zip-image">
        <img src={url} alt={name} />
      </div>
    );
  if (kind === 'video') return <video className="file-preview-video" src={url} controls playsInline />;
  if (kind === 'html') return <HtmlPreview url={url} title={name} />;
  if (error) return <div className="form-error zip-message">{error}</div>;
  if (!loaded) return <div className="muted zip-message">Opening “{name}”…</div>;
  switch (loaded.kind) {
    case 'text':
      return <pre className="zip-text">{loaded.text}</pre>;
    case 'markdown':
      return (
        <div className="zip-markdown">
          <MarkdownPreview text={loaded.text} loadMermaid={loadMermaid} />
        </div>
      );
    case 'sheet':
      return <ReadOnlySheet workbook={loaded.workbook} />;
    case 'doc':
      return <ReadOnlyDoc doc={loaded.doc} />;
    case 'deck':
      return <ReadOnlyDeck deck={loaded.deck} />;
    case 'none':
      return (
        <div className="file-info">
          <div className="file-chip-icon" aria-hidden="true">
            {kindIcon({ kind: 'file', title: name }, 40)}
          </div>
          <h2>{name}</h2>
          <p>{formatFileSize(entry.size)}</p>
          <p className="muted">{loaded.why}</p>
        </div>
      );
  }
}

/** A spreadsheet that can be looked through (selected, scrolled, its tabs switched) but not changed. */
function ReadOnlySheet({ workbook }: { workbook: Workbook }) {
  const [notice, setNotice] = useState<string | null>(null);
  const ctl = useMemo(() => {
    const c = new SheetController(workbook, async () => {});
    c.store.guard = (patches) => (patches.length ? READ_ONLY : null);
    c.onRefused = (reason) => setNotice(reason);
    return c;
  }, [workbook]);
  useEffect(() => () => ctl.dispose(), [ctl]);
  useController(ctl);
  const tabs = ctl.store.workbook.tabs;
  return (
    <div className="zip-sheet">
      {notice && (
        <div className="import-banner" role="status">
          <div>{notice}</div>
          <button className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="grid-area">
        <div className="grid-main">
          <Grid ctl={ctl} notify={setNotice} />
        </div>
      </div>
      {tabs.length > 1 && (
        <div className="zip-sheet-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === ctl.tab.id} className={t.id === ctl.tab.id ? 'active' : ''} onClick={() => ctl.switchTab(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadOnlyDoc({ doc }: { doc: Doc }) {
  const ctl = useMemo(() => new DocController(doc, async () => {}), [doc]);
  useEffect(() => () => ctl.dispose(), [ctl]);
  return (
    <div className="doc-body zip-doc">
      <DocEditor ctl={ctl} readOnly onImageFiles={() => {}} />
    </div>
  );
}

/** A presentation's slides one under another, as wide as the page allows. */
function ReadOnlyDeck({ deck }: { deck: Deck }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(SLIDE_W);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(SLIDE_W * 1.25, el.clientWidth - 48));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="zip-deck" ref={ref}>
      {deck.slides.map((s, i) => (
        <div key={s.id} className="zip-slide">
          <SlideView slide={s} theme={deck.theme} scale={Math.max(0.1, width / SLIDE_W)} />
          <span className="zip-slide-number">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}
