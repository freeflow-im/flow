// Picture edits the model asked for (transform_image), done here because the image editor needs a browser: the
// plugin server hands them to the app with its state, and the app answers with image_job_result. An edit to
// the picture open in the editor is made there, where the user sees it; any other is made off screen and saved.
import { EDITABLE_IMAGE_TYPES } from '../../shared/types.ts';
import { activeImageEditor } from '../../client/src/image/activeEditor.ts';
import { openHiddenEngine } from '../../client/src/image/hiddenEngine.ts';
import { applyImageOps, ImageOpError, type ImageOp, type OverlayLoader } from '../../client/src/image/imageOps.ts';
import { editedCopyName } from '../../client/src/image/limits.ts';
import type { Host } from './host.ts';
import { createPicture, loadPicture, replacePicture } from './imageStore.ts';

export interface ImageJob {
  id: string;
  file_id: string;
  operations: ImageOp[];
  save: 'copy' | 'replace';
  /** Not an edit: the model only wants to look at the picture, which is too large to send as it is. */
  preview?: boolean;
}

interface Done {
  applied: string[];
  size: { width: number; height: number } | null;
  file_id: string;
  saved: boolean;
  /** The picture as it is now, for the model to look at. */
  shown: Blob;
}

/** Longest side of the picture the model is shown. */
const PREVIEW_DIM = 1568;

/** A reduced JPEG of a picture, in base64 (see-through parts on white). */
async function preview(image: Blob): Promise<{ preview_data: string; preview_type: string }> {
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, PREVIEW_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.85));
  if (!jpeg) throw new Error('The picture could not be reduced.');
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { preview_data: btoa(binary), preview_type: 'image/jpeg' };
}

/** Reads the stored pictures that overlays put on top, by file id. */
const overlayLoader =
  (host: Host): OverlayLoader =>
  async (source) => {
    const { file, data } = await loadPicture(host, source).catch(() => {
      throw new ImageOpError(`There is no stored picture ${source} to put on top.`);
    });
    if (!data.type.startsWith('image/') || data.type === 'image/svg+xml') throw new ImageOpError(`${file.title} is not a picture that can be put on top (PNG, JPEG, GIF or WebP).`);
    const bitmap = await createImageBitmap(data).catch(() => null);
    if (!bitmap) throw new ImageOpError(`${file.title} could not be read as a picture.`);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { image: data, ...size };
  };

async function edit(host: Host, job: ImageJob): Promise<Done> {
  const load = overlayLoader(host);
  const open = activeImageEditor(job.file_id);
  if (open) {
    const applied = await open.engine.batch('Assistant edit', () => applyImageOps(open.engine, job.operations, undefined, load)).finally(() => open.refresh());
    return { applied, size: open.engine.getOutputSize(), file_id: job.file_id, saved: false, shown: await open.exportBlob() };
  }
  const { file, data } = await loadPicture(host, job.file_id);
  if (!EDITABLE_IMAGE_TYPES.includes(data.type)) throw new Error(`${file.title} cannot be edited: only PNG, JPEG and WebP pictures can.`);
  const hidden = await openHiddenEngine(data);
  try {
    const applied = await applyImageOps(hidden.engine, job.operations, hidden.bake, load);
    const size = hidden.engine.getOutputSize();
    const result = await hidden.export(data.type);
    const saved = job.save === 'replace' ? await replacePicture(host, job.file_id, file.title, result) : await createPicture(host, editedCopyName(file.title), result);
    return { applied, size, file_id: saved.id, saved: true, shown: result };
  } finally {
    await hidden.close();
  }
}

/** Jobs this page has taken, so one handed over twice is done once. */
const taken = new Set<string>();

/** Do a job and tell the server how it went; `changed` lets the page show a picture that was saved over. */
export async function runImageJob(host: Host, job: ImageJob, changed?: (fileId: string) => void): Promise<void> {
  if (taken.has(job.id)) return;
  taken.add(job.id);
  let result: Record<string, unknown>;
  try {
    if (job.preview) result = { ok: true, ...(await preview((await loadPicture(host, job.file_id)).data)) };
    else {
      const done = await edit(host, job);
      // The edit stands whether or not the model can be shown it.
      const shown = await preview(done.shown).catch(() => ({}));
      result = { ok: true, applied: done.applied, ...(done.size ? { width: done.size.width, height: done.size.height } : {}), file_id: done.file_id, saved: done.saved, ...shown };
      if (done.saved && done.file_id === job.file_id) changed?.(job.file_id);
    }
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await host.call('image_job_result', { job_id: job.id, ...result }).catch(() => {});
}
