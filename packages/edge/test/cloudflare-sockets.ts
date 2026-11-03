// Stands in for `cloudflare:sockets` under vitest, which runs in Node. Only the Mail object (src/imap/object.ts) imports it,
// and its tests exercise the pure parts; test/e2e-mail.mjs talks to real servers through wrangler dev.
export function connect(): never {
  throw new Error('cloudflare:sockets is not available under vitest');
}
