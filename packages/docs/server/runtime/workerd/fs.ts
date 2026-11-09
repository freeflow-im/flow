// The synchronous `node:fs` the Docs code still imports. A hosted object has no local files, so what these answered at
// start-up (is there a built client? a landing page?) is "no". `createReadStream` names an R2 object, which the reply sends.
export const existsSync = (_file: string): boolean => false;
export function readFileSync(file: string, _enc?: unknown): never {
  throw Object.assign(new Error(`ENOENT: no local files on Workers, '${file}'`), { code: 'ENOENT' });
}
export const statSync = readFileSync as unknown as (file: string) => { size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean };
export const mkdirSync = (_d: string, _o?: unknown): void => {};
export const writeFileSync = (file: string, _d: unknown): void => { throw new Error(`no local files on Workers: ${file}`); };
export const readdirSync = (_d: string): string[] => [];
export const unlinkSync = (_f: string): void => {};
export const rmSync = (_f: string, _o?: unknown): void => {};
export const renameSync = (_a: string, _b: string): void => {};
export const openSync = readFileSync as unknown as (file: string, flags?: string) => number;
export const readSync = readFileSync as unknown as (fd: number, buf: Uint8Array, off: number, len: number, pos: number) => number;
export const closeSync = (_fd: number): void => {};

export class FileStream {
  constructor(readonly file: string, readonly opts: { start?: number; end?: number } = {}) {}
}
export const createReadStream = (file: string, opts?: { start?: number; end?: number }) => new FileStream(file, opts) as never;
export default { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync, renameSync, createReadStream };
