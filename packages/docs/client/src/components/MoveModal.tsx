import { useEffect, useState } from 'react';
import { folderTrail, parentFolder } from '../../../shared/folders.ts';
import { api, type FolderInfo } from '../api.ts';
import { FolderIcon } from './FileLibrary.tsx';
import { Modal } from './Modal.tsx';

/** The name of folder `at`, `rootName` at the top. */
export const folderNameOf = (at: string, rootName: string): string => (at ? folderTrail(at).pop()!.name : rootName);

/** Browse folders from `at`: its parent, then the folders in it, which `list` gives. */
export function FolderBrowser(props: { at: string; setAt(folder: string): void; rootName: string; list(folder: string): Promise<FolderInfo[]>; onError(message: string): void }) {
  const { at, setAt, rootName, list, onError } = props;
  const [folders, setFolders] = useState<FolderInfo[] | null>(null);

  useEffect(() => {
    let stale = false;
    setFolders(null);
    list(at).then(
      (f) => !stale && setFolders(f),
      (e: Error) => !stale && onError(e.message),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  return (
    <div className="folder-picker">
      {at && <button onClick={() => setAt(parentFolder(at))}>← {folderNameOf(parentFolder(at), rootName)}</button>}
      {folders === null ? (
        <div className="muted">Loading…</div>
      ) : folders.length === 0 ? (
        <div className="muted">No folders in “{folderNameOf(at, rootName)}”.</div>
      ) : (
        folders.map((f) => (
          <button key={f.path} onClick={() => setAt(f.path)}>
            <FolderIcon /> {f.name}
          </button>
        ))
      )}
    </div>
  );
}

/** Pick a folder to move a file into, by browsing from the folder it is in. */
export function MoveModal(props: { title: string; from: string; rootName: string; onMove(folder: string): Promise<void>; onClose(): void }) {
  const [at, setAt] = useState(props.from);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const name = folderNameOf(at, props.rootName);
  return (
    <Modal title={`Move “${props.title}”`} onClose={props.onClose}>
      <FolderBrowser at={at} setAt={setAt} rootName={props.rootName} list={async (f) => (await api.library(f)).folders} onError={setError} />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || at === props.from}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await props.onMove(at);
              props.onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          Move to “{name}”
        </button>
      </div>
    </Modal>
  );
}
