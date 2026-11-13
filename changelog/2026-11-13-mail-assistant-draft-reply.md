# Mail assistant: replies open in the reply editor

- [web] New browser tool `draft_mail_reply`: in Mail the assistant writes a reply straight into the reply editor under the message (To, Cc, subject and quote filled in), not saved or sent. The Compose dialog on narrow screens.
- [server] Registered as a Mail browser tool and loaded up front on Mail pages; the prompt now uses `create_mail_draft` in Mail only for new emails, forwards, or when asked to save a draft.

## Feature

- Ask the assistant in Mail to reply to an email and the reply appears in the reply box under that email, ready for you to change and send.
