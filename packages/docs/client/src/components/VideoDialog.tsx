// "Insert video" for a presentation or a document: upload a video file, give a YouTube link, or pick a
// video already among the user's files. Whichever way, the page is handed the video's address
// (shared/video.ts) and a name for it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_VIDEO_BYTES, VIDEO_TYPES, videoTypeOf, type StoredFile } from '../../../shared/types.ts';
import { youtubeId, youtubePoster, youtubeWatchUrl } from '../../../shared/video.ts';
import { api } from '../api.ts';
import { Modal } from './Modal.tsx';
import { VideoPoster } from './VideoPlayer.tsx';

type Tab = 'upload' | 'youtube' | 'library';
const TABS: [Tab, string][] = [
  ['upload', 'Upload'],
  ['youtube', 'YouTube'],
  ['library', 'Your files'],
];

const VIDEO_ACCEPT = Object.keys(VIDEO_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');
const MAX_MB = MAX_VIDEO_BYTES / 1024 / 1024;

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const isVideo = (f: StoredFile) => f.type.startsWith('video/') || videoTypeOf(f.filename) !== null;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function VideoDialog({ folder, onInsert, onClose }: { /** Where an uploaded video is kept: the folder of the file it is put in. */ folder?: string; onInsert(src: string, title: string): void; onClose(): void }) {
  const [tab, setTab] = useState<Tab>('upload');
  const [error, setError] = useState<string | null>(null);
  const insert = (src: string, title: string) => {
    onInsert(src, title);
    onClose();
  };

  // --- Upload
  const [uploading, setUploading] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    const type = videoTypeOf(file.name);
    if (!type) return setError('Please choose a video file (.mp4, .m4v, .mov, .webm or .ogv).');
    if (file.size > MAX_VIDEO_BYTES) return setError(`This video is too large to upload (${MAX_MB} MB maximum).`);
    setError(null);
    setUploading(file.name);
    try {
      const stored = await api.uploadFile(file.name, new Blob([file], { type }), folder);
      insert(stored.url, stored.filename);
    } catch (e) {
      setError(message(e));
      setUploading(null);
    }
  };

  // --- YouTube
  const [link, setLink] = useState('');
  const yt = youtubeId(link);

  // --- Your files
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'library' || files) return;
    let gone = false;
    api
      .listFiles()
      .then((r) => !gone && setFiles(r.files.filter(isVideo)))
      .catch((e: unknown) => !gone && setError(message(e)));
    return () => {
      gone = true;
    };
  }, [tab, files]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (files ?? []).filter((f) => !q || f.filename.toLowerCase().includes(q) || (f.folder ?? '').toLowerCase().includes(q));
  }, [files, query]);
  const pickedFile = shown.find((f) => f.id === picked);

  return (
    <Modal title="Insert video" onClose={uploading ? () => {} : onClose} className="video-dialog">
      <div className="video-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} disabled={!!uploading} onClick={() => (setTab(id), setError(null))}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <div
          className={`video-drop${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            void upload(e.dataTransfer.files[0]);
          }}
        >
          {uploading ? (
            <div className="import-progress" role="status">
              <div className="spinner" />
              Uploading “{uploading}”…
            </div>
          ) : (
            <>
              <p>Drop a video here, or</p>
              <button className="btn primary" onClick={() => picker.current?.click()}>
                Choose a file
              </button>
              <p className="muted">MP4, MOV or WebM, up to {MAX_MB} MB. It is kept in your files.</p>
            </>
          )}
          <input ref={picker} type="file" accept={VIDEO_ACCEPT} hidden onChange={(e) => (void upload(e.target.files?.[0]), (e.target.value = ''))} />
        </div>
      )}

      {tab === 'youtube' && (
        <form
          className="video-youtube"
          onSubmit={(e) => {
            e.preventDefault();
            if (yt) insert(youtubeWatchUrl(yt), 'YouTube video');
            else setError('That is not a link to a YouTube video.');
          }}
        >
          <label className="field">
            <span>YouTube link</span>
            <input autoFocus value={link} onChange={(e) => (setLink(e.target.value), setError(null))} placeholder="https://www.youtube.com/watch?v=…" maxLength={500} />
          </label>
          <div className="video-preview">{yt ? <img src={youtubePoster(yt)} alt="The video's still" /> : <span className="muted">{link.trim() ? 'That is not a link to a YouTube video.' : 'Paste the link of a video to see it here.'}</span>}</div>
        </form>
      )}

      {tab === 'library' && (
        <div className="video-library">
          <input className="video-search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your videos" aria-label="Search your videos" />
          <div className="video-list" role="listbox" aria-label="Videos in your files">
            {files === null ? (
              !error && <div className="muted">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="muted">{files.length === 0 ? 'There are no videos in your files yet. Upload one in the first tab.' : 'No video matches your search.'}</div>
            ) : (
              shown.map((f) => (
                <button key={f.id} role="option" aria-selected={picked === f.id} className={`video-card${picked === f.id ? ' picked' : ''}`} onClick={() => setPicked(f.id)} onDoubleClick={() => insert(f.url, f.filename)} title={f.filename}>
                  <VideoPoster src={f.url} />
                  <span className="video-card-name">{f.filename}</span>
                  <span className="video-card-meta">
                    {sizeText(f.size)}
                    {f.folder ? ` · ${f.folder}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" disabled={!!uploading} onClick={onClose}>
          Cancel
        </button>
        {tab === 'youtube' && (
          <button className="btn primary" disabled={!yt} onClick={() => yt && insert(youtubeWatchUrl(yt), 'YouTube video')}>
            Insert
          </button>
        )}
        {tab === 'library' && (
          <button className="btn primary" disabled={!pickedFile} onClick={() => pickedFile && insert(pickedFile.url, pickedFile.filename)}>
            Insert
          </button>
        )}
      </div>
    </Modal>
  );
}
