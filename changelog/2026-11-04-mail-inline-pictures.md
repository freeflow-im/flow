# Mail: pictures pasted into a message

- `[web]` The composer takes a picture from the clipboard and puts it in the message where the caret is (a picture node in the editor); when the message is sent, every picture the body shows from a data: URL or from one of the app's own attachment URLs — a pasted one, or the pictures of a quoted original or a draft, which were dropped before — becomes an inline part shown by cid.
- `[server]` `POST …/send` and drafts take `attachments[].contentId` (and `inline`): such a part is sent as a related inline part with that Content-ID, not as a file; a draft sent as it is keeps the inline pictures its HTML shows.

## Feature

- **Paste a picture into an email.** Copy a screenshot or an image and paste it into the message; it appears right there in the text and is sent inline, the way Gmail does it. Replies and forwards now keep the original's inline pictures too.
