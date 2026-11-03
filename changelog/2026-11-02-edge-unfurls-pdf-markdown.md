# Link previews and PDF to Markdown work on the Cloudflare Worker

- `[server]` Unfurls run in the organization's Durable Object on the Workers `fetch`: timeouts, byte caps, redirects checked hop by hop, URL-level SSRF checks, the org's SQLite cache, `message.updated` over the socket. Preview images are stored as fetched (no sharp on Workers).
- `[server]` Fix: queued unfurl jobs run in their own organization's context; a job started by another org's job finishing could have written to the wrong org.
- `[server]` Docs' PDF to Markdown uses pdf.js in the Worker in place of LiteParse: headings, lists, links, no running headers. Scanned pages get a clear "needs OCR" message; OCR is not available on the Worker.
- `[qa]` `test/e2e.mjs` asserts a preview (with its picture) arrives for a link to a local page (run wrangler with `--var FLOW_UNFURL_ALLOW_HOSTS:localhost`); `test/e2e-docs.mjs` converts a text PDF and refuses a scan.

## Feature

- **Link previews are back.** A link in a message gets its preview card again, with its picture.
- **PDF to Markdown works again for text PDFs.** Scanned PDFs cannot be read for now, and say so.
