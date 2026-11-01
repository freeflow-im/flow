import { DEVICE_ACCESS_TTL_MS, DEVICE_GRANT, REFRESH_TTL_MS } from '../plugin/server/oauth.ts';
import { featurePages } from './marketing.ts';

// /llms.txt: what the app is and how an agent connects to it, as Markdown. The site itself is a single-page
// app, so an agent that fetches it without running scripts sees nothing; this is the page it can read.

/** The file for this origin. `mcp` is whether the plugin's MCP server is mounted here (and so worth describing). */
export function llmsTxt(origin: string, mcp: boolean): string {
  const days = (ms: number) => Math.round(ms / (24 * 60 * 60 * 1000));
  const about = `# MCP Docs

> MCP Docs is an editor for Word, PowerPoint and Excel files, PDFs, Markdown, CSV and pictures, with a built-in AI assistant and an MCP server so agents can work on the same files. It is a free, open-source desktop app for macOS and Windows (\`npx @freeflow-im/mcp-docs\` installs it and adds it to Claude Code and Codex), and a web app in beta.

The web app is at ${origin}. It is a single-page app whose pages need a browser; this file and the feature pages below are Markdown to read instead.
${features(origin)}`;
  if (!mcp) return `${about}\n## Links\n\n- [Support](${origin}/support)\n- [Privacy Policy](${origin}/privacy)\n- [Terms of Service](${origin}/terms)\n`;
  return `${about}
## MCP server

MCP Docs has a remote MCP server, so an agent can read and edit the files in a person's account.

- Endpoint: \`${origin}/mcp/v2\` (streamable HTTP)
- Sign-in: OAuth 2.1. The person signs in to their own MCP Docs account and allows the agent; there are no API keys.
- Scopes: \`files:read\`, \`files:write\`
- Discovery: \`${origin}/.well-known/oauth-protected-resource/mcp/v2\` and \`${origin}/.well-known/oauth-authorization-server\`

### Connect with a browser on the same machine

Any MCP client that supports remote servers with OAuth can use the endpoint directly. In Claude Code:

\`\`\`sh
claude mcp add --transport http universal-docs ${origin}/mcp/v2
\`\`\`

The client opens a browser for the sign-in (authorization code flow with PKCE; dynamic client registration and client ID metadata documents are both supported).

### Connect without a browser (remote or headless agents)

The server supports the OAuth device authorization grant (RFC 8628). With [mcp-remote](https://github.com/punkpeye/mcp-remote):

\`\`\`sh
npx -y mcp-remote ${origin}/mcp/v2 --device-code
\`\`\`

Run that once in a terminal. It prints the address ${origin}/oauth/device and a short code. The person opens the address in any browser, on any machine, enters the code, signs in and allows the agent. The tokens are then saved, and later runs need no one. As a stdio server in an MCP client's configuration:

\`\`\`json
{ "command": "npx", "args": ["-y", "mcp-remote", "${origin}/mcp/v2", "--device-code"] }
\`\`\`

Do the first sign-in in a terminal before starting the client: a client that launches the command itself usually hides the code and gives up before anyone can enter it. The person can see and disconnect these agents under Settings in the app.

### Connect by hand, over HTTP

An agent that makes the HTTP requests itself (with curl, say) signs in like this. All the token requests are forms (\`application/x-www-form-urlencoded\`).

1. Register once: POST \`${origin}/oauth/register\` with JSON \`{"client_name": "<your name>", "grant_types": ["${DEVICE_GRANT}", "refresh_token"], "token_endpoint_auth_method": "none"}\`. Keep the \`client_id\` it returns.
2. Ask for a code: POST \`${origin}/oauth/device_authorization\` with \`client_id\` and \`resource=${origin}/mcp/v2\`. It returns \`device_code\`, \`user_code\`, \`verification_uri\` and \`interval\`.
3. Show the person the \`verification_uri\` and the \`user_code\`, and poll: POST \`${origin}/oauth/token\` with \`grant_type=${DEVICE_GRANT}\`, \`device_code\` and \`client_id\`, every \`interval\` seconds. \`authorization_pending\` means keep polling; \`slow_down\` means wait 5 seconds longer between polls from then on.
4. Once the person allows it, the response has an \`access_token\` (good for ${days(DEVICE_ACCESS_TTL_MS)} days) and a \`refresh_token\` (good for ${days(REFRESH_TTL_MS)} days). **Save both, and the \`client_id\`, somewhere that outlasts the session** (a file, not a variable): they are what lets you come back without asking the person again.
5. Call the MCP endpoint: POST \`${origin}/mcp/v2\` with \`Authorization: Bearer <access_token>\`, \`Content-Type: application/json\`, \`Accept: application/json, text/event-stream\` and a JSON-RPC body (\`tools/list\`, \`tools/call\`).

**Do not ask the person for a new code when the access token expires. Refresh instead.** When a request is refused with 401 (its \`reason\` says \`expired\`), or before \`expires_in\` runs out:

\`\`\`sh
curl -sS -X POST ${origin}/oauth/token -d grant_type=refresh_token -d refresh_token=<refresh_token> -d client_id=<client_id>
\`\`\`

That returns a new \`access_token\` and a new \`refresh_token\`. Replace the saved ones with them: each refresh token works once, and sending an old one again signs the agent out. Every refresh gives another ${days(REFRESH_TTL_MS)} days. Ask for a new code only if the refresh itself fails with \`invalid_grant\`. A 401 from the endpoint always says why, in \`reason\` and \`error_description\`.

### What the tools do

- Files: list, open, create, rename, delete and import (from a web address) documents, Markdown files, spreadsheets, presentations and stored files.
- Local files: \`upload_file\` returns a one-time address; POST the file's bytes to it (\`curl --data-binary @file <address>\`). Use it for files on the agent's own disk.
- Folders: \`list_files\` shows each file's folder and the folders there are; \`create_folder\` and \`move_file\` organize them, and \`upload_file\` can upload into one.
- Documents and Markdown: read as numbered blocks; insert, replace and delete blocks; replace text; format text and blocks; page setup.
- Spreadsheets: read and write ranges (formulas included), insert and delete rows and columns, sort, filter, format, freeze panes, tabs.
- Presentations: read a deck, add, update, move and delete slides, edit elements, set the theme.
- Stored files: read a file as it is, read its text, view and transform pictures.

Read before editing (\`read_doc\`, \`read_deck\`, \`get_sheet_overview\`): block and slide numbers change after inserts and deletes.

## Links

- [Support](${origin}/support)
- [Privacy Policy](${origin}/privacy)
- [Terms of Service](${origin}/terms)
`;
}

/** The feature pages, each as Markdown. */
function features(origin: string): string {
  const pages = featurePages();
  if (!pages.length) return '';
  return `\n## Features\n\n${pages.map((p) => `- [${p.h1}](${origin}/features/${p.slug}.md): ${p.description}`).join('\n')}\n`;
}
