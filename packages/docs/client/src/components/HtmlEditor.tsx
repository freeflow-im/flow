// A stored web page being edited in place: click an element to select it, then edit its text, delete it or
// change its colors. The page is in the same kind of sandboxed frame as HtmlPreview; the editing itself is done
// by the script of htmlEdit.ts inside the frame, which posts each new version of the page here to be saved.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StoredFile } from '../../../shared/types.ts';
import { FILE_CHANGED_EVENT } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { editableHtml, type FrameCommand, type FrameMessage } from '../htmlEdit.ts';

/** How long after the last change the page is saved; a drag in a color picker is one save and one undo step. */
const SAVE_DELAY_MS = 500;

type Selection = Extract<FrameMessage, { ff: 'select' }>;

export function HtmlEditor({ file, onSelect, onSaved }: { file: StoredFile; onSelect(html: string | null): void; onSaved(file: StoredFile): void }) {
  /** The HTML the frame was last loaded with; edits happen inside the frame and do not reload it. */
  const [loaded, setLoaded] = useState<{ html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [undoable, setUndoable] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  /** The page as it is now, the versions before it, and the save that is waiting. */
  const current = useRef('');
  const past = useRef<string[]>([]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let stop = false;
    fetch(file.url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
        const text = await res.text();
        if (stop) return;
        current.current = text;
        setLoaded({ html: text });
      })
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [file.url]);

  const save = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    api.updateFile(file.id, current.current).then(onSaved, (e: Error) => setError(e.message));
  }, [file.id, onSaved]);
  // Leaving the editor saves what is waiting.
  useEffect(
    () => () => {
      if (timer.current !== null) save();
    },
    [save],
  );

  // When the assistant rewrites the file the page reloads with its version; a save still waiting would undo it.
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== file.id || timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
    };
    window.addEventListener(FILE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(FILE_CHANGED_EVENT, changed);
  }, [file.id]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as FrameMessage | null;
      if (!frame.current || e.source !== frame.current.contentWindow || !m) return;
      if (m.ff === 'select') {
        setSel(m);
        onSelect(m.html);
      } else if (m.ff === 'deselect') {
        setSel(null);
        onSelect(null);
      } else if (m.ff === 'change' && typeof m.html === 'string' && m.html !== current.current) {
        // The first change after a save starts an undo step.
        if (timer.current === null) {
          past.current.push(current.current);
          setUndoable(past.current.length);
        } else window.clearTimeout(timer.current);
        current.current = m.html;
        timer.current = window.setTimeout(save, SAVE_DELAY_MS);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect, save]);
  useEffect(() => () => onSelect(null), [onSelect]);

  const send = (cmd: FrameCommand) => frame.current?.contentWindow?.postMessage(cmd, '*');
  const undo = () => {
    // A change still waiting to be saved is undone by not saving it.
    const html = past.current.pop();
    if (html === undefined) return;
    setUndoable(past.current.length);
    current.current = html;
    setSel(null);
    onSelect(null);
    setLoaded({ html });
    save();
  };

  const srcDoc = useMemo(() => (loaded ? editableHtml(loaded.html, crypto.randomUUID()) : ''), [loaded]);

  if (error) return <div className="form-error">{error}</div>;
  if (!loaded) return <div className="muted">Loading…</div>;
  return (
    <div className="html-editor">
      <div className="html-editor-bar">
        {sel ? (
          <>
            <code className="html-editor-label" title="The selected element. The assistant is told about it with your next message.">
              &lt;{sel.label}&gt;
            </code>
            <button className="btn" onClick={() => send({ ff: 'cmd', cmd: 'edit' })} title="Edit the element's text (double-click or Enter)">
              Edit text
            </button>
            <label title="Text color">
              Text
              <input type="color" value={sel.color} onChange={(e) => send({ ff: 'cmd', cmd: 'color', value: e.target.value })} />
            </label>
            <label title="Background color">
              Background
              <input type="color" value={sel.background} onChange={(e) => send({ ff: 'cmd', cmd: 'background', value: e.target.value })} />
            </label>
            <button className="btn" disabled={!sel.deletable} onClick={() => send({ ff: 'cmd', cmd: 'delete' })} title="Delete the element (Delete)">
              Delete
            </button>
          </>
        ) : (
          <span className="muted">Click an element to select it. Double-click to edit its text. Changes save by themselves. The page’s scripts are off here; Preview runs them.</span>
        )}
        <span className="html-editor-space" />
        <button className="btn" disabled={!undoable} onClick={undo}>
          Undo
        </button>
      </div>
      {/* Reloaded only by a load or an undo, which make a new `loaded`. */}
      <iframe ref={frame} className="file-preview html-preview" title={file.filename} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />
    </div>
  );
}
