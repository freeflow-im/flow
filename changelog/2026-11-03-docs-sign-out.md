# Signing out of Docs works on Cloudflare

- `[edge]` `POST /api/auth/logout` is answered by the Worker, ahead of Docs' object: it ends the session in the directory and clears the `sid` cookie. Docs' object has no sessions, so its own sign-out did nothing.

## Fix

- **Sign out from Docs.** Signing out from the Docs page left you signed in; it now signs you out of Docs and Chat.
