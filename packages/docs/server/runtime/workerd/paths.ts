// The package's own files on Workers: there are none (runtime/fs.ts answers "no" for every file), so the paths only
// need to be strings.
export const packageRoot = (): string => '/';
export const contentDir = (name: string): string => `/content/${name}/`;
