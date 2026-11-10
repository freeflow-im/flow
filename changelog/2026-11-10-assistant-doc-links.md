# Assistant: a file it makes from Mail comes with its real link

- `[server]` In the suite, the results of create_doc, create_sheet, create_deck, import_file and save_mail_attachment_to_docs carry the file's page address (`/workspace/doc/<id>` and the like, from the suite's address table) and, outside Docs, tell the model to give that link; the prompt says never to write a Docs address of its own. The model had guessed `/docs/...`.

## Feature

- Ask the assistant in Mail to put a message in a document, and the link it gives you opens that document.
