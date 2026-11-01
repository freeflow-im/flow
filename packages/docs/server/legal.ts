// The public pages a listing needs: the privacy policy, the terms of service and support. They are plain HTML
// from the server (not the React app), so a reviewer or a crawler without scripts reads them, signed in or not.

/** Who publishes the app, and where to write. */
const PUBLISHER = 'Supercog.ai';
const CONTACT = 'scottpersinger@gmail.com';
const UPDATED = 'October 11, 2026';

const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

const PRIVACY = `
<h1>Privacy Policy</h1>
<p class="updated">Last updated ${UPDATED}</p>
<p>MCP Docs is published by ${PUBLISHER} ("we"). It is an editor for documents, presentations, spreadsheets, Markdown files and pictures, used in a web browser at docs.freeflow.im and inside ChatGPT as the Universal Docs plugin (its name in ChatGPT). This policy says what we collect, why, and who else receives it.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your account.</strong> Your email address, and a password stored only as a salted hash. If you sign in with Google, we receive your email address from Google and no password.</li>
  <li><strong>Your files.</strong> The documents, presentations, spreadsheets, Markdown files, pictures, PDFs, web pages and videos you create, import or upload, with their titles, folders and the times they were created and changed.</li>
  <li><strong>Assistant conversations.</strong> The messages you send to the built-in assistant, its replies, and pictures you attach to them.</li>
  <li><strong>Settings.</strong> Your preferences and, if you add one, your own OpenAI API key, which is stored encrypted.</li>
  <li><strong>Technical records.</strong> Server logs of requests (time, address requested, result, browser type and IP address), kept to run and secure the service.</li>
</ul>
<p>We use one cookie, to keep you signed in. We do not use advertising or analytics trackers, and we do not sell personal data.</p>

<h2>How we use it</h2>
<p>To provide the service: to store and show your files, to make the edits you or an assistant ask for, to sign you in, to send account email (verification and password reset), and to keep the service working and secure. We do not use the contents of your files to train models.</p>

<h2>Universal Docs in ChatGPT</h2>
<p>When you connect the plugin, ChatGPT signs in to your MCP Docs account with your permission. When you ask ChatGPT to work with your files, the plugin's tools return what the request needs to ChatGPT: the titles and identifiers of your files, the contents of the file being read or edited (text, slides, cells), pictures you ask it to look at, where your cursor or selection is in the open file, and, when ChatGPT asks which account is connected, your email address. What ChatGPT does with that is governed by OpenAI's own terms and privacy policy. You can disconnect the plugin in ChatGPT at any time.</p>

<h2>Who else receives data</h2>
<ul>
  <li><strong>Hosting and storage:</strong> Amazon Web Services (servers and file storage) and Cloudflare (backups of files, and account email).</li>
  <li><strong>AI providers, when you use an assistant:</strong> Anthropic, or OpenAI if you choose an OpenAI model or ask for an AI image edit, receive your messages and the parts of your files needed to answer. OpenAI receives what the ChatGPT plugin returns, as described above.</li>
  <li><strong>Web search:</strong> when the built-in assistant searches the web, the search words go to Brave Search.</li>
  <li><strong>Google:</strong> if you sign in with Google, and for the fonts the editors load.</li>
  <li><strong>IMG.LY:</strong> the background-removal model is downloaded to your browser from their servers; the picture itself is processed in your browser and is not sent to them.</li>
  <li><strong>Addresses you give us:</strong> when you ask for a file or picture to be imported from a web address, our server fetches that address.</li>
</ul>
<p>We may also disclose information when the law requires it.</p>

<h2>Keeping and deleting</h2>
<p>We keep your files and account until you delete them. A deleted file can be restored from the Trash for 30 days; after that it is removed for good, and our database backups that still mention it expire within a further 30 days. To delete your account and everything in it, or to get a copy of your data (the app also has an "Export all" download), write to ${mail}; we act on requests within 30 days.</p>

<h2>Security</h2>
<p>Connections are encrypted (HTTPS), passwords are hashed, API keys you store are encrypted, and each account's files are only served to that account. No service can promise perfect security; tell us at once if you believe your account was accessed by someone else.</p>

<h2>Children</h2>
<p>MCP Docs is not directed to children under 13, and we do not knowingly collect their personal data.</p>

<h2>Changes and contact</h2>
<p>If this policy changes we will post the new version here with its date. Questions and requests: ${mail}.</p>
`;

const TERMS = `
<h1>Terms of Service</h1>
<p class="updated">Last updated ${UPDATED}</p>
<p>These terms are an agreement between you and ${PUBLISHER} ("we") for the use of MCP Docs, in a web browser at docs.freeflow.im and as the Universal Docs plugin in ChatGPT. By creating an account or using the service you accept them.</p>

<h2>Your account</h2>
<p>You need an account, with an email address that is yours. Keep your password to yourself; you are responsible for what is done with your account. You must be at least 13 years old.</p>

<h2>Your content</h2>
<p>Your files are yours. You give us permission to store, copy and process them only as needed to run the service for you, including sending the parts an assistant needs to the AI provider that answers (see the <a href="/privacy">Privacy Policy</a>). You are responsible for having the right to the content you put in the service.</p>

<h2>Acceptable use</h2>
<p>Do not use the service to break the law, to store or share content that is unlawful or infringes someone else's rights, to send spam or malware, to attack or overload the service or other systems, or to try to reach another person's account or files.</p>

<h2>AI features</h2>
<p>The built-in assistant and the ChatGPT plugin change your files at your request. AI output can be wrong; check it before you rely on it. Edits made by an assistant can be undone in the editor, and you remain responsible for the contents of your files.</p>

<h2>Other services</h2>
<p>The service works with others (ChatGPT and OpenAI, Anthropic, Google sign-in). Your use of those is under their own terms.</p>

<h2>Availability and changes</h2>
<p>We work to keep the service available and your files safe, and we keep backups, but the service is provided "as is", without warranties of any kind. We may change or stop features, and we will give reasonable notice before ending the service so you can export your files.</p>

<h2>Ending</h2>
<p>You may stop using the service and ask for your account to be deleted at any time. We may suspend or close an account that breaks these terms.</p>

<h2>Liability</h2>
<p>To the extent the law allows, we are not liable for indirect or consequential losses, or for loss of data or profits, arising from the use of the service, and our total liability is limited to the amount you paid us for the service in the twelve months before the claim.</p>

<h2>Changes to these terms and contact</h2>
<p>If these terms change we will post the new version here with its date; continuing to use the service after that means you accept it. Questions: ${mail}.</p>
`;

const SUPPORT = `
<h1>Support</h1>
<p>MCP Docs is published by ${PUBLISHER}. For help, a problem to report, or a request about your account or data, write to ${mail}. We answer within two business days.</p>

<h2>When you write</h2>
<p>Say what you were doing, what you expected and what happened. The name of the file and whether you were in the web app or in ChatGPT help us find the problem quickly.</p>

<h2>Common questions</h2>
<ul>
  <li><strong>Getting started.</strong> The home page of the <a href="/">app</a> has a "Getting started" tour.</li>
  <li><strong>Universal Docs in ChatGPT.</strong> Add the Universal Docs plugin in ChatGPT and sign in with your account. Open a file by asking for it by name, or attach a file and ask ChatGPT to import it.</li>
  <li><strong>A change I did not want.</strong> Undo in the editor reverses an assistant's edit as it does your own.</li>
  <li><strong>Getting my files out.</strong> Every file can be downloaded from its File menu, and "Export all" on the home page downloads everything.</li>
  <li><strong>Deleting my account.</strong> Write to ${mail} from the account's email address.</li>
</ul>
<p>See also the <a href="/privacy">Privacy Policy</a> and the <a href="/terms">Terms of Service</a>.</p>
`;

const PAGES: Record<string, { title: string; body: string }> = {
  '/privacy': { title: 'Privacy Policy', body: PRIVACY },
  '/terms': { title: 'Terms of Service', body: TERMS },
  '/support': { title: 'Support', body: SUPPORT },
};

export const LEGAL_PATHS = Object.keys(PAGES);

const STYLE = `
  body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #202124; background: #fff; }
  header, main, footer { max-width: 720px; margin: 0 auto; padding: 0 20px; }
  header { padding-top: 24px; font-weight: 600; }
  header a { color: inherit; text-decoration: none; }
  h1 { font-size: 28px; margin: 24px 0 4px; }
  h2 { font-size: 18px; margin: 28px 0 6px; }
  p, ul { margin: 8px 0; }
  li { margin: 4px 0; }
  a { color: #1a73e8; }
  .updated { color: #5f6368; font-size: 14px; }
  footer { padding: 32px 20px 48px; color: #5f6368; font-size: 14px; }
  footer a { margin-right: 16px; }
`;

/** The whole page for one of the paths, or null for any other. */
export function legalPage(path: string): string | null {
  const page = PAGES[path];
  if (!page) return null;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.title} - MCP Docs</title><style>${STYLE}</style></head>
<body><header><a href="/">MCP Docs</a></header><main>${page.body}</main><footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a><span>${PUBLISHER}</span></footer></body></html>
`;
}
