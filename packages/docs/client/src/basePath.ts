// Where the app's pages live. Standalone (the hosted MCP Docs app, the desktop app) that is the root; in the
// FreeFlow suite the client is built with BASE_PATH=/workspace/ (vite.config.ts) and served there. The router
// takes the base as its basename, so routes and `navigate` are unchanged; only addresses that leave the router
// (a new tab, the browser's location) need it put in front.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** A page's address with the base in front: `appUrl('/doc/123')`. */
export const appUrl = (page: string): string => `${BASE}${page}`;
