// Blobs in R2, through the binding, with signed addresses for direct upload and download through its S3 API.
import { AwsClient } from 'aws4fetch';

export interface PresignedUpload { url: string; headers: Record<string, string>; expiresAt?: string }
export interface StorageEnv {
  BLOBS: R2Bucket;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
}
let env: StorageEnv | null = null;
export const setStorageEnv = (e: StorageEnv) => { env = e; };

const TTL = 3600;
async function sign(key: string, method: string, headers: Record<string, string> = {}): Promise<string | null> {
  const e = env!;
  if (!e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY || !e.R2_ENDPOINT || !e.R2_BUCKET) return null;
  const client = new AwsClient({ accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const url = new URL(`${e.R2_ENDPOINT.replace(/\/$/, '')}/${e.R2_BUCKET}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(TTL));
  return (await client.sign(new Request(url, { method, headers }), { aws: { signQuery: true } })).url;
}

export const blobStore = () => ({
  async put(key: string, data: Uint8Array): Promise<void> { await env!.BLOBS.put(key, data); },
  async get(key: string): Promise<Buffer> {
    const o = await env!.BLOBS.get(key);
    if (!o) throw new Error(`blob not found: ${key}`);
    return Buffer.from(await o.arrayBuffer());
  },
  async delete(key: string): Promise<void> { await env!.BLOBS.delete(key); },
  async head(key: string): Promise<{ size: number } | null> {
    const o = await env!.BLOBS.head(key);
    return o ? { size: o.size } : null;
  },
  async presignPut(key: string, opts: { contentType: string; contentLength: number }): Promise<PresignedUpload | null> {
    const url = await sign(key, 'PUT');
    return url ? { url, headers: { 'content-type': opts.contentType } } : null;
  },
  async presignGet(key: string, _opts?: unknown): Promise<string | null> { return sign(key, 'GET'); },
});
