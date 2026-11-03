// The part of sharp that the services copied from packages/server use (files.ts thumbnails, workspaces.ts avatars), on
// Cloudflare Images (images.ts). sharp is native and cannot load on Workers. Without the binding, or when it fails, the
// image passes through as it came and `metadata()` knows no size: what these services did before the binding.
import { imageInfo, toWebp } from './images';

type Fit = 'inside' | 'cover' | 'contain' | 'fill' | 'outside';
interface Resize { width?: number; height?: number; fit?: Fit; withoutEnlargement?: boolean }

class Sharp {
  private size: Resize | null = null;
  private quality = 80;
  constructor(private readonly data: Uint8Array) {}
  resize(opts: Resize) { this.size = opts; return this; }
  webp(opts?: { quality?: number }) { this.quality = opts?.quality ?? 80; return this; }
  async toBuffer(): Promise<Buffer> {
    const s = this.size;
    const fit = s?.fit === 'cover' ? 'cover' : s?.fit === 'fill' ? 'squeeze' : s?.withoutEnlargement ? 'scale-down' : 'contain';
    const out = await toWebp(this.data, s ? { width: s.width, height: s.height, fit } : {}, this.quality);
    return out?.bytes ?? Buffer.from(this.data);
  }
  async metadata(): Promise<{ width?: number; height?: number; format?: string }> {
    return (await imageInfo(this.data)) ?? {};
  }
}
export default function sharp(data: Uint8Array, _opts?: { animated?: boolean }) { return new Sharp(data); }
