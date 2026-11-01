// Load .env for local development, before any module reads process.env. Variables that are already set
// win, so in production (no .env) the deployment's variables are used as-is. Loaded here rather than with
// node --env-file because that flag puts `node --watch` into a restart loop when started through npm.
try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
