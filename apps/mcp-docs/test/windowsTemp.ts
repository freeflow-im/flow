// On Windows a file that is still open cannot be deleted, and some tests remove their temporary folder while a store
// they made still holds a database or file in it. There, a temporary folder that cannot be removed yet is left for
// the machine to clear, instead of failing the test. Elsewhere this does nothing.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') {
  const temp = path.resolve(tmpdir()).toLowerCase();
  const leftAlone = (target: fs.PathLike, err: unknown) =>
    ['EBUSY', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '') && path.resolve(String(target)).toLowerCase().startsWith(temp + path.sep);
  const rmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    try {
      rmSync(target, options);
    } catch (err) {
      if (!leftAlone(target, err)) throw err;
    }
  };
  const rm = fs.promises.rm;
  fs.promises.rm = async (target, options) => {
    try {
      await rm(target, options);
    } catch (err) {
      if (!leftAlone(target, err)) throw err;
    }
  };
  syncBuiltinESMExports();
}
