# email_members: the assistant and MCP agents email org members, with attachments

- `[server]` New Contacts tool `email_members` at `/mcp` (new consent group, scope `contacts:email`) and in the assistant, over `POST /v1/contacts/email`. Recipients are checked against the directory on the server: "me", a member's address or `member:<accountId>`; anyone else is refused and nothing is sent.
- `[server]` Sent from FreeFlow's address as "<name> via FreeFlow", Reply-To the sender. Attachments come inline (text or base64), as a Docs file (stored files as they are, docs/sheets/decks exported) or as a Chat file, each opened with the sender's own access. Limits: 10 recipients, 10 files, 18 MB, 50 recipients an hour.
- `[server]` The Worker's mail sender now passes `html`, the From display name, `reply_to` and attachments to Cloudflare (it dropped `html` and the name before, so community emails sent from the Worker lost their HTML).
- `[server]` The assistant's prompt no longer says it cannot send email at all; it points "email me this" to `email_members`.

## Feature

- **Ask the assistant to email it to you.** "Email me this report" now sends it to your inbox, with the file attached. The assistant and connected agents can also email other members of your organization, with Docs or Chat files attached. They can only email people in your organization, never outside addresses, and replies come back to you.
