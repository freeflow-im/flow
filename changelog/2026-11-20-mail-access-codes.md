# Mail: sign-in codes found in new mail, with Copy code

- `[server]` New INBOX mail (last 24 h) is checked for a one-time code on the org's OpenAI key: Decisions API (`gpt-6-luna`) asks if there is one, a Responses call reads it out, and it is kept only if it is really in the mail (`imap/accessCode.ts`, `mail_access_codes`).
- `[web]` The mail reader shows the code in a card above the message with a Copy code button (copied without spaces or dashes).

## Feature

- **Copy sign-in codes in one click.** When a new email holds a sign-in or verification code, Mail shows the code above the message with a Copy code button. It needs an OpenAI key in your organization's assistant settings.
