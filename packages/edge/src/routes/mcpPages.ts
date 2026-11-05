// The pages of the MCP endpoint's OAuth (routes/mcp.ts): consent with what the agent may use (Docs files, Mail, sending
// email, Calendar) and the choice of organization, the device code, and the errors. The ChatGPT plugin's pages
// (docs/plugin/server/oauth.ts), in FreeFlow's colours: plain, centred, neutral.
import { offeredGroups, type OfferedGroup } from '../directory/mcpOAuth';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Each checkbox: its title, and what it lets the agent do (for the scopes the client asked for). */
function groupText(g: OfferedGroup): { title: string; detail: string; warning?: string } {
  if (g.id === 'docs') {
    return g.scopes.includes('files:write')
      ? { title: 'Docs files', detail: 'Read, create, change, import, move and delete the documents, presentations, spreadsheets, PDFs and other files of the organization below: its Organization files and your own My files there.' }
      : { title: 'Docs files (read only)', detail: 'See and read the documents, presentations, spreadsheets, PDFs and other files of the organization below: its Organization files and your own My files there.' };
  }
  if (g.id === 'mail') {
    const write = g.scopes.includes('mail:write');
    return {
      title: write ? 'Mail: read, search, organise and draft' : 'Mail: read and search',
      detail: write
        ? 'Your own email accounts in FreeFlow Mail: search and read messages and attachments, mark, move, archive and move them to Trash, and write drafts for you to review. It cannot send them.'
        : 'Your own email accounts in FreeFlow Mail: search and read messages and attachments.',
    };
  }
  if (g.id === 'calendar') {
    return g.scopes.includes('calendar:write')
      ? { title: 'Calendar: see and change your events', detail: 'Your own calendars in FreeFlow Calendar: see your events and when you are free, create, move and delete events, invite people and answer invitations.' }
      : { title: 'Calendar: see your events', detail: 'Your own calendars in FreeFlow Calendar: see your events and when you are free.' };
  }
  return { title: 'Send email as you', detail: 'Send messages from your email accounts.', warning: 'It could send any email to anyone from your address, without asking you first. Only allow this for an agent you trust.' };
}

const POLICY_LINKS = '<p class="muted small"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></p>';

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fbfaf8;--card:#fff;--ink:#39342f;--soft:#635d56;--line:#e7e3db;--accent:#1a73e8;--accent-ink:#fff;--error:#c5221f;--pick:#f4f8fe}
@media (prefers-color-scheme:dark){:root{--bg:#1a1c20;--card:#23262b;--ink:#ece9e4;--soft:#a9a49c;--line:#3a3d43;--accent:#5b9cf2;--accent-ink:#10141a;--error:#f28b82;--pick:#26303d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:56px auto;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:12px}
@media (max-width:480px){main{margin:16px;padding:22px}}
.brand{font-weight:600;letter-spacing:.01em;color:var(--soft);margin:0 0 18px;font-size:13px;text-transform:uppercase}
h1{font-size:21px;font-weight:600;margin:0 0 10px}
p{margin:10px 0}.muted{color:var(--soft)}.small{font-size:13px}.error{color:var(--error)}
a{color:var(--accent)}
ul{padding-left:20px;margin:8px 0 14px}li{margin:4px 0}
fieldset{border:0;padding:0;margin:14px 0}legend{font-weight:600;padding:0;margin-bottom:6px}
.org{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer}
.org:has(input:checked){border-color:var(--accent);background:var(--pick)}
.org input{margin:0;accent-color:var(--accent)}
.pick{align-items:flex-start}.pick input{margin-top:3px}.pick strong{display:block;font-weight:600}.pick .small{display:block;margin-top:2px}
.warn{color:var(--error)}
label.field{display:block;margin:12px 0 4px;font-weight:600}
input[type=text]{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--card);color:inherit}
.btn{display:inline-block;padding:9px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit;font:inherit;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
form.single .btn.primary{width:100%;margin-top:14px}
</style></head><body><main><p class="brand">FreeFlow</p>${body}</main></body></html>`;
}

export interface ConsentView {
  pendingId: string;
  csrf: string;
  clientName: string;
  scopes: string[];
  email: string;
  device: { origin: string } | null;
  organizations: { id: string; name: string }[];
  preselect: string | null;
  error?: string;
}

export function consentPage(v: ConsentView): string {
  const name = escapeHtml(v.clientName);
  const groups = offeredGroups(v.scopes.join(' '));
  const picks = groups
    .map((g) => {
      const t = groupText(g);
      return `<label class="org pick"><input type="checkbox" name="grant_${g.id}" value="on"${g.checked ? ' checked' : ''}> <span><strong>${escapeHtml(t.title)}</strong><span class="muted small">${escapeHtml(t.detail)}</span>${t.warning ? `<span class="small warn">${escapeHtml(t.warning)}</span>` : ''}</span></label>`;
    })
    .join('');
  const mail = groups.some((g) => g.id !== 'docs');
  const docs = groups.some((g) => g.id === 'docs');
  const device = v.device
    ? `<p class="error">Only allow this if you started this sign-in yourself, from an agent you trust. The request came from ${escapeHtml(v.device.origin)}, and "${name}" is the name the agent gave itself.</p>`
    : '';
  if (!v.organizations.length) {
    return page('No organization', `<h1>No organization yet</h1><p class="muted">Signed in as <strong>${escapeHtml(v.email)}</strong>.</p><p>${name} works with the Docs files of an organization, and you are not in one yet. <a href="/">Create or join one</a>, then start again from your agent.</p>`);
  }
  const orgs = v.organizations
    .map((o) => `<label class="org"><input type="radio" name="org" value="${escapeHtml(o.id)}"${o.id === v.preselect ? ' checked' : ''} required> <span>${escapeHtml(o.name || 'Unnamed organization')}</span></label>`)
    .join('');
  return page(
    `Allow ${v.clientName}?`,
    `<h1>Allow ${name} to use your ${docs && mail ? 'Docs and Mail' : mail ? 'Mail' : 'Docs'}?</h1>
<p class="muted">Signed in as <strong>${escapeHtml(v.email)}</strong>.</p>
${device}
${v.error ? `<p class="error">${escapeHtml(v.error)}</p>` : ''}
<form method="post" action="/oauth/decision">
  <input type="hidden" name="p" value="${escapeHtml(v.pendingId)}">
  <input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
  <input type="hidden" name="scopes_form" value="1">
  <fieldset>
    <legend>${name} may use</legend>
    ${picks}
  </fieldset>
  <fieldset>
    <legend>Organization</legend>
    ${orgs}
    ${mail ? '<p class="muted small">Mail is your own, whichever organization you choose.</p>' : ''}
  </fieldset>
  <div class="row">
    <button class="btn" type="submit" name="allow" value="no" formnovalidate>Deny</button>
    <button class="btn primary" type="submit" name="allow" value="yes">Allow</button>
  </div>
</form>
<p class="muted small">It acts as you, and sees this account's email address. You can disconnect it in Docs, under Settings, Connect your agent.</p>
${POLICY_LINKS}`,
  );
}

/** Where the person enters the code an agent showed them. */
export function devicePage(error?: string): string {
  return page(
    'Connect an agent',
    `<h1>Connect an agent to FreeFlow Docs</h1>
<p class="muted">Enter the code your agent showed you.</p>
<p><strong>Only enter a code from an agent you started yourself.</strong> Whoever started it will be able to read and change your files.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/device" class="single">
  <label class="field" for="code">Code</label>
  <input type="text" id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required autofocus>
  <button class="btn primary" type="submit">Continue</button>
</form>
${POLICY_LINKS}`,
  );
}

export function deviceDonePage(allowed: boolean): string {
  return allowed
    ? page('Agent connected', '<h1>Agent connected</h1><p>You can close this page and go back to your agent.</p>')
    : page('Not connected', '<h1>Not connected</h1><p class="muted">You did not allow access, so the agent cannot use your files.</p>');
}

export function errorPage(message: string): string {
  return page('Sign-in problem', `<h1>Sign-in problem</h1><p class="error">${escapeHtml(message)}</p>`);
}
