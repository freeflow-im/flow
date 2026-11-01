// The Sharing menu's dialog: turn a file's public link on or off, and copy it (server/publicLinks.ts).
import { useEffect, useState } from 'react';
import { api, type SharedKind } from '../api.ts';
import { Modal } from './Modal.tsx';

export function ShareDialog({ kind, id, name, onClose }: { kind: SharedKind; id: string; name: string; onClose: () => void }) {
  /** The link's address, null with none, undefined until the server has answered. */
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.sharing(kind, id).then(
      (r) => current && setUrl(r.url),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [kind, id]);

  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setUrl((await (on ? api.startSharing(kind, id) : api.stopSharing(kind, id))).url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('The link could not be copied. Select it and copy it yourself.');
    }
  };

  return (
    <Modal title="Public link" onClose={onClose}>
      {url === undefined && !error && <p>Loading…</p>}
      {url === null && (
        <p>
          Anyone with the link can view “{name}” without signing in. They cannot change it{kind === 'deck' ? ' or see its speaker notes' : ''}.
        </p>
      )}
      {url && (
        <>
          <p>Anyone with this link can view “{name}”, and always sees its latest version.</p>
          <div className="field">
            <input aria-label="Public link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {url === null && (
          <button className="btn primary" disabled={busy} onClick={() => void change(true)}>
            Create public link
          </button>
        )}
        {url && (
          <>
            <button className="btn" disabled={busy} onClick={() => void change(false)}>
              Stop sharing
            </button>
            <button className="btn primary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
