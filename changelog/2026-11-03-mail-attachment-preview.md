# Mail: attachments open in a full-window preview

- `[web]` Mail's attachment chips open a Gmail-style overlay (name, size, type, Download, Save to Docs / Open in Docs, ← / →, Esc);
  pictures, video, audio and text in the browser, HTML as source or in a frame that runs nothing. Chips keep a download icon.
- `[server]` Docs previews (`POST /api/previews`, edge Docs object): Office, CSV, Markdown and PDF files converted by the importers,
  owner-only, out of the library, reused per attachment, expired after an hour (swept on use and by the object's alarm).
- `[server]` `POST /api/previews/mail`: the Worker reads the attachment from the caller's Mail object and hands it to Docs;
  Save to Docs imports it into the top of My files. `/workspace/preview/<id>` renders it read-only, framed by the suite only.
- `[qa]` `packages/edge/test/e2e-preview.mjs` against GreenMail.

## Feature

- **Preview attachments without downloading them.** Click an attachment in Mail to see it full-window: pictures, videos, PDFs,
  Word documents, spreadsheets, presentations, CSV, Markdown and text files. Step through a message's attachments with the arrow
  keys, and save any of them to Docs with one click.
