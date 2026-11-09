// Where the package's own files are on Node: `content/` (the feature pages), the data directory's default.
import path from 'node:path';

/** The root of packages/docs. */
export const packageRoot = (): string => path.resolve(import.meta.dirname, '..', '..', '..');
/** A folder under `content/`, with a trailing slash, as a prefix for its files. */
export const contentDir = (name: string): string => `${path.join(packageRoot(), 'content', name)}/`;
