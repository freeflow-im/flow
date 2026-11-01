// A stored file that is plain text (StoredFile.text: UTF-8, which ASCII is, found by looking at its bytes),
// edited as text whatever its name: a log, a config file, source code, a file with no extension. Saved as it is
// typed, as the other editors are (AutoSaver: a moment after the typing stops; ⌘S at once), over the file (the
// server keeps the version before for one undo), with the line endings and byte order mark it had.
// In the desktop app, Tail follows a file that grows, a log say: it asks for the bytes past those it has
// every second, adds them and keeps the end in view (unless the person scrolled up); a file that shrank, or was
// replaced, is read again from the start. The text is read-only meanwhile.
// Find (⌘F) marks the matches over the text, as in the Markdown editor; closing it selects the one shown.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StoredFile } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { AutoSaver, type SaveSource } from '../state/store.ts';
import { FindBox, FindToggle } from '../find/FindBox.tsx';
import { findAll, stepIndex, useFind } from '../find/find.ts';
import { TextareaMatches } from '../markdown/TextareaMatches.tsx';

const BOM = '﻿';
const TAIL_EVERY_MS = 1000;

/** The text of a file's bytes, without its byte order mark, in \n lines; and how it was written. */
function readText(bytes: ArrayBuffer) {
  const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  return { text: body.replace(/\r\n/g, '\n'), crlf: /\r\n/.test(body), bom };
}

/** The text as the AutoSaver sees it: an edit is a new version, to save; what is read from the file is not. */
class TextSource implements SaveSource<string> {
  document = '';
  version = 0;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  edit(next: string): void {
    this.document = next;
    this.version++;
    for (const l of this.listeners) l();
  }
}

export function TextFileEditor({ file, onSaved, canTail = false }: { file: StoredFile; onSaved(file: StoredFile): void; canTail?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How the file was written, so a save keeps it: Windows line ends, a byte order mark.
  const form = useRef({ crlf: false, bom: false });
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [source] = useState(() => new TextSource());
  const [saver] = useState(
    () =>
      new AutoSaver<string>(source, async (body) => {
        const bytes = (form.current.bom ? BOM : '') + (form.current.crlf ? body.replace(/\n/g, '\r\n') : body);
        onSavedRef.current(await api.updateFile(file.id, bytes));
      }),
  );
  const [, setSaveTick] = useState(0);
  useEffect(() => saver.subscribe(() => setSaveTick((t) => t + 1)), [saver]);
  // Leaving the page saves what is waiting. (Not disposed: the saver and its source go with the editor, and StrictMode
  // runs this cleanup once before the editor is used.)
  useEffect(() => () => void saver.flush(), [saver]);
  const dirty = saver.hasUnsavedChanges();
  const edit = (next: string) => {
    setText(next);
    source.edit(next);
  };
  const [tail, setTail] = useState(false);
  // The bytes read so far, where the next ones start.
  const bytesRead = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // Whether the end is in view, so new lines keep it there.
  const atEnd = useRef(true);

  useEffect(() => {
    let gone = false;
    fetch(file.url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
        const bytes = await res.arrayBuffer();
        if (gone) return;
        // The text area works in \n; the file's own line ends come back when it is saved.
        const { text: lf, crlf, bom } = readText(bytes);
        form.current = { crlf, bom };
        bytesRead.current = bytes.byteLength;
        source.document = lf;
        setText(lf);
      })
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [file.url]);

  useEffect(() => {
    if (!tail) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    // A line end or a character may be split between two reads: the bytes after the last whole line wait.
    let rest = new Uint8Array(0);
    // A file that shrank is read whole again.
    let whole = false;
    const show = (next: (text: string) => string) => {
      const el = area.current;
      atEnd.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      // Read from the file, so nothing to save.
      source.document = next(source.document);
      setText(source.document);
    };
    const poll = async () => {
      try {
        const res = await fetch(file.url, { credentials: 'same-origin', cache: 'no-store', headers: whole ? {} : { Range: `bytes=${bytesRead.current}-` } });
        if (gone) return;
        if (res.status === 206) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (gone) return;
          bytesRead.current += bytes.byteLength;
          const all = new Uint8Array(rest.length + bytes.length);
          all.set(rest);
          all.set(bytes, rest.length);
          const cut = all.lastIndexOf(10) + 1;
          rest = all.slice(cut);
          if (cut) {
            const added = new TextDecoder().decode(all.subarray(0, cut)).replace(/\r\n/g, '\n');
            show((t) => t + added);
          }
        } else if (res.status === 416) {
          // Nothing new, or the file is shorter than what was read: it was cut or replaced, so read it all again.
          const size = Number(/\/(\d+)/.exec(res.headers.get('Content-Range') ?? '')?.[1] ?? NaN);
          whole = size < bytesRead.current;
        } else if (res.ok) {
          // The whole file (a server that ignores ranges, or one read again from the start).
          const bytes = await res.arrayBuffer();
          if (gone) return;
          bytesRead.current = bytes.byteLength;
          rest = new Uint8Array(0);
          whole = false;
          const { text: all } = readText(bytes);
          show(() => all);
        } else throw new Error(`Could not read the file (${res.status})`);
        setError(null);
      } catch (e) {
        if (!gone) setError(e instanceof Error ? e.message : String(e));
      }
      if (!gone) timer = setTimeout(() => void poll(), TAIL_EVERY_MS);
    };
    atEnd.current = true;
    void poll();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [tail, file.url]);

  // Keep the end in view as lines come in, and when Tail starts.
  useLayoutEffect(() => {
    const el = area.current;
    if (tail && el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [tail, text]);

  const finder = useFind(text !== null);
  const find = finder.find;
  const starts = useMemo(() => (find && text !== null ? findAll(text, find.query, find.matchCase) : []), [find, text]);
  const current = find && find.current < starts.length ? find.current : -1;
  const searchFor = (patch: { query?: string; matchCase?: boolean }) => {
    if (!find || text === null) return;
    const next = { ...find, ...patch };
    const hits = findAll(text, next.query, next.matchCase);
    // The first match at or after the cursor.
    const from = area.current?.selectionStart ?? 0;
    const at = hits.findIndex((h) => h >= from);
    finder.set({ ...patch, current: hits.length ? (at < 0 ? 0 : at) : -1 });
  };
  const closeFind = () => {
    const ta = area.current;
    const at = current >= 0 ? starts[current] : -1;
    finder.close();
    if (!ta) return;
    // The match shown is selected, ready to type over.
    ta.focus();
    if (at >= 0 && find) ta.setSelectionRange(at, at + find.query.length);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saver.flush();
      }
    };
    // Closing the page with a change not yet saved saves it, and asks first.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!saver.hasUnsavedChanges()) return;
      void saver.flush();
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [saver]);
  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${saver.error ? ` (${saver.error})` : ''}`,
  }[saver.status];

  return (
    <div className="text-file">
      <div className="text-file-bar">
        <span className={`save-status ${saver.status}`}>{saveLabel}</span>
        {canTail && (
          <label className="text-file-tail" title={dirty ? 'Your changes are being saved' : undefined}>
            <input type="checkbox" checked={tail} disabled={dirty || text === null} onChange={(e) => setTail(e.target.checked)} />
            Tail
          </label>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {text === null ? (
        !error && <div className="muted text-file-wait">Loading…</div>
      ) : (
        <div className="text-file-body">
          <textarea
            ref={area}
            className="md-editor text-file-editor"
            value={text}
            readOnly={tail}
            onChange={(e) => edit(e.target.value)}
            spellCheck={false}
            autoFocus
            aria-label={file.filename}
            onKeyDown={(e) => {
              // Tab types a tab, as in any text editor.
              if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const next = `${el.value.slice(0, a)}\t${el.value.slice(b)}`;
              edit(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
            }}
          />
          {find?.query && <TextareaMatches textareaRef={area} text={text} starts={starts} length={find.query.length} current={current} />}
          {find && (
            <FindBox
              query={find.query}
              onQuery={(query) => searchFor({ query })}
              count={starts.length}
              current={current}
              onStep={(dir) => finder.set({ current: stepIndex(current, starts.length, dir) })}
              onClose={closeFind}
              focusSeq={find.focusSeq}
              placeholder="Find in text"
              label="Find in file"
            >
              <FindToggle on={find.matchCase} title="Match case" onClick={() => searchFor({ matchCase: !find.matchCase })}>
                Aa
              </FindToggle>
            </FindBox>
          )}
        </div>
      )}
    </div>
  );
}
