// Where the Docs code is (packages/docs, `@flow/docs`): beside this folder in a clone (the workspace link), and under
// `docs/` in the packaged app, where electron-builder puts it (package.json `build.files`) rather than under node_modules,
// because Node strips types from no file under node_modules and the Docs server runs from its TypeScript sources.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const packed = path.join(appRoot, 'docs');

/** The root of the Docs package: its `server/`, `shared/`, `dist/client`. */
export const docsRoot = existsSync(path.join(packed, 'package.json')) ? packed : path.dirname(createRequire(import.meta.url).resolve('@flow/docs/package.json'));
/** A file of the Docs package, as a path. */
export const docsFile = (...parts) => path.join(docsRoot, ...parts);
