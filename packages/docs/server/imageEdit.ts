// Editing a stored picture with an image-generation model (the assistant's edit_image). Claude cannot make
// images, so this goes to OpenAI's image model, with the user's own OpenAI key (Settings) or the server's
// OPENAI_API_KEY. The edit is stored as a new file; the original is never changed.
import OpenAI, { toFile } from 'openai';

/** A problem to tell the user about (no key, the model refused the request, ...). */
export class ImageEditError extends Error {}

export { EDITABLE_IMAGE_TYPES } from '../shared/types.ts';
export const MAX_EDIT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_EDIT_PROMPT_CHARS = 4000;

export interface ImageEditRequest {
  apiKey: string;
  image: Buffer;
  filename: string;
  type: string;
  prompt: string;
}

/** Returns the edited picture as PNG bytes. Tests pass a stub; the default asks OpenAI. */
export type ImageEditor = (req: ImageEditRequest) => Promise<Buffer>;

export const openaiImageEditor: ImageEditor = async ({ apiKey, image, filename, type, prompt }) => {
  try {
    const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 180_000 });
    const res = await client.images.edit({ model: process.env.IMAGE_EDIT_MODEL || 'gpt-image-2', image: await toFile(image, filename, { type }), prompt });
    const data = res.data?.[0]?.b64_json;
    if (!data) throw new ImageEditError('The image model returned no picture. Try again.');
    return Buffer.from(data, 'base64');
  } catch (e) {
    if (e instanceof ImageEditError) throw e;
    if (e instanceof OpenAI.AuthenticationError) throw new ImageEditError('OpenAI did not accept the API key used for image editing.');
    if (e instanceof OpenAI.RateLimitError) throw new ImageEditError('OpenAI is rate-limiting image edits for this key, or it is out of credit. Try again later.');
    // A refused prompt or an unusable picture: OpenAI's own words say why.
    if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.PermissionDeniedError || e instanceof OpenAI.NotFoundError) throw new ImageEditError(`The image model could not do this: ${e.message}`);
    throw new ImageEditError('The image could not be edited right now. Try again in a moment.');
  }
};

/** The name of the edited copy of a picture: "logo.jpg" becomes "logo-edited.png". */
export function editedImageName(filename: string): string {
  return `${filename.replace(/\.[a-z0-9]+$/i, '').replace(/-edited$/, '')}-edited.png`;
}

// Edits cost real money, so each user gets a bounded number an hour.
const EDIT_RATE = { max: 30, windowMs: 60 * 60_000 };
const editCalls = new Map<string, number[]>();

export function checkImageEditRate(userId: string): void {
  const now = Date.now();
  const recent = (editCalls.get(userId) ?? []).filter((t) => now - t < EDIT_RATE.windowMs);
  editCalls.set(userId, recent);
  if (recent.length >= EDIT_RATE.max) throw new ImageEditError(`Image edit limit reached (${EDIT_RATE.max} an hour). Try again later.`);
  recent.push(now);
}
