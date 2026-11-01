// The assistant's transform_image: exact edits to a stored picture (crop, rotate, text, shapes, redaction and so
// on) made by the image editor's own engine. If the picture is open in the editor the edits happen there, as one
// undo step, and nothing is saved until the user saves; otherwise a hidden engine edits the file's bytes and the
// result is saved as a copy or over the file. (edit_image, by contrast, has an image model redraw the picture.)
// A picture put on top (overlay) is a layer the user can still move and resize, so for it the file is opened in
// the editor first and the edit is made there.
import type { AspEditorHandle } from '@ascentsparksoftware/react-image-editor';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { EDITABLE_IMAGE_TYPES, STORED_IMAGE_RE, type StoredFile } from '../../../shared/types.ts';
import { activeImageEditor } from '../image/activeEditor.ts';
import type { HiddenEngine } from '../image/hiddenEngine.ts';
import { applyImageOps, ImageOpError, type ImageOp, type OverlayLoader } from '../image/imageOps.ts';
import { ToolError } from './toolError.ts';

export const IMAGE_TOOLS: ReadonlySet<string> = new Set(['transform_image']);

export interface ImageToolEnv {
  readFile?(id: string): Promise<{ file: StoredFile; data: ArrayBuffer }>;
  openFile?(id: string): Promise<StoredFile>;
  /** Save an edited picture over a stored one, or as a new file next to it. */
  saveImage?(id: string, image: Blob): Promise<StoredFile>;
  saveImageCopy?(of: StoredFile, image: Blob): Promise<StoredFile>;
  /** The editor's engine off screen, over these bytes (hiddenEngine.ts); tests pass a stand-in. */
  openImageEngine?(source: Blob): Promise<HiddenEngine>;
  /** The bytes of a stored image (/api/images/...), and storing a new one (resolves to its address). */
  readImage?(src: string): Promise<Blob>;
  uploadImage?(image: Blob): Promise<string>;
  /** A picture's size in pixels (clientTools' env has it for view_image). */
  imageSize?(data: ArrayBuffer, type: string): Promise<{ width: number; height: number }>;
  /** Show the stored picture in the image editor, resolving with the editor once it is ready (null if it cannot be). */
  openImageEditor?(id: string): Promise<AspEditorHandle | null>;
}

/** Reads the pictures that overlay operations put on top: an attached or embedded picture by address, or a stored picture file. */
function overlayLoader(env: ImageToolEnv): OverlayLoader {
  return async (source) => {
    let image: Blob;
    if (STORED_IMAGE_RE.test(source)) {
      if (!env.readImage) throw new ImageOpError('Pictures cannot be read here.');
      image = await env.readImage(source);
    } else if (/^\/api\//.test(source) || source.includes('://')) {
      throw new ImageOpError('"source" must be a stored picture’s /api/images/... address (an attached picture’s, from <attached_images>) or a stored picture’s file_id. A picture at a web address is saved first with import_file.');
    } else {
      if (!env.readFile) throw new ImageOpError('Stored files are not available here.');
      const { file, data } = await env.readFile(source);
      if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new ImageOpError(`${file.filename} is not a picture that can be put on top (PNG, JPEG, GIF or WebP).`);
      image = new Blob([data], { type: file.type });
    }
    const size = await env.imageSize?.(await image.arrayBuffer(), image.type).catch(() => null);
    if (!size?.width || !size.height) throw new ImageOpError('The picture to put on top could not be read.');
    return { image, ...size };
  };
}

/** The editor the picture is open in; for a picture put on top, opened there when it is not, so the result stays adjustable. */
async function editorFor(id: string, ops: ImageOp[], save: unknown, env: ImageToolEnv): Promise<AspEditorHandle | null> {
  const open = activeImageEditor(id);
  if (open || save !== undefined || !ops.some((op) => op.op === 'overlay') || !env.openImageEditor) return open;
  return env.openImageEditor(id).catch(() => null);
}

/** True when the call would save over a file, which the user is asked about first. */
export function replacesImageFile(call: ClientToolCall): boolean {
  return call.name === 'transform_image' && call.input.save === 'replace' && typeof call.input.file_id === 'string' && !!call.input.file_id && !activeImageEditor(call.input.file_id);
}

const fixable = (e: unknown): never => {
  throw e instanceof ImageOpError ? new ToolError(e.message) : e;
};

/** `attach` shows Claude a picture after the tool results (clientTools' attachPicture). */
export async function runImageTool(call: ClientToolCall, env: ImageToolEnv, attach: (file: StoredFile, data: ArrayBuffer) => Promise<string>): Promise<string> {
  const i = call.input;
  const ops = Array.isArray(i.operations) ? (i.operations as ImageOp[]) : [];
  if (!ops.length) throw new ToolError('Give at least one operation.');
  const hasFile = typeof i.file_id === 'string' && !!i.file_id;
  const hasImage = typeof i.image === 'string' && !!i.image;
  if (hasFile === hasImage) throw new ToolError('Give either file_id (a stored picture file) or image (the address of a picture inside a presentation, document or spreadsheet).');
  if (hasImage) return editEmbedded(String(i.image).trim(), ops, env, attach);
  const id = String(i.file_id);
  if (!env.readFile) throw new ToolError('Stored files are not available here.');
  const load = overlayLoader(env);

  // Open in the editor: edit there, where the user sees it and can undo it.
  const open = await editorFor(id, ops, i.save, env);
  if (open) {
    const { file } = await env.readFile(id);
    const applied = await open.engine.batch('Assistant edit', () => applyImageOps(open.engine, ops, undefined, load)).catch(fixable).finally(() => open.refresh());
    const shown = await open.exportBlob();
    const image = await attach(file, await shown.arrayBuffer()).catch(() => 'Not attached.');
    const layered = ops.some((op) => op.op === 'overlay') ? ' The picture put on top is a layer of its own there: the user can still move, resize or delete it before saving.' : '';
    return JSON.stringify({ edited: true, file_id: id, filename: file.filename, applied, size: open.engine.getOutputSize(), saved: false, note: `Done in the editor the user has open, as one undo step. It is not saved until the user saves there; tell them so.${layered}`, image });
  }

  const { file, data } = await env.readFile(id);
  if (!EDITABLE_IMAGE_TYPES.includes(file.type)) throw new ToolError(`${file.filename} cannot be edited: only PNG, JPEG and WebP pictures can.`);
  if (!env.openImageEngine || !env.saveImage || !env.saveImageCopy) throw new ToolError('Pictures cannot be edited here.');
  const hidden = await env.openImageEngine(new Blob([data], { type: file.type }));
  let result: Blob;
  let applied: string[];
  let size: { width: number; height: number } | null;
  let transparentCopy = false;
  const replace = i.save === 'replace';
  try {
    applied = await applyImageOps(hidden.engine, ops, hidden.bake, load).catch(fixable);
    size = hidden.engine.getOutputSize();
    // A JPEG has no transparency: a copy whose background was removed is a PNG, so the background is gone
    // instead of black. Saved over the file, the picture keeps its type.
    transparentCopy = !replace && file.type === 'image/jpeg' && ops.some((op) => op.op === 'remove_background');
    result = await hidden.export(transparentCopy ? 'image/png' : file.type);
  } finally {
    await hidden.close();
  }
  const saved = replace ? await env.saveImage(id, result) : await env.saveImageCopy(file, result);
  // Show the user the result, and Claude too; the edit stands even if either fails.
  let opened = false;
  let image = 'Not attached. Call view_image to look at it.';
  try {
    opened = !!(await env.openFile?.(saved.id));
    image = await attach(saved, await result.arrayBuffer());
  } catch {
    // Reported in the result.
  }
  const blackBackground = replace && file.type === 'image/jpeg' && ops.some((op) => op.op === 'remove_background');
  const note =
    (replace ? 'Saved over the file; the version before it is kept (the user can put it back with Undo save on the file).' : `A new file${opened ? ', open now' : ''}; the original is unchanged.`) +
    (transparentCopy ? ' It is a PNG, so the removed background is transparent.' : blackBackground ? ' The file is a JPEG, which has no transparency, so the removed background is black; save a copy instead to get a transparent PNG.' : '');
  return JSON.stringify({ edited: true, file_id: saved.id, filename: saved.filename, ...(replace ? {} : { source_file_id: id }), applied, size, saved: true, note, image });
}

/**
 * A picture inside a presentation, document or spreadsheet, by its stored address. It is never rewritten: the
 * edited picture is stored anew and its address returned for the model to put in place (which is an ordinary,
 * undoable edit of that file). Open in the image editor, it is edited there instead.
 */
async function editEmbedded(src: string, ops: ImageOp[], env: ImageToolEnv, attach: (file: StoredFile, data: ArrayBuffer) => Promise<string>): Promise<string> {
  if (!STORED_IMAGE_RE.test(src)) throw new ToolError('image must be a stored picture’s address (/api/images/...). A picture at a web address is saved first with import_file, and edited by its file_id.');
  // What attach needs to know of a picture that is not a file.
  const asFile = (address: string, type: string, size: number): StoredFile => ({ id: address, filename: 'picture', type, size, createdAt: '', url: address, downloadUrl: address });
  const load = overlayLoader(env);
  const open = activeImageEditor(src);
  if (open) {
    const applied = await open.engine.batch('Assistant edit', () => applyImageOps(open.engine, ops, undefined, load)).catch(fixable).finally(() => open.refresh());
    const shown = await open.exportBlob();
    const image = await attach(asFile(src, shown.type, shown.size), await shown.arrayBuffer()).catch(() => 'Not attached.');
    return JSON.stringify({ edited: true, image_address: src, applied, size: open.engine.getOutputSize(), saved: false, note: 'Done in the image editor the user has open on this picture, as one undo step. It goes into the file when the user saves there; tell them so.', image });
  }
  if (!env.readImage || !env.uploadImage || !env.openImageEngine) throw new ToolError('Pictures cannot be edited here.');
  const data = await env.readImage(src);
  if (!EDITABLE_IMAGE_TYPES.includes(data.type)) throw new ToolError('That picture cannot be edited: only PNG, JPEG and WebP pictures can.');
  const hidden = await env.openImageEngine(data);
  let result: Blob;
  let applied: string[];
  let size: { width: number; height: number } | null;
  try {
    applied = await applyImageOps(hidden.engine, ops, hidden.bake, load).catch(fixable);
    size = hidden.engine.getOutputSize();
    // Stored anew, so a picture whose background was removed can be a PNG whatever it was.
    result = await hidden.export(ops.some((op) => op.op === 'remove_background') ? 'image/png' : data.type);
  } finally {
    await hidden.close();
  }
  const address = await env.uploadImage(result);
  const image = await attach(asFile(address, result.type, result.size), await result.arrayBuffer()).catch(() => 'Not attached.');
  return JSON.stringify({
    edited: true,
    image_address: address,
    source_image: src,
    applied,
    size,
    saved: true,
    note: 'Stored as a new picture; nothing shows it yet. Put this address where the old one was: edit_elements (src) on a slide, replace_blocks (the picture’s block, as ![alt](address)) in a document, or set_cell_image in a cell. If its shape changed (a crop or a turn), give the element a box of the new shape.',
    image,
  });
}
