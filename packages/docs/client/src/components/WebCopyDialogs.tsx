// Copying between the desktop app's folder and the person's files on the web (docs/web-and-pdf.md; the server's
// side is server/webCopy.ts). Upload to Web… on a file of the folder, and the dialog Download to Folder… opens in
// a Local tab (a Web tab's menu, or Download to MCP Docs from a browser, sends mcpdocs://download to the app,
// which opens the home page with ?webDownload=). A copy is a new file; the two libraries stay separate.
import { useEffect, useState } from 'react';
import { api, ApiError, type CopiedFile, type DownloadFormat } from '../api.ts';
import { FolderBrowser, folderNameOf } from './MoveModal.tsx';
import { Modal } from './Modal.tsx';

type Kind = CopiedFile['kind'];

/** The app's address of a file. */
export const pathOfFile = (kind: Kind, id: string): string => `/${kind === 'deck' ? 'd' : kind === 'doc' ? 'doc' : kind === 'markdown' ? 'md' : kind === 'file' ? 'f' : 's'}/${id}`;

/** A web file's address for the app's Download to Folder… (a Web tab) or Download to MCP Docs (a browser). */
export const downloadLink = (file: { kind: Kind; id: string; title: string }): string => `mcpdocs://download?${new URLSearchParams({ kind: file.kind, id: file.id, title: file.title })}`;

const signedOut = (e: unknown) => e instanceof ApiError && e.code === 'web-signed-out';

/** Signed out of the web: say so, with the way to sign in. */
function SignInFirst({ onClose }: { onClose(): void }) {
  return (
    <>
      <p>Sign in to MCP Docs on the web first: open the Web tab and sign in, then try again.</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <a className="btn primary" href="mcpdocs://switch?to=web" onClick={onClose}>
          Open Web
        </a>
      </div>
    </>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length ? (
    <ul className="copy-warnings">
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  ) : null;
}

/** Upload to Web…: a file of the folder, copied into a folder of the person's web files. */
export function UploadToWebDialog(props: { file: { id: string; title: string }; onClose(): void }) {
  const [state, setState] = useState<'checking' | 'signed-out' | 'pick' | 'busy' | CopiedFile>('checking');
  const [at, setAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.webStatus().then(
      (s) => setState(s.signedIn ? 'pick' : 'signed-out'),
      (e: Error) => (setError(e.message), setState('pick')),
    );
  }, []);

  const upload = async () => {
    setState('busy');
    setError(null);
    try {
      setState(await api.uploadToWeb(props.file.id, at));
    } catch (e) {
      if (signedOut(e)) return setState('signed-out');
      setError(e instanceof Error ? e.message : String(e));
      setState('pick');
    }
  };

  const title = `Upload “${props.file.title}” to the web`;
  if (state === 'checking') return <Modal title={title} onClose={props.onClose}><div className="muted">Checking your web account…</div></Modal>;
  if (state === 'signed-out') return <Modal title={title} onClose={props.onClose}><SignInFirst onClose={props.onClose} /></Modal>;
  if (typeof state === 'object') {
    return (
      <Modal title="Uploaded" onClose={props.onClose}>
        <p>
          “{state.title}” is now in {at ? `“${folderNameOf(at, 'Your files')}”` : 'your files'} on the web. It is a copy: changing one does not change the other.
        </p>
        <Warnings warnings={state.warnings} />
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
          <a className="btn primary" href={`mcpdocs://open-web?${new URLSearchParams({ path: pathOfFile(state.kind, state.id) })}`} onClick={props.onClose}>
            Open on the web
          </a>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={props.onClose}>
      <FolderBrowser at={at} setAt={setAt} rootName="Your files" list={async (f) => (await api.webFolders(f)).folders} onError={setError} />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={state === 'busy'} onClick={() => void upload()}>
          {state === 'busy' ? 'Uploading…' : `Upload to “${folderNameOf(at, 'Your files')}”`}
        </button>
      </div>
    </Modal>
  );
}

const OFFICE: Partial<Record<Kind, { name: string; ext: string }>> = { doc: { name: 'Word', ext: '.docx' }, deck: { name: 'PowerPoint', ext: '.pptx' }, sheet: { name: 'Excel', ext: '.xlsx' } };
const NATIVE_EXT: Partial<Record<Kind, string>> = { doc: '.ffdoc', deck: '.ffslides', sheet: '.ffsheet' };

/** Download to Folder…: a web file, copied into a folder of the open folder in the format chosen. */
export function DownloadFromWebDialog(props: { file: { kind: Kind; id: string; title: string }; rootName: string; startIn: string; onDone(file: CopiedFile): void; onClose(): void }) {
  const { file } = props;
  const [preview, setPreview] = useState<{ formats: DownloadFormat[]; officeLosses: string[] } | 'signed-out' | null>(null);
  const [format, setFormat] = useState<DownloadFormat>('office');
  const [at, setAt] = useState(props.startIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CopiedFile | null>(null);

  useEffect(() => {
    api.webPreview(file.kind, file.id).then(
      (p) => (setPreview(p), setFormat(p.formats[0])),
      (e: unknown) => (signedOut(e) ? setPreview('signed-out') : setError(e instanceof Error ? e.message : String(e))),
    );
  }, [file.kind, file.id]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.downloadFromWeb(file, at, format);
      if (made.warnings.length) setDone(made);
      else props.onDone(made);
    } catch (e) {
      if (signedOut(e)) return setPreview('signed-out');
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const title = `Download “${file.title || 'file'}” from the web`;
  if (preview === 'signed-out') return <Modal title={title} onClose={props.onClose}><SignInFirst onClose={props.onClose} /></Modal>;
  if (done) {
    return (
      <Modal title="Downloaded" onClose={props.onClose}>
        <p>“{done.title}” is in “{folderNameOf(at, props.rootName)}”.</p>
        <Warnings warnings={done.warnings} />
        <div className="modal-actions">
          <button className="btn primary" onClick={() => props.onDone(done)}>
            Open
          </button>
        </div>
      </Modal>
    );
  }
  const office = OFFICE[file.kind];
  const label = (f: DownloadFormat) =>
    f === 'office' ? `${office?.name} (${office?.ext})` : f === 'native' ? `MCP Docs (${NATIVE_EXT[file.kind]})` : f === 'pdf' ? 'PDF (.pdf)' : f === 'csv' ? 'CSV (.csv)' : '';
  const hint = (f: DownloadFormat) =>
    f === 'office'
      ? preview && preview.officeLosses.length
        ? `Not kept: ${preview.officeLosses.join(', ')}.`
        : `Opens in ${office?.name} and other apps.`
      : f === 'native'
        ? 'Keeps everything; opens only in MCP Docs.'
        : f === 'pdf'
          ? 'As it prints, to read and send.'
          : 'The first tab’s values, for other apps.';
  return (
    <Modal title={title} onClose={props.onClose}>
      {preview && preview.formats.length > 1 && (
        <fieldset className="copy-formats">
          <legend>Save as</legend>
          {preview.formats.map((f) => (
            <label key={f}>
              <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
              <span>
                {label(f)}
                <span className={`muted${f === 'office' && preview.officeLosses.length ? ' copy-loss' : ''}`}>{hint(f)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <FolderBrowser at={at} setAt={setAt} rootName={props.rootName} list={async (f) => (await api.library(f)).folders} onError={setError} />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !preview} onClick={() => void download()}>
          {busy ? 'Downloading…' : `Download to “${folderNameOf(at, props.rootName)}”`}
        </button>
      </div>
    </Modal>
  );
}
