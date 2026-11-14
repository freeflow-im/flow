# Side panel: drag Docs files into Mail; folders, search and the assistant pill fixed

- `[web]` Mail's assistant launcher pill shows again while the assistant is anchored (#825 had hidden it), and it and the floating panel sit over the whole window, side panel included.
- `[web]` The Docs side panel has Recent, Organization and My files, with folders to open and a path back up.
- `[web]` The Docs side panel's search works: the page sets the suite's selected organization itself (it has no suite bar), and it searches both Organization files and My files.

- `[web]` Drag a file from the Docs panel onto a message being written, an open conversation or a row of the list (a reply with it). It goes as a link, shared read only with the recipients on send, when every recipient is an organization member at the sender's domain; else as an attachment. The chip switches between the two.
- `[web]` One drag type for every app (`@flow/suite-bar` `flowRef`), with the panel also telling the host by message, for a browser that hides a frame's drag data.

## Feature

- **Drag files from Docs into an email.** Drag a file from the Docs tab onto the message you are writing, or onto an email to reply with it. Colleagues get a link to the file, shared with them; anyone else gets a copy attached. Click Link or Attachment on the file to change it.

- **Browse folders from Mail.** The Docs tab beside your mail now shows your Organization files and My files with their folders, and its search finds files in both.
