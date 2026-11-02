// Images are stored as they arrive until Cloudflare Images does the resizing: sharp is native and cannot load on Workers.
class Pass {
  constructor(private readonly data: Uint8Array) {}
  resize(..._a: unknown[]) { return this; }
  rotate(..._a: unknown[]) { return this; }
  webp(..._a: unknown[]) { return this; }
  png(..._a: unknown[]) { return this; }
  jpeg(..._a: unknown[]) { return this; }
  async toBuffer() { return Buffer.from(this.data); }
  async metadata() { return {} as { width?: number; height?: number; format?: string }; }
}
export default function sharp(data: Uint8Array, _opts?: unknown) { return new Pass(data); }
