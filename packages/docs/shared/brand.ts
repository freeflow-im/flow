// The app's name: MCP Docs, on the web and as the desktop app. The ChatGPT plugin keeps the name it was
// submitted under (Universal Docs) until its review is done: plugin/plugin.json, its v1 tools and its app.

export const HOSTED_NAME = 'MCP Docs';
export const LOCAL_NAME = 'MCP Docs';

export const appName = (local: boolean): string => (local ? LOCAL_NAME : HOSTED_NAME);

/** In the front page drawn when the app is built (client/src/landingPrerender.tsx), where the server puts the app's
 * address before sending it (server/app.ts). */
export const ORIGIN_MARK = '__MCP_DOCS_ORIGIN__';
