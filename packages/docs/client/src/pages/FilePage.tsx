import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { EDITABLE_IMAGE_TYPES, HTML_TYPE, PREVIEW_FILE_TYPES, type StoredFile } from '../../../shared/types.ts';
import { HtmlEditor } from '../components/HtmlEditor.tsx';
import { HtmlPreview } from '../components/HtmlPreview.tsx';
import { TextFileEditor } from '../components/TextFileEditor.tsx';
import { JsonViewer } from '../components/JsonViewer.tsx';
import { ZipBrowser } from '../components/ZipBrowser.tsx';
import { isZipName } from '../../../shared/zip.ts';
import { ImageFileEditor } from '../image/ImageFileEditor.tsx';
import { PdfSigner } from '../pdf/PdfSigner.tsx';
import { useAuth } from '../auth.tsx';
import { ShareDialog } from '../components/ShareDialog.tsx';
import { ImageSelector } from '../components/ImageSelector.tsx';
import type { ImageRegion } from '../../../shared/agent/protocol.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { FILE_CHANGED_EVENT, useRegisterFile } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { fileIcon, formatFileSize } from '../components/FileChip.tsx';
import { FavoriteStar } from '../components/FavoriteStar.tsx';
import { FileSearchButton } from '../components/FileSearch.tsx';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { TitleInput } from '../components/TitleInput.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { useOpenInTab } from '../components/OpenInTab.tsx';
import { useFavicon } from '../favicon.ts';
import { isPowerPointFile, isWordFile, titleFromFileName } from '../importFile.ts';
import { downloadPdf } from '../print.ts';

// Remove background in the image editor: a model that runs in the browser, fetched when it is first used.
const loadBackgroundRemoval = () => import('@imgly/background-removal');

/** What an Office file becomes when it is converted, or null for any other file. */
function editableKind(filename: string): string | null {
  if (/\.xlsx?$/i.test(filename)) return 'spreadsheet';
  if (/\.pptx$/i.test(filename)) return 'presentation';
  if (/\.docx$/i.test(filename)) return 'document';
  return null;
}

/** Download a file from its address, as the Download button's link does. */
function download(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

/**
 * A stored file in its own tab: an in-app preview for PDFs, images and web pages, a player for videos, or just its
 * details, with a Download button. Its File menu is the editors' (Open, Open in Finder, Rename, Download, Delete),
 * with what the page offers for the kind of file (Edit, Convert to Markdown, Download as PDF, Open as …).
 */
export function FilePage() {
  // In the FreeFlow suite the suite bar replaces the logo, the Assistant button and Sign out (components/DocsSuiteBar.tsx).
  const inSuite = !!useAuth().suite;
  const { id = '' } = useParams();
  useFavicon('home');
  const [file, setFile] = useState<StoredFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [makingPdf, setMakingPdf] = useState(false);
  const navigate = useNavigate();
  // `?edit=1` (the assistant putting a picture on top of this one) opens the editor at once.
  const [params, setParams] = useSearchParams();
  const editOnOpen = params.get('edit') === '1';
  // The desktop app keeps no earlier version of a file in its folder (a signed PDF's is put in the trash).
  const local = !!useAuth().local;

  // An Excel, PowerPoint or Word file is not edited in place: converting makes an editable copy next to it.
  const convert = async (stored: StoredFile) => {
    setConverting(true);
    try {
      const res = await fetch(stored.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
      const upload = new File([await res.blob()], stored.filename, { type: stored.type });
      const title = titleFromFileName(stored.filename);
      // The copy goes in the same folder as the original.
      const folder = stored.folder;
      if (isPowerPointFile(upload)) {
        const { deck, warnings } = await api.importPptx(upload, title, folder);
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
      } else if (isWordFile(upload)) {
        const { doc, warnings } = await api.importDocx(upload, title, folder);
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
      } else {
        const { sheet, warnings } = await api.importXlsx(upload, title, folder);
        navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConverting(false);
    }
  };

  // A PDF's text becomes a Markdown file next to it, which opens.
  const toMarkdown = async (stored: StoredFile) => {
    setConverting(true);
    try {
      const { doc, warnings } = await api.pdfToMarkdown(stored.id);
      navigate(`/md/${doc.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConverting(false);
    }
  };

  // Counts the assistant's changes to this file, so the preview shows each new version.
  const [version, setVersion] = useState(0);
  // A web page opens as a working page; Edit makes it editable in place instead (the element selected in it is
  // told to the assistant), with its scripts and links off. On a picture, Edit opens the image editor.
  const [editing, setEditing] = useState(false);
  /** The picture was just saved over in the image editor, so the version before it can be put back. */
  const [canRevert, setCanRevert] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // On a picture the user can drag a box, which is told to the assistant too.
  const [region, setRegion] = useState<ImageRegion | null>(null);
  useEffect(() => {
    setFile(null);
    setError(null);
    setEditing(false);
    setCanRevert(false);
    setRegion(null);
    api.getFile(id).then((r) => setFile(r.file), (e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (!editOnOpen || file?.id !== id) return;
    if (EDITABLE_IMAGE_TYPES.includes(file.type) || file.type === 'application/pdf') setEditing(true);
    setParams({}, { replace: true });
  }, [editOnOpen, file, id, setParams]);
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setVersion((v) => v + 1);
      api.getFile(id).then((r) => setFile(r.file), () => {});
    };
    window.addEventListener(FILE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(FILE_CHANGED_EVENT, changed);
  }, [id]);

  useEffect(() => {
    if (file) document.title = file.filename;
  }, [file]);
  // The assistant is told which file is showing.
  useRegisterFile(file, editing ? selected : null, region);

  const previewable = !!file && PREVIEW_FILE_TYPES.includes(file.type);
  const editableImage = !!file && EDITABLE_IMAGE_TYPES.includes(file.type);
  // A JSON file (small enough to edit as text) is shown as a tree; Edit opens it in the text editor.
  const json = !!file?.text && (file.type === 'application/json' || /\.json$/i.test(file.filename));
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'share' | null>(null);
  const openInTab = useOpenInTab();
  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);
  const pdfOfPage = (f: StoredFile) => {
    setMakingPdf(true);
    downloadPdf(f.id)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMakingPdf(false));
  };
  const revert = () =>
    api.revertFile(id).then(
      (r) => {
        setFile(r.file);
        setCanRevert(false);
        setVersion((v) => v + 1);
      },
      (e: Error) => setError(e.message),
    );
  const pdf = file?.type === 'application/pdf';
  const html = file?.type === HTML_TYPE;
  const fileMenu = (f: StoredFile): MenuItem[] => {
    const office = editableKind(f.filename);
    const kindItems: MenuItem[] = [
      ...(editableImage ? [{ label: 'Edit picture', checked: editing, action: () => setEditing(!editing) }] : []),
      ...(pdf ? [{ label: 'Sign or add text', checked: editing, action: () => setEditing(!editing) }] : []),
      ...(html ? [{ label: 'Edit page', checked: editing, action: () => setEditing(!editing) }] : []),
      ...(json ? [{ label: 'Edit as text', checked: editing, action: () => setEditing(!editing) }] : []),
      ...((editableImage || pdf) && canRevert && !editing ? [{ label: 'Undo save', action: () => void revert() }] : []),
      ...(pdf ? [{ label: 'Convert to Markdown', disabled: converting, action: () => void toMarkdown(f) }] : []),
      ...(office ? [{ label: `Open as ${office}`, disabled: converting, action: () => void convert(f) }] : []),
    ];
    return [
      ...openInTab.items,
      { label: 'Rename…', action: () => setDialog('rename') },
      ...(kindItems.length ? (['sep', ...kindItems] as MenuItem[]) : []),
      'sep',
      { label: 'Download', action: () => download(f.downloadUrl, f.filename) },
      ...(html ? [{ label: 'Download as PDF', disabled: makingPdf, action: () => pdfOfPage(f) }] : []),
      'sep',
      { label: 'Delete file', danger: true, action: () => setDialog('delete') },
      'sep',
      { label: 'Home', action: () => navigate('/') },
    ];
  };

  return (
    <div className="file-page">
      <header className="wb-header">
        {!inSuite && (
          <Link to={lastListingHref()} className="wb-logo" title="Back to the file list">
            <HomeIcon />
          </Link>
        )}
        <div className="wb-titles">
          <div className="wb-title-row">
            {file && <FavoriteStar kind="file" id={file.id} onError={setError} />}
            {file && <FolderCrumbs folder={file.folder} />}
            {file && <TitleInput title={file.filename} label="File name" onRename={(name) => api.renameFile(file.id, name).then((r) => setFile(r.file))} onError={setError} />}
          </div>
          {file && (
            <nav className="menubar" onMouseDown={(e) => e.stopPropagation()}>
              <div className="menubar-entry">
                <button
                  className={`menubar-btn${openMenu === 'file' ? ' open' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpenMenu(openMenu === 'file' ? null : 'file');
                  }}
                >
                  File
                </button>
                {openMenu === 'file' && <MenuList items={fileMenu(file)} onDone={() => setOpenMenu(null)} style={{ top: 26, left: 0 }} />}
              </div>
              {!local && file.type.startsWith('video/') && PREVIEW_FILE_TYPES.includes(file.type) && (
                <div className="menubar-entry">
                  <button
                    className={`menubar-btn${openMenu === 'sharing' ? ' open' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setOpenMenu(openMenu === 'sharing' ? null : 'sharing');
                    }}
                  >
                    Sharing
                  </button>
                  {openMenu === 'sharing' && <MenuList items={[{ label: 'Public link…', action: () => setDialog('share') }]} onDone={() => setOpenMenu(null)} style={{ top: 26, left: 0 }} />}
                </div>
              )}
            </nav>
          )}
        </div>
        <div className="wb-user">
          <FileSearchButton />
          {file?.type === HTML_TYPE && (
            <button className={`btn${editing ? ' active' : ''}`} onClick={() => setEditing(!editing)} title={editing ? 'Run the page as a browser would, with its scripts and links working' : "Select, edit, delete and recolor the page's elements"}>
              {editing ? 'Preview' : 'Edit'}
            </button>
          )}
          {file?.type === HTML_TYPE && !editing && (
            <button
              className="btn"
              disabled={makingPdf}
              onClick={() => pdfOfPage(file)}
              title="Download the page as a PDF, as a browser prints it"
            >
              {makingPdf ? 'Making PDF…' : 'Download as PDF'}
            </button>
          )}
          {json && (
            <button className={`btn${editing ? ' active' : ''}`} onClick={() => setEditing(!editing)} title={editing ? 'Show the JSON as a tree' : 'Edit the JSON as text'}>
              {editing ? 'View' : 'Edit'}
            </button>
          )}
          {editableImage && !editing && canRevert && (
            <button className="btn" onClick={() => void revert()} title="Put back the picture as it was before the last save">
              Undo save
            </button>
          )}
          {editableImage && !editing && (
            <button className="btn" onClick={() => setEditing(true)} title="Crop, rotate, adjust and draw on the picture">
              Edit
            </button>
          )}
          {file?.type === 'application/pdf' && !editing && canRevert && (
            <button className="btn" onClick={() => void revert()} title="Put back the PDF as it was before it was signed">
              Undo save
            </button>
          )}
          {file?.type === 'application/pdf' && !editing && (
            <button className="btn" onClick={() => setEditing(true)} title="Put your signature, your name, a date or other text on the PDF">
              Edit
            </button>
          )}
          {file?.type === 'application/pdf' && !editing && (
            <button className="btn" disabled={converting} onClick={() => void toMarkdown(file)} title="Make a Markdown file of the PDF's text next to it; the PDF stays as it is">
              {converting ? 'Converting…' : 'Convert to Markdown'}
            </button>
          )}
          {file && (
            <a className="btn primary" href={file.downloadUrl} download={file.filename}>
              Download
            </a>
          )}
          {!inSuite && <AgentButton />}
        </div>
      </header>
      {openInTab.dialog}
      {file && dialog === 'rename' && (
        <PromptModal
          title="Rename file"
          label="File name"
          initial={file.filename}
          confirmText="Rename"
          maxLength={255}
          onConfirm={async (name) => setFile((await api.renameFile(file.id, name.trim())).file)}
          onClose={() => setDialog(null)}
        />
      )}
      {file && dialog === 'delete' && (
        <ConfirmModal
          title="Delete file?"
          message={<>“{file.filename}” will be deleted.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            await api.deleteFile(file.id);
            navigate(lastListingHref());
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'share' && file && <ShareDialog kind="file" id={file.id} name={file.filename} onClose={() => setDialog(null)} />}
      <main className="file-page-body">
        {error ? (
          <div className="form-error">{error}</div>
        ) : !file ? (
          <div className="muted">Loading…</div>
        ) : isZipName(file.filename) ? (
          <ZipBrowser file={file} />
        ) : file.type === 'application/pdf' && editing ? (
          <PdfSigner
            key={`${file.id}:${version}`}
            file={file}
            store={{
              load: async () => {
                const res = await fetch(file.url, { credentials: 'same-origin', cache: 'no-cache' });
                if (!res.ok) throw new Error(`Could not read the PDF (${res.status})`);
                return res.arrayBuffer();
              },
              replace: async (pdf) => {
                setFile(await api.updatePdfFile(file.id, pdf));
                setVersion((v) => v + 1);
                setCanRevert(!local);
                setEditing(false);
              },
              create: async (name, pdf) => navigate(`/f/${(await api.uploadFile(name, new File([pdf], name, { type: 'application/pdf' }), file.folder)).id}`),
            }}
            onClose={() => setEditing(false)}
          />
        ) : file.type === 'application/pdf' ? (
          // A PDF that was saved over is asked for by a new address, so the browser's viewer shows the new one.
          <iframe key={version} className="file-preview" src={version ? `${file.url}?v=${version}` : file.url} title={file.filename} />
        ) : file.type === HTML_TYPE && editing ? (
          <HtmlEditor key={version} file={file} onSelect={setSelected} onSaved={setFile} />
        ) : file.type === HTML_TYPE ? (
          <HtmlPreview key={version} url={file.url} title={file.filename} />
        ) : file.type.startsWith('video/') ? (
          // The browser's own player; it asks the server for the parts of the file it needs.
          <video className="file-preview-video" src={file.url} controls autoPlay playsInline />
        ) : editableImage && editing ? (
          <ImageFileEditor
            key={`${file.id}:${version}`}
            file={file}
            store={{
              load: async () => {
                const res = await fetch(file.url, { credentials: 'same-origin' });
                if (!res.ok) throw new Error(`Could not read the picture (${res.status})`);
                return res.blob();
              },
              replace: async (image) => {
                setFile(await api.updateImageFile(file.id, image));
                setVersion((v) => v + 1);
                setCanRevert(true);
                setEditing(false);
              },
              create: async (name, image) => navigate(`/f/${(await api.uploadFile(name, image, file.folder)).id}`),
            }}
            backgroundRemovalLoader={loadBackgroundRemoval}
            onClose={() => setEditing(false)}
          />
        ) : json && !editing ? (
          <JsonViewer key={`${file.id}:${version}`} file={file} onEdit={() => setEditing(true)} />
        ) : file.text && !previewable ? (
          // Plain text, whatever its name: a log, a config file, source code.
          <TextFileEditor key={`${file.id}:${version}`} file={file} onSaved={setFile} canTail={local} />
        ) : previewable ? (
          // A picture that was saved over is asked for by a new address, so no earlier copy of it is shown.
          <ImageSelector key={`${file.id}:${version}`} url={version ? `${file.url}?v=${version}` : file.url} alt={file.filename} region={region} onChange={setRegion} />
        ) : (
          <div className="file-info">
            <div className="file-chip-icon" aria-hidden="true">
              {fileIcon(file.type)}
            </div>
            <h2>{file.filename}</h2>
            <p>
              {file.type || 'Unknown type'} · {formatFileSize(file.size)} · added {new Date(file.createdAt).toLocaleString()}
            </p>
            {editableKind(file.filename) ? (
              <>
                <p className="muted">This file isn’t edited in place. Open an editable copy of it as a {editableKind(file.filename)}; the original stays as it is.</p>
                <button className="btn primary" disabled={converting} onClick={() => void convert(file)}>
                  {converting ? 'Converting…' : `Open as ${editableKind(file.filename)}`}
                </button>
              </>
            ) : (
              <p className="muted">This type of file can’t be previewed here.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
