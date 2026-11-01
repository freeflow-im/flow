import { useNavigate } from 'react-router-dom';
import { fileIcon } from './FileLibrary.tsx';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { fileIcon } from './FileLibrary.tsx';

export interface ChipFile {
  id: string;
  filename: string;
  type?: string;
  /** Page count, shown instead of the size when known. */
  pages?: number;
  size?: number;
  downloadUrl: string;
}

/** The file produced by a tool call (export_deck's result), or null if the result has none. */
export function fileOfResult(result: string | undefined): ChipFile | null {
  if (!result) return null;
  try {
    const r = JSON.parse(result) as { file_id?: unknown; filename?: unknown; pages?: unknown; download_url?: unknown };
    if (typeof r.file_id !== 'string' || typeof r.filename !== 'string') return null;
    return {
      id: r.file_id,
      filename: r.filename,
      type: r.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : undefined,
      pages: typeof r.pages === 'number' ? r.pages : undefined,
      downloadUrl: typeof r.download_url === 'string' ? r.download_url : `/api/files/${r.file_id}/download`,
    };
  } catch {
    return null;
  }
}

/** A file in the chat: click to open its preview tab; the arrow downloads it. */
export function FileChip({ file }: { file: ChipFile }) {
  const navigate = useNavigate();
  const detail = file.pages !== undefined ? `${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : file.size !== undefined ? formatFileSize(file.size) : '';
  return (
    <div className="file-chip">
      <button className="file-chip-open" onClick={() => navigate(`/f/${encodeURIComponent(file.id)}`)} title="Open a preview">
        <span className="file-chip-icon" aria-hidden="true">
          {fileIcon(file.type ?? '')}
        </span>
        <span className="file-chip-name">{file.filename}</span>
        {detail && <span className="file-chip-detail">· {detail}</span>}
      </button>
      <a className="file-chip-download" href={file.downloadUrl} download={file.filename} title="Download" aria-label={`Download ${file.filename}`}>
        ↓
      </a>
    </div>
  );
}
