# Mail: sending in the background, answering in the conversation

- `[web]` Send closes the composer at once; a toast says "Sending…", then "Message sent.", or "Could not send: …" with Open, which reopens the composer as it was.
- `[web]` Wide screens: Reply, Reply all and Forward (buttons and r / a / f) open a composer card under the message, Gmail style, with a menu to switch between them; narrow screens keep the dialog. `ComposeForm.tsx` is shared by both.
- `[web]` The invitation card shows Yes / Maybe / No at once with a "Replying…" toast, and reverts with the reason on failure.

## Feature

- **Messages send in the background.** Press Send and the composer closes right away; a note at the bottom says when the message is sent. If it could not be sent, Open brings it back exactly as you wrote it.
- **Reply right under the message.** On a wide screen, Reply, Reply all and Forward open under the message you are answering, as in Gmail. Switch between them from the arrow menu, click the recipients to change them, and keep reading the conversation above while you write.
- **Answering an invitation is instant.** Yes, Maybe or No shows on the invitation right away while your answer is sent; if it fails, it goes back and tells you why.
