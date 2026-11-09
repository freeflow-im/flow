import { Inert } from '../inert.ts';
// The desktop app's folder-backed stores stay in packages/docs. Hosted code only asks `instanceof`, which is always false.
export class LocalSheetStore { fileChanged(_r: string): void {} relOf(_u: string, _i: string): string | null { return null; } [k: string]: any }
export class LocalFileStore { [k: string]: any }
export class LocalFolders { [k: string]: any }
export class LocalFolder extends Inert {}
export const LISTED_EXTS: string[] = [];
export const listedKind = (_n: string): any => null;
export type FindByName = any;
