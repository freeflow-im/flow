// Object storage for the off-box copy of every file (see backup.ts): Cloudflare R2 through its S3 API, or an
// in-memory store for tests. R2 is configured with R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
// CLOUDFLARE_ACCOUNT_ID (R2_ENDPOINT overrides the endpoint derived from the account id); with none of
// them set there is no object store and the app behaves as before.
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  /** The object's bytes, or null when there is no such key. */
  get(key: string): Promise<Buffer | null>;
  /** Every object under a prefix (all pages). */
  list(prefix: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
}

export interface R2Config {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

/** The R2 configuration from the environment, or null when R2 is not set up. */
export function r2FromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT || (env.CLOUDFLARE_ACCOUNT_ID ? `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  if (!bucket && !accessKeyId && !secretAccessKey) return null;
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error('R2 needs R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID (or R2_ENDPOINT)');
  }
  return { bucket, accessKeyId, secretAccessKey, endpoint };
}

export class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  private bucket: string;

  constructor(cfg: R2Config) {
    this.bucket = cfg.bucket;
    // R2 is S3-compatible; "auto" is the region it expects.
    this.client = new S3Client({ region: 'auto', endpoint: cfg.endpoint, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() ?? '' });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** An object store in memory, for tests. */
export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; contentType?: string; lastModified: string }>();
  /** Set to make every operation fail (to test retries). */
  failing = false;
  puts = 0;

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    if (this.failing) throw new Error('store unavailable');
    this.puts++;
    this.objects.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType, lastModified: new Date().toISOString() });
  }

  async get(key: string): Promise<Buffer | null> {
    if (this.failing) throw new Error('store unavailable');
    return this.objects.get(key)?.body ?? null;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    if (this.failing) throw new Error('store unavailable');
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    if (this.failing) throw new Error('store unavailable');
    this.objects.delete(key);
  }
}
