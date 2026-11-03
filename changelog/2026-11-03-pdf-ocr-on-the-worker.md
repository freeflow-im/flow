# Scanned PDFs read with OCR on the Cloudflare Worker

- `[server]` Docs' PDF to Markdown on the Worker sends the pages pdf.js finds no text on to a Cloudflare Container
  (`packages/edge/containers/pdf-ocr`: LiteParse with Tesseract, as on Node); text pages stay on pdf.js.
- `[server]` If the container cannot be reached, busy or too slow, the user is told so and asked to try again; `wrangler deploy`
  builds its linux/amd64 image, which needs Containers (Workers Paid) on the account.

## Feature

- **Scanned PDFs become Markdown too.** Turning a scanned PDF into Markdown in Workspace reads its pages with OCR,
  including the scanned pages of a PDF that is partly text.
